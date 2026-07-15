import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  handleHostedOAuthRequest,
  hostedMcpUnauthorizedResponse,
  pkceS256,
  resolveBearerOwner,
  sameResource,
} from "../src/hosted/oauth.js";

const ORIGIN = "https://suminar.example";

describe("hosted OAuth pure logic", () => {
  it("advertises authorization-server metadata with origin-derived endpoints", async () => {
    const response = await handleHostedOAuthRequest(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), {} as NodeJS.ProcessEnv);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
    });
  });

  it("advertises the protected resource as the MCP endpoint", async () => {
    const response = await handleHostedOAuthRequest(new Request(`${ORIGIN}/.well-known/oauth-protected-resource`), {} as NodeJS.ProcessEnv);
    const body = await response.json();
    expect(body).toMatchObject({ resource: `${ORIGIN}/mcp`, authorization_servers: [ORIGIN] });
  });

  it("computes PKCE S256 as base64url sha256 of the verifier", () => {
    const verifier = "a-test-code-verifier-value-1234567890";
    const expected = createHash("sha256").update(verifier, "utf8").digest("base64url");
    expect(pkceS256(verifier)).toBe(expected);
  });

  it("normalizes resources so trailing slashes and case do not matter", () => {
    expect(sameResource("https://suminar.example/mcp", "https://SUMINAR.example/mcp/")).toBe(true);
    expect(sameResource("https://suminar.example/mcp", "https://other.example/mcp")).toBe(false);
  });

  it("rejects client registration without a valid redirect URI (before any DB call)", async () => {
    const response = await handleHostedOAuthRequest(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["ftp://nope"] }),
    }), { SUPABASE_URL: ORIGIN, SUPABASE_SERVICE_ROLE_KEY: "test" } as unknown as NodeJS.ProcessEnv);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe("invalid_redirect_uri");
  });

  it("returns a 401 with resource metadata when the MCP bearer is absent", () => {
    const response = hostedMcpUnauthorizedResponse(new Request(`${ORIGIN}/mcp`));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource");
  });

  it("resolves no owner when the request carries no bearer token", async () => {
    const owner = await resolveBearerOwner(new Request(`${ORIGIN}/mcp`), { SUPABASE_URL: ORIGIN, SUPABASE_SERVICE_ROLE_KEY: "test" } as unknown as NodeJS.ProcessEnv);
    expect(owner).toBeNull();
  });
});
