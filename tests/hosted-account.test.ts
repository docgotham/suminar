import { describe, expect, it } from "vitest";
import { handleHostedAccountRequest, validateSignupInput, validateTokenName } from "../src/hosted/account.js";

describe("signup validation", () => {
  it("accepts a complete signup and normalizes the email", () => {
    const result = validateSignupInput({ inviteCode: "smn_inv_abcdef012345", email: "  Reader@University.EDU ", password: "long-enough-pw" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.input.email).toBe("reader@university.edu");
      expect(result.input.displayName).toBeUndefined();
    }
  });

  it("rejects missing or malformed fields with client-actionable messages", () => {
    for (const [body, needle] of [
      [null, "JSON body"],
      [{ email: "a@b.co", password: "long-enough-pw" }, "invite code"],
      [{ inviteCode: "short", email: "a@b.co", password: "long-enough-pw" }, "invite code"],
      [{ inviteCode: "smn_inv_abcdef012345", email: "not-an-email", password: "long-enough-pw" }, "email"],
      [{ inviteCode: "smn_inv_abcdef012345", email: "a@b.co", password: "short" }, "8 to 200"],
    ] as const) {
      const result = validateSignupInput(body);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.message.toLowerCase()).toContain((needle as string).toLowerCase());
    }
  });

  it("keeps a supplied display name and trims it", () => {
    const result = validateSignupInput({ inviteCode: "smn_inv_abcdef012345", email: "a@b.co", password: "long-enough-pw", displayName: "  Dave  " });
    expect(result.ok && result.input.displayName).toBe("Dave");
  });
});

describe("token name validation", () => {
  it("defaults, trims, and caps the length", () => {
    expect(validateTokenName(undefined)).toBe("Connector token");
    expect(validateTokenName("   ")).toBe("Connector token");
    expect(validateTokenName("  Claude Desktop ")).toBe("Claude Desktop");
    expect(validateTokenName("x".repeat(300))).toHaveLength(120);
  });
});

describe("account handler shape", () => {
  it("answers OPTIONS with CORS preflight and no body", async () => {
    const response = await handleHostedAccountRequest(new Request("http://local/api/account/tokens", { method: "OPTIONS" }), {} as NodeJS.ProcessEnv);
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toContain("DELETE");
  });

  it("refuses to run unconfigured rather than half-authenticating", async () => {
    const response = await handleHostedAccountRequest(new Request("http://local/api/account/tokens"), {} as NodeJS.ProcessEnv);
    expect(response.status).toBe(500);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("server_error");
  });
});

// Password auth surface: the security-relevant response shapes, pinned
// offline against an unreachable Supabase (rate limiter fails open; the
// credential check fails closed to null).
describe("password sign-in and change-password shapes", () => {
  const FAKE_ENV = { SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "test" } as unknown as NodeJS.ProcessEnv;

  it("session minting validates the body before touching credentials", async () => {
    const response = await handleHostedAccountRequest(new Request("http://local/api/account/session", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    }), FAKE_ENV);
    expect(response.status).toBe(400);
    const body = await response.json() as { error_description: string };
    expect(body.error_description).toContain("Email and password");
  });

  it("bad credentials get one indistinct 401 — no account enumeration", async () => {
    const response = await handleHostedAccountRequest(new Request("http://local/api/account/session", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "nobody@example.com", password: "wrong-password" }),
    }), FAKE_ENV);
    expect(response.status).toBe(401);
    const body = await response.json() as { error_description: string };
    expect(body.error_description).toBe("Email or password not accepted.");
  });

  it("change-password sits behind the bearer wall", async () => {
    const response = await handleHostedAccountRequest(new Request("http://local/api/account/password", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ newPassword: "a-long-enough-password" }),
    }), FAKE_ENV);
    expect(response.status).toBe(401);
  });

  it("profile sits behind the bearer wall", async () => {
    const response = await handleHostedAccountRequest(new Request("http://local/api/account/profile"), FAKE_ENV);
    expect(response.status).toBe(401);
  });
});
