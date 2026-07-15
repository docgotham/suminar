import { describe, expect, it } from "vitest";
import { planClientRegistration } from "../src/hosted/oauth.js";

// Regression for a demonstrated production failure (2026-07-14): dynamic
// registration forced client_secret_post on every client, so a public
// (native/connector) client that registered as "none" and holds no secret
// exchanged its first code successfully, then earned a 401 on every hourly
// refresh — the session died at the one-hour mark. Registration must honor
// the requested auth method; PKCE is the public client's proof.
describe("client registration honors the requested auth method", () => {
  const redirect = { redirect_uris: ["http://127.0.0.1:4132/callback"] };

  it("registers a public client with no secret at all", () => {
    const plan = planClientRegistration({ ...redirect, client_name: "Native app", token_endpoint_auth_method: "none" });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.record.token_endpoint_auth_method).toBe("none");
    expect(plan.record.client_secret_hash).toBeNull();
    expect(plan.response.token_endpoint_auth_method).toBe("none");
    expect(plan.response).not.toHaveProperty("client_secret");
  });

  it("defaults to client_secret_post with a minted secret", () => {
    const plan = planClientRegistration(redirect);
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.record.token_endpoint_auth_method).toBe("client_secret_post");
    expect(typeof plan.response.client_secret).toBe("string");
    expect(plan.record.client_secret_hash).toMatch(/^[a-f0-9]{64}$/);
    // The stored hash never equals the plain secret.
    expect(plan.record.client_secret_hash).not.toBe(plan.response.client_secret);
  });

  it("coerces unknown auth methods to the confidential default", () => {
    const plan = planClientRegistration({ ...redirect, token_endpoint_auth_method: "private_key_jwt" });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.record.token_endpoint_auth_method).toBe("client_secret_post");
  });

  it("still rejects invalid redirect URIs", () => {
    const plan = planClientRegistration({ redirect_uris: ["ftp://nope"] });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.error).toBe("invalid_redirect_uri");
  });
});
