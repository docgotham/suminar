import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleHostedOAuthRequest, resolveBearerOwner } from "../src/hosted/oauth.js";

// Full OAuth round-trip against the live Suminar project: dynamic client
// registration, connector-token authorization, PKCE code exchange, and bearer
// resolution. Env-gated like the store live test; skipped without credentials.

const url = process.env.SUMINAR_TEST_SUPABASE_URL;
const serviceKey = process.env.SUMINAR_TEST_SUPABASE_SERVICE_ROLE_KEY;
const ORIGIN = "https://suminar-test.example";
const env = { SUPABASE_URL: url ?? "", SUPABASE_SERVICE_ROLE_KEY: serviceKey ?? "" } as unknown as NodeJS.ProcessEnv;

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe.skipIf(!url || !serviceKey)("hosted OAuth (live)", () => {
  const admin = createClient(url ?? "http://skipped.invalid", serviceKey ?? "skipped", { auth: { persistSession: false } });
  let ownerId = "";
  let connectorToken = "";

  beforeAll(async () => {
    const { data, error } = await admin.auth.admin.createUser({ email: `suminar-oauth-${randomBytes(6).toString("hex")}@example.com`, email_confirm: true });
    if (error) throw new Error(error.message);
    ownerId = data.user.id;
    connectorToken = `suminar_${randomBytes(24).toString("hex")}`;
    const insert = await admin.from("connector_tokens").insert({ owner_user_id: ownerId, name: "live test", token_hash: sha256(connectorToken) });
    if (insert.error) throw new Error(insert.error.message);
  });

  afterAll(async () => {
    if (ownerId) await admin.auth.admin.deleteUser(ownerId);
  });

  it("runs register → authorize(connector) → token → bearer resolution", async () => {
    // Dynamic client registration.
    const registration = await handleHostedOAuthRequest(new Request(`${ORIGIN}/oauth/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://localhost:8765/callback"], client_name: "Live Test Client" }),
    }), env);
    expect(registration.status).toBe(201);
    const client = await registration.json();

    // PKCE pair.
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier, "utf8").digest("base64url");
    const authParams = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "http://localhost:8765/callback",
      resource: `${ORIGIN}/mcp`,
      scope: "mcp",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "xyz",
    });

    // Authorize with the connector token; expect a 302 to the redirect with a code.
    const form = new URLSearchParams(authParams);
    form.set("auth_method", "connector_token");
    form.set("connector_token", connectorToken);
    const authorize = await handleHostedOAuthRequest(new Request(`${ORIGIN}/oauth/authorize`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    }), env);
    expect(authorize.status).toBe(302);
    const location = new URL(authorize.headers.get("location") ?? "");
    expect(location.searchParams.get("state")).toBe("xyz");
    const code = location.searchParams.get("code");
    expect(code).toBeTruthy();

    // Exchange the code (PKCE verifier) for tokens.
    const tokenForm = new URLSearchParams({
      grant_type: "authorization_code",
      code: code!,
      redirect_uri: "http://localhost:8765/callback",
      code_verifier: verifier,
      resource: `${ORIGIN}/mcp`,
      client_id: client.client_id,
      client_secret: client.client_secret,
    });
    const token = await handleHostedOAuthRequest(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenForm.toString(),
    }), env);
    expect(token.status).toBe(200);
    const tokenBody = await token.json();
    expect(tokenBody.access_token).toMatch(/^smn_oat_/);
    expect(tokenBody.refresh_token).toMatch(/^smn_ort_/);

    // The access token resolves to the owning account on the MCP resource.
    const owner = await resolveBearerOwner(new Request(`${ORIGIN}/mcp`, {
      headers: { authorization: `Bearer ${tokenBody.access_token}` },
    }), env);
    expect(owner).toBe(ownerId);

    // The raw connector token also resolves directly (power-user bearer).
    const directOwner = await resolveBearerOwner(new Request(`${ORIGIN}/mcp`, {
      headers: { authorization: `Bearer ${connectorToken}` },
    }), env);
    expect(directOwner).toBe(ownerId);

    // A reused authorization code is refused.
    const replay = await handleHostedOAuthRequest(new Request(`${ORIGIN}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: tokenForm.toString(),
    }), env);
    expect(replay.status).toBe(400);
  });
});
