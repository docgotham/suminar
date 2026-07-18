import { describe, expect, it } from "vitest";
import {
  checkHostedRateLimit,
  clientIpFromHeaders,
  hostedRateLimitRules,
  rateLimitedResponse,
} from "../src/hosted/ratelimit.js";

function rpcStub(result: { data: unknown; error: { message: string } | null } | Error) {
  return {
    rpc: async () => {
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

describe("hosted rate limiting", () => {
  it("fails open when the counter is unreachable", async () => {
    const rule = { name: "mcp", maxHits: 5, windowSeconds: 60 };
    for (const broken of [rpcStub(new Error("network down")), rpcStub({ data: null, error: { message: "boom" } }), rpcStub({ data: { nonsense: true }, error: null })]) {
      const decision = await checkHostedRateLimit(broken, rule, "subject");
      expect(decision.allowed).toBe(true);
    }
  });

  it("relays the counter's verdict when it answers", async () => {
    const rule = { name: "mcp", maxHits: 5, windowSeconds: 60 };
    const decision = await checkHostedRateLimit(
      rpcStub({ data: { allowed: false, remaining: 0, retryAfterSeconds: 42 }, error: null }),
      rule,
      "subject",
    );
    expect(decision).toEqual({ allowed: false, remaining: 0, retryAfterSeconds: 42 });
  });

  it("shapes a legible 429 with retry-after", async () => {
    const response = rateLimitedResponse({ allowed: false, remaining: 0, retryAfterSeconds: 42 }, "MCP");
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("42");
    const body = await response.json();
    expect(body.error).toBe("rate_limited");
    expect(body.error_description).toContain("Retry in 42 seconds");
  });

  it("prefers the platform-set client header over a spoofable x-forwarded-for", () => {
    // Vercel's header wins even when the caller injects its own leftmost XFF
    // hop — otherwise the per-IP gate is defeated by rotating a fake hop.
    expect(clientIpFromHeaders(new Headers({ "x-vercel-forwarded-for": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 203.0.113.9" }))).toBe("203.0.113.9");
    // x-real-ip (also platform-set) beats x-forwarded-for.
    expect(clientIpFromHeaders(new Headers({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "1.2.3.4" }))).toBe("203.0.113.7");
    // Falls back to the first XFF hop only when no trusted header is present.
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.9, 10.0.0.1" }))).toBe("203.0.113.9");
    // None of them: one shared bucket rather than skipping the limit.
    expect(clientIpFromHeaders(new Headers())).toBe("unknown");
  });

  it("reads overrides from SUMINAR_RATE_* env and keeps sane defaults", () => {
    const defaults = hostedRateLimitRules({} as NodeJS.ProcessEnv);
    expect(defaults.mcpPerAccount).toMatchObject({ maxHits: 120, windowSeconds: 60 });
    expect(defaults.waitlistPerIp).toMatchObject({ maxHits: 5, windowSeconds: 3600 });
    expect(defaults.identifyPerAccount).toMatchObject({ maxHits: 40, windowSeconds: 3600 });
    const tuned = hostedRateLimitRules({ SUMINAR_RATE_MCP_PER_MINUTE: "10", SUMINAR_RATE_UPLOADS_PER_HOUR: "junk", SUMINAR_RATE_IDENTIFY_PER_HOUR: "25" } as NodeJS.ProcessEnv);
    expect(tuned.mcpPerAccount.maxHits).toBe(10);
    expect(tuned.uploadPerAccount.maxHits).toBe(40);
    expect(tuned.identifyPerAccount.maxHits).toBe(25);
  });
});
