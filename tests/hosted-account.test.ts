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

// Password recovery is two unauthenticated, pre-gate doors: /recover (send the
// link) and /reset (consume the token_hash). The security-relevant shapes are
// pinned offline — Supabase is unreachable, so the GoTrue calls fail closed and
// the rate limiter fails open, exactly as in production degradation.
describe("password recovery shapes", () => {
  const FAKE_ENV = { SUPABASE_URL: "http://127.0.0.1:1", SUPABASE_SERVICE_ROLE_KEY: "test" } as unknown as NodeJS.ProcessEnv;
  const recover = (body: unknown) => handleHostedAccountRequest(new Request("http://local/api/account/recover", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), FAKE_ENV);
  const reset = (body: unknown) => handleHostedAccountRequest(new Request("http://local/api/account/reset", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), FAKE_ENV);

  it("recover rejects a malformed email before sending anything", async () => {
    const response = await recover({ email: "not-an-email" });
    expect(response.status).toBe(400);
    const body = await response.json() as { error_description: string };
    expect(body.error_description.toLowerCase()).toContain("valid email");
  });

  it("recover answers a valid address indistinctly — no account enumeration", async () => {
    const response = await recover({ email: "reader@example.com" });
    expect(response.status).toBe(200);
    const body = await response.json() as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message.toLowerCase()).toContain("on its way");
  });

  it("reset validates the new password before spending the token", async () => {
    const response = await reset({ tokenHash: "a".repeat(40), password: "short" });
    expect(response.status).toBe(400);
    const body = await response.json() as { error_description: string };
    expect(body.error_description).toContain("8 to 200");
  });

  it("reset rejects a malformed token as an invalid link", async () => {
    const response = await reset({ tokenHash: "nope", password: "a-long-enough-password" });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string; error_description: string };
    expect(body.error).toBe("invalid_token");
    expect(body.error_description.toLowerCase()).toContain("invalid or has expired");
  });

  it("reset fails closed when the token cannot be verified", async () => {
    // Well-formed token, valid password — but GoTrue is unreachable, so
    // verifyRecoveryToken returns null and the door stays shut.
    const response = await reset({ tokenHash: "a".repeat(40), password: "a-long-enough-password" });
    expect(response.status).toBe(400);
    const body = await response.json() as { error: string };
    expect(body.error).toBe("invalid_token");
  });
});
