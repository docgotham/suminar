import { createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { handleHostedAccountRequest } from "../src/hosted/account.js";

// Connected apps against the live Suminar project: list aggregation, expired-
// row invisibility, per-account isolation, complete revocation (tokens plus
// the in-flight code window), and the honest 404 on a second revoke. Env-gated
// like the OAuth live test; skipped without credentials.

const url = process.env.SUMINAR_TEST_SUPABASE_URL;
const serviceKey = process.env.SUMINAR_TEST_SUPABASE_SERVICE_ROLE_KEY;
const env = { SUPABASE_URL: url ?? "", SUPABASE_SERVICE_ROLE_KEY: serviceKey ?? "" } as unknown as NodeJS.ProcessEnv;
const ORIGIN = "https://suminar-test.example";

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

describe.skipIf(!url || !serviceKey)("connected apps (live)", () => {
  const admin = createClient(url ?? "http://skipped.invalid", serviceKey ?? "skipped", { auth: { persistSession: false } });
  let ownerId = "";
  let otherId = "";
  let bearer = "";
  const clientId = `smn_client_${randomBytes(9).toString("hex")}`;

  beforeAll(async () => {
    const owner = await admin.auth.admin.createUser({ email: `suminar-conn-${randomBytes(6).toString("hex")}@example.com`, email_confirm: true });
    if (owner.error) throw new Error(owner.error.message);
    ownerId = owner.data.user.id;
    const other = await admin.auth.admin.createUser({ email: `suminar-conn-${randomBytes(6).toString("hex")}@example.com`, email_confirm: true });
    if (other.error) throw new Error(other.error.message);
    otherId = other.data.user.id;

    // A connector-token bearer resolves to the owner, the same door power users
    // and tests use — no OAuth dance needed to reach the account endpoints.
    bearer = `suminar_${randomBytes(24).toString("hex")}`;
    const tok = await admin.from("connector_tokens").insert({ owner_user_id: ownerId, name: "conn live", token_hash: sha256(bearer) });
    if (tok.error) throw new Error(tok.error.message);

    // One shared client. Owner holds a live token and a refresh-expired one;
    // the other account holds its own live token; the owner has an unconsumed
    // in-flight authorization code.
    const cli = await admin.from("oauth_clients").insert({ client_id: clientId, client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
    if (cli.error) throw new Error(cli.error.message);
    const hour = 3_600_000, day = 86_400_000, now = Date.now();
    const row = (userId: string, access: number, refresh: number, tail: string) => ({
      token_hash: sha256(`at_${tail}`),
      refresh_token_hash: sha256(`rt_${tail}`),
      user_id: userId,
      client_id: clientId,
      resource: `${ORIGIN}/mcp`,
      scope: "mcp",
      access_expires_at: new Date(now + access).toISOString(),
      refresh_expires_at: new Date(now + refresh).toISOString(),
    });
    const tokens = await admin.from("oauth_access_tokens").insert([
      row(ownerId, hour, 30 * day, "owner-live"),
      row(ownerId, -2 * hour, -hour, "owner-expired"),
      row(otherId, hour, 30 * day, "other-live"),
    ]);
    if (tokens.error) throw new Error(tokens.error.message);
    const code = await admin.from("oauth_authorization_codes").insert({
      code_hash: sha256(`code_${randomBytes(4).toString("hex")}`),
      client_id: clientId,
      user_id: ownerId,
      redirect_uri: "https://claude.ai/api/mcp/auth_callback",
      resource: `${ORIGIN}/mcp`,
      code_challenge: "probe",
    });
    if (code.error) throw new Error(code.error.message);
  });

  afterAll(async () => {
    if (ownerId) await admin.auth.admin.deleteUser(ownerId);
    if (otherId) await admin.auth.admin.deleteUser(otherId);
    await admin.from("oauth_clients").delete().eq("client_id", clientId);
  });

  const account = (path: string, method = "GET") =>
    handleHostedAccountRequest(new Request(`${ORIGIN}${path}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      body: method === "POST" ? "{}" : undefined,
    }), env);

  it("lists one aggregated grant, hides the refresh-expired token, isolates other accounts", async () => {
    const res = await account("/api/account/connections");
    expect(res.status).toBe(200);
    const body = await res.json() as { connections: Array<{ clientId: string; clientName: string; activeTokens: number; redirectHosts: string[] }> };
    expect(body.connections).toHaveLength(1);
    expect(body.connections[0]).toMatchObject({ clientId, clientName: "Claude", activeTokens: 1 });
    expect(body.connections[0].redirectHosts).toEqual(["claude.ai"]);
  });

  it("revokes every live token AND the expired-unrevoked one, closes the code, then 404s honestly", async () => {
    const res = await account(`/api/account/connections/${encodeURIComponent(clientId)}/revoke`, "POST");
    expect(res.status).toBe(200);
    // Both of the owner's unrevoked rows die — the expired-but-unrevoked one
    // leaves no zombie residue — and the single in-flight code is closed.
    expect(await res.json()).toMatchObject({ revoked: true, revokedTokens: 2, closedCodes: 1 });

    const after = await account("/api/account/connections");
    expect((await after.json() as { connections: unknown[] }).connections).toHaveLength(0);

    const again = await account(`/api/account/connections/${encodeURIComponent(clientId)}/revoke`, "POST");
    expect(again.status).toBe(404);

    // The other account's grant is untouched by the owner's revoke.
    const others = await admin.from("oauth_access_tokens").select("token_hash").eq("user_id", otherId).is("revoked_at", null);
    expect(others.data ?? []).toHaveLength(1);
    const openCodes = await admin.from("oauth_authorization_codes").select("code_hash").eq("user_id", ownerId).is("consumed_at", null);
    expect(openCodes.data ?? []).toHaveLength(0);
  });
});
