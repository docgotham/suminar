import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createHostedOAuthClient, readHostedOAuthEnv, resolveBearerOwner } from "./oauth.js";
import { checkHostedRateLimit, hostedRateLimitRules, rateLimitedResponse } from "./ratelimit.js";

// The operator backend, content-blind by construction: every handler reads
// aggregates and account metadata (emails, counts, usage, invite status) and
// none can reach uploaded sources, derivatives, or conversation text. The
// database function admin_overview carries the same property, enforced by a
// migration-shape test. Operators authenticate like anyone else — a bearer
// resolved to an account — and the operators table decides whether the
// account may be here.

function json(payload: unknown, status = 200): Response {
  return withCors(new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8" } }));
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function isOperator(client: SupabaseClient, userId: string): Promise<boolean> {
  const { data, error } = await client.from("operators").select("user_id").eq("user_id", userId).maybeSingle();
  return !error && Boolean(data);
}

export async function handleHostedAdminRequest(request: Request, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
  const config = readHostedOAuthEnv(env);
  if (!config) return json({ error: "server_error", error_description: "Hosted Suminar is not configured" }, 500);
  const owner = await resolveBearerOwner(request, env);
  if (!owner) return json({ error: "unauthorized" }, 401);

  const client = createHostedOAuthClient(config);
  if (!(await isOperator(client, owner))) return json({ error: "forbidden", error_description: "Suminar operator access required" }, 403);

  const decision = await checkHostedRateLimit(client, hostedRateLimitRules(env).adminPerOperator, owner);
  if (!decision.allowed) return withCors(rateLimitedResponse(decision, "admin"));

  const segments = new URL(request.url).pathname.replace(/^\/+|\/+$/g, "").split("/");
  // segments: ["admin", ...rest]
  const resource = segments[1];
  const id = segments[2];
  const action = segments[3];

  if (request.method === "GET" && resource === "overview") return adminOverview(client, owner);
  if (request.method === "POST" && resource === "accounts" && !id) return provisionAccount(client, owner, request);
  if (request.method === "POST" && resource === "invites" && !id) return issueInvite(client, owner, request);
  if (request.method === "POST" && resource === "invites" && id && action === "revoke") return revokeInvite(client, owner, id);
  if (request.method === "POST" && resource === "waitlist" && id === "invited") return markWaitlistInvited(client, request);
  return json({ error: "not_found" }, 404);
}

export async function adminOverview(client: SupabaseClient, operator: string): Promise<Response> {
  const { data, error } = await client.rpc("admin_overview", { p_operator: operator });
  if (error) return json({ error: "server_error", error_description: error.message }, 500);
  return json(data);
}

// Provisions an invited account: creates the auth user, optionally issues a
// connector token (returned exactly once), and marks a matching waitlist
// entry invited. No email is sent — the operator hands the token to the
// person directly; self-serve signup arrives with the public site.
export async function provisionAccount(client: SupabaseClient, operator: string, request: Request): Promise<Response> {
  let body: { email?: string; displayName?: string; issueConnectorToken?: boolean };
  try { body = await request.json(); } catch { return json({ error: "invalid_request", error_description: "Expected a JSON body" }, 400); }
  const email = body.email?.trim().toLowerCase();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return json({ error: "invalid_request", error_description: "A valid email is required" }, 400);
  }

  const created = await client.auth.admin.createUser({ email, email_confirm: true });
  if (created.error || !created.data.user) {
    return json({ error: "server_error", error_description: created.error?.message ?? "Account creation failed" }, 400);
  }
  const userId = created.data.user.id;

  let connectorToken: string | undefined;
  if (body.issueConnectorToken !== false) {
    connectorToken = `suminar_${randomBytes(24).toString("hex")}`;
    const insert = await client.from("connector_tokens").insert({
      owner_user_id: userId,
      name: body.displayName?.trim() || "Provisioned by operator",
      token_hash: sha256Hex(connectorToken),
    });
    if (insert.error) {
      return json({ error: "server_error", error_description: `Account created, token failed: ${insert.error.message}`, userId }, 500);
    }
  }

  await client.from("waitlist").update({ invited_at: new Date().toISOString() }).eq("email", email).is("invited_at", null);
  return json({ userId, email, ...(connectorToken ? { connectorToken } : {}) }, 201);
}

// Issues an invite code for the operator (hash at rest; the code is returned
// exactly once). Friend codes issued by ordinary accounts go through the
// issue_invite_code RPC under their own session instead.
export async function issueInvite(client: SupabaseClient, operator: string, request: Request): Promise<Response> {
  let body: { note?: string; maxUses?: number; expiresInDays?: number };
  try { body = await request.json(); } catch { body = {}; }
  const maxUses = Math.min(Math.max(Math.trunc(body.maxUses ?? 1), 1), 100);
  const days = Math.min(Math.max(Math.trunc(body.expiresInDays ?? 30), 1), 365);
  const code = `smn_inv_${randomBytes(12).toString("hex")}`;

  const insert = await client.from("invite_codes").insert({
    code_hash: sha256Hex(code),
    issuer_user_id: operator,
    note: body.note?.trim() || null,
    max_uses: maxUses,
    expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
  }).select("id, expires_at").single();
  if (insert.error) {
    const status = insert.error.message.includes("Suminar pilot limit:") ? 400 : 500;
    return json({ error: status === 400 ? "pilot_limit" : "server_error", error_description: insert.error.message }, status);
  }
  return json({ inviteCodeId: insert.data.id, code, expiresAt: insert.data.expires_at, maxUses }, 201);
}

export async function revokeInvite(client: SupabaseClient, operator: string, inviteCodeId: string): Promise<Response> {
  const update = await client.from("invite_codes")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", inviteCodeId)
    .is("revoked_at", null)
    .select("id");
  if (update.error) return json({ error: "server_error", error_description: update.error.message }, 500);
  if (!update.data?.length) return json({ error: "not_found" }, 404);
  return json({ revoked: true, inviteCodeId });
}

export async function markWaitlistInvited(client: SupabaseClient, request: Request): Promise<Response> {
  let body: { email?: string };
  try { body = await request.json(); } catch { return json({ error: "invalid_request", error_description: "Expected a JSON body" }, 400); }
  const email = body.email?.trim().toLowerCase();
  if (!email) return json({ error: "invalid_request", error_description: "An email is required" }, 400);
  const update = await client.from("waitlist").update({ invited_at: new Date().toISOString() }).eq("email", email).select("email");
  if (update.error) return json({ error: "server_error", error_description: update.error.message }, 500);
  return json({ ok: true, known: Boolean(update.data?.length) });
}
