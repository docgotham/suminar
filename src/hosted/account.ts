import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createHostedOAuthClient,
  readHostedOAuthEnv,
  resolveBearerOwner,
  signInWithPassword,
  type HostedOAuthEnv,
} from "./oauth.js";
import { PILOT_LIMITS, isPilotLimitMessage } from "./limits.js";
import { handleCandidates, mlaCitationParts } from "../suminar/naming.js";
import { checkHostedRateLimit, clientIpFromHeaders, hostedRateLimitRules, rateLimitedResponse } from "./ratelimit.js";

// The self-serve account surface: invite redemption (signup), connector-token
// management, friend invites, and quota visibility. Authentication follows the
// hosted bearer model — a connector token or OAuth access token resolves to
// the owning account — with one addition: minting a connector token also
// accepts the account password, which is the lost-token recovery path. The
// service-role client bypasses RLS, so owner scoping on every query is the
// tenant wall, exactly as in documents.ts and admin.ts.

function json(payload: unknown, status = 200): Response {
  return withCors(new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8" } }));
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export interface SignupInput {
  inviteCode: string;
  email: string;
  password: string;
  displayName?: string;
}

// Pure validation so the contract is testable without IO. Password bounds are
// a floor, not a strength meter: GoTrue applies the project policy on top.
export function validateSignupInput(body: unknown): { ok: true; input: SignupInput } | { ok: false; message: string } {
  if (!body || typeof body !== "object") return { ok: false, message: "Expected a JSON body" };
  const raw = body as { inviteCode?: unknown; email?: unknown; password?: unknown; displayName?: unknown };
  const inviteCode = typeof raw.inviteCode === "string" ? raw.inviteCode.trim() : "";
  const email = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  const password = typeof raw.password === "string" ? raw.password : "";
  const displayName = typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName.trim() : undefined;
  if (inviteCode.length < 8 || inviteCode.length > 200) return { ok: false, message: "An invite code is required." };
  if (!EMAIL_PATTERN.test(email) || email.length > 320) return { ok: false, message: "A valid email is required." };
  if (password.length < 8 || password.length > 200) return { ok: false, message: "Passwords are 8 to 200 characters." };
  return { ok: true, input: { inviteCode, email, password, displayName } };
}

export function validateTokenName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  return name.length ? name.slice(0, 120) : "Connector token";
}

export async function handleHostedAccountRequest(request: Request, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
  const config = readHostedOAuthEnv(env);
  if (!config) return json({ error: "server_error", error_description: "Hosted Suminar is not configured" }, 500);
  const client = createHostedOAuthClient(config);

  const segments = new URL(request.url).pathname.replace(/^\/+|\/+$/g, "").split("/");
  // segments: ["api", "account", <resource>, <id>, <action>]
  const resource = segments[2];
  const id = segments[3];
  const action = segments[4];
  const rules = hostedRateLimitRules(env);

  if (request.method === "POST" && resource === "signup" && !id) {
    const decision = await checkHostedRateLimit(client, rules.signupPerIp, clientIpFromHeaders(request.headers));
    if (!decision.allowed) return withCors(rateLimitedResponse(decision, "signup"));
    return signup(request, client, config);
  }

  // Password sign-in as a first-class door: mints a short-lived web session
  // for the account pages. Per-IP gated ahead of any credential check, and
  // one indistinct failure message — wrong email and wrong password are the
  // same answer, so the endpoint enumerates nothing.
  if (request.method === "POST" && resource === "session" && !id) {
    const decision = await checkHostedRateLimit(client, rules.oauthTokenPerIp, clientIpFromHeaders(request.headers));
    if (!decision.allowed) return withCors(rateLimitedResponse(decision, "session"));
    const credentials = await request.json().catch(() => ({})) as Record<string, unknown>;
    const email = typeof credentials.email === "string" ? credentials.email.trim().toLowerCase() : "";
    const password = typeof credentials.password === "string" ? credentials.password : "";
    if (!email || !password) return json({ error: "invalid_request", error_description: "Email and password are required." }, 400);
    const signedIn = await signInWithPassword(config, email, password);
    if (!signedIn) return json({ error: "invalid_credentials", error_description: "Email or password not accepted." }, 401);
    const sessionToken = `smn_web_${randomBytes(24).toString("hex")}`;
    const inserted = await client.from("web_sessions")
      .insert({ session_hash: sha256Hex(sessionToken), user_id: signedIn })
      .select("expires_at")
      .single();
    if (inserted.error) return json({ error: "server_error", error_description: "Could not start a session." }, 500);
    return json({ sessionToken, expiresAt: inserted.data.expires_at }, 201);
  }

  // Everything else acts on an existing account. Bearer resolves it; minting
  // a token may alternatively present the account password (recovery).
  let body: Record<string, unknown> | null = null;
  if (request.method === "POST") body = await request.json().catch(() => ({})) as Record<string, unknown>;
  let owner = await resolveBearerOwner(request, env);
  if (!owner && request.method === "POST" && resource === "tokens" && !id
    && typeof body?.email === "string" && typeof body?.password === "string") {
    // A password verification with no bearer is an unauthenticated credential
    // check — gate it per-IP exactly like /session, or this door is an
    // unthrottled password oracle that also mints a durable connector token.
    const guard = await checkHostedRateLimit(client, rules.oauthTokenPerIp, clientIpFromHeaders(request.headers));
    if (!guard.allowed) return withCors(rateLimitedResponse(guard, "password"));
    owner = await signInWithPassword(config, (body.email as string).trim().toLowerCase(), body.password as string);
  }
  if (!owner) return json({ error: "unauthorized" }, 401);

  // The presenting web session's hash, when the bearer is one — lets
  // change-password spare the current tab while revoking the rest, and lets
  // sign-out revoke exactly this session.
  const bearer = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const currentSessionHash = bearer.startsWith("smn_web_") ? sha256Hex(bearer) : undefined;

  if (request.method === "POST" && resource === "signout" && !id) {
    if (currentSessionHash) {
      await client.from("web_sessions").update({ revoked_at: new Date().toISOString() })
        .eq("session_hash", currentSessionHash).is("revoked_at", null);
    }
    return json({ ok: true });
  }

  // Companion reads poll; they run on their own generous budget so the
  // account-operation allowance stays for operations.
  const gateRule = request.method === "GET" && resource === "seminars" ? rules.seminarsPerAccount : rules.accountPerOwner;
  const decision = await checkHostedRateLimit(client, gateRule, owner);
  if (!decision.allowed) return withCors(rateLimitedResponse(decision, gateRule.name));

  if (request.method === "GET" && resource === "tokens" && !id) return listTokens(client, owner);
  if (request.method === "POST" && resource === "tokens" && !id) return mintToken(client, owner, body ?? {});
  if (request.method === "DELETE" && resource === "tokens" && id && !action) return revokeToken(client, owner, id);
  if (request.method === "GET" && resource === "invites" && !id) return listInvites(client, owner);
  if (request.method === "POST" && resource === "invites" && !id) return issueInvite(client, owner, body ?? {});
  if (request.method === "POST" && resource === "invites" && id && action === "revoke") return revokeInvite(client, owner, id);
  if (request.method === "GET" && resource === "usage" && !id) return usage(client, owner);
  if (request.method === "GET" && resource === "profile" && !id) return profile(client, owner);
  if (request.method === "POST" && resource === "password" && !id) return changePassword(client, owner, body ?? {}, currentSessionHash);
  if (request.method === "GET" && resource === "seminars" && !id) return listSeminars(client, owner);
  if (request.method === "GET" && resource === "seminars" && id && !action) return seminarDetail(client, owner, id, new URL(request.url).searchParams);
  if (request.method === "POST" && resource === "seminars" && id && action === "title") return renameSeminar(client, owner, id, body ?? {});
  if (request.method === "POST" && resource === "seminars" && id && action === "resume-code") return mintResumeCode(client, owner, id);
  if (request.method === "POST" && resource === "seminars" && id && action === "revoke-grant") return revokeSeminarGrant(client, owner, id, body ?? {});
  if (resource === "syndications") {
    const sub = segments[5];
    if (request.method === "POST" && !id) return mintSyndicationCode(client, owner, body ?? {});
    if (request.method === "GET" && !id) return listSyndications(client, owner);
    if (request.method === "POST" && id === "redeem" && !action) return redeemSyndicationCode(client, owner, body ?? {});
    if (request.method === "POST" && id === "grants" && action && sub === "revoke") return revokeSyndicationGrant(client, owner, action);
  }
  return json({ error: "not_found" }, 404);
}

type AgentCardShape = { handle?: string; displayName?: string; sourceIdentity?: { title?: string; authors?: string[]; year?: number; workType?: string; citation?: string; annotation?: string; annotationSource?: string } };

// The companion's seminar list: the owner-facing view of conversations,
// newest first, with the raw material for a derived title. Conversation
// TOKENS never leave the server — seminars travel by their public ids.
async function listSeminars(client: SupabaseClient, owner: string): Promise<Response> {
  const { data, error } = await client.rpc("list_seminars", { p_owner: owner });
  if (error) return json({ error: "server_error", error_description: error.message }, 500);
  return json({ seminars: data ?? [] });
}

// One seminar's canonical record: meta, participants, and the visible event
// stream — delta-fetched (?after=<sequence>) so the live view polls cheaply.
// The conversation token resolves server-side and never leaves; the response
// carries text and speakers only, not envelopes, hashes, or ids beyond the
// seminar's own public one.
async function seminarDetail(client: SupabaseClient, owner: string, seminarId: string, params: URLSearchParams): Promise<Response> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seminarId)) {
    return json({ error: "invalid_request", error_description: "A valid seminar id is required." }, 400);
  }
  const after = Math.max(0, Number.parseInt(params.get("after") ?? "0", 10) || 0);
  const conv = await client.from("conversations")
    .select("token, id, title, created_at, updated_at, last_sequence")
    .eq("owner", owner).eq("id", seminarId).maybeSingle();
  if (conv.error) return json({ error: "server_error", error_description: conv.error.message }, 500);
  if (!conv.data) return json({ error: "not_found" }, 404);
  const token = conv.data.token as string;

  const [agents, events, lastEvent, grants] = await Promise.all([
    client.from("conversation_agents")
      .select("agent_ref").eq("conversation_token", token).order("created_at", { ascending: true }),
    client.from("conversation_events")
      .select("sequence, created_at, speakerType:event->>speakerType, speakerDisplayName:event->>speakerDisplayName, agentId:event->>speakerAgentId, text:event->>authoredMessage")
      .eq("conversation_token", token)
      .gt("sequence", after)
      .order("sequence", { ascending: true })
      .limit(500),
    client.from("conversation_events")
      .select("created_at")
      .eq("conversation_token", token)
      .order("sequence", { ascending: false })
      .limit(1)
      .maybeSingle(),
    client.from("conversation_grants")
      .select("id, label, created_at, last_used_at")
      .eq("conversation_token", token)
      .is("revoked_at", null)
      .order("created_at", { ascending: true }),
  ]);
  if (agents.error) return json({ error: "server_error", error_description: agents.error.message }, 500);
  if (events.error) return json({ error: "server_error", error_description: events.error.message }, 500);

  return json({
    seminarId,
    title: conv.data.title ?? null,
    createdAt: conv.data.created_at,
    updatedAt: conv.data.updated_at,
    // Liveness is event time, not row time: renames must not read as "live".
    lastEventAt: lastEvent.data?.created_at ?? conv.data.created_at,
    lastSequence: conv.data.last_sequence ?? 0,
    participants: (agents.data ?? []).map((row) => {
      const ref = row.agent_ref as { handle?: string; displayName?: string; agentId?: string };
      return { handle: ref.handle ?? "", displayName: ref.displayName ?? "", agentId: ref.agentId ?? "" };
    }),
    events: (events.data ?? []).map((row: Record<string, unknown>) => ({
      sequence: row.sequence,
      at: row.created_at,
      speakerType: row.speakerType,
      speakerDisplayName: row.speakerDisplayName ?? null,
      agentId: row.agentId ?? null,
      text: row.text ?? "",
    })),
    // A2: which host threads hold a live continuation grant. Active only —
    // a revoked grant is a dead credential, not history worth showing.
    connectedHosts: ((grants.data ?? []) as Array<Record<string, unknown>>).map((row) => ({
      id: row.id,
      label: (row.label as string | null) ?? "Connected host",
      createdAt: row.created_at,
      lastUsedAt: row.last_used_at ?? null,
    })),
  });
}

// A2: revoke a continuation grant — disconnects that host thread from the
// seminar without touching the record or any other host's access. The
// seminar is addressed by its public id; the grant must belong to it.
async function revokeSeminarGrant(client: SupabaseClient, owner: string, seminarId: string, body: Record<string, unknown>): Promise<Response> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seminarId)) {
    return json({ error: "invalid_request", error_description: "A valid seminar id is required." }, 400);
  }
  const grantId = typeof body.grantId === "string" ? body.grantId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(grantId)) {
    return json({ error: "invalid_request", error_description: "A valid grantId is required." }, 400);
  }
  const conv = await client.from("conversations")
    .select("token").eq("owner", owner).eq("id", seminarId).maybeSingle();
  if (conv.error) return json({ error: "server_error", error_description: conv.error.message }, 500);
  if (!conv.data) return json({ error: "not_found" }, 404);
  const update = await client.from("conversation_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", grantId)
    .eq("conversation_token", conv.data.token as string)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();
  if (update.error) return json({ error: "server_error", error_description: update.error.message }, 500);
  if (!update.data) return json({ error: "not_found", error_description: "No active grant with that id on this seminar." }, 404);
  return json({ ok: true, grantId });
}

// Seminar portability: mint a resume code — short-lived, one-use,
// hash-at-rest, shown exactly once. Pasting it into any host carries the
// seminar there (suminar_resume_seminar redeems it); the same move stitches
// a token-dropped fork back to its record.
async function mintResumeCode(client: SupabaseClient, owner: string, seminarId: string): Promise<Response> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seminarId)) {
    return json({ error: "invalid_request", error_description: "A valid seminar id is required." }, 400);
  }
  const conv = await client.from("conversations")
    .select("token").eq("owner", owner).eq("id", seminarId).maybeSingle();
  if (conv.error) return json({ error: "server_error", error_description: conv.error.message }, 500);
  if (!conv.data) return json({ error: "not_found" }, 404);
  const code = `smn_res_${randomBytes(12).toString("hex")}`;
  const insert = await client.from("seminar_resume_codes").insert({
    code_hash: sha256Hex(code),
    conversation_token: conv.data.token as string,
    owner,
  }).select("id, expires_at").single();
  if (insert.error) return json({ error: "server_error", error_description: insert.error.message }, 500);
  return json({ seminarId, code, expiresAt: insert.data.expires_at }, 201);
}

// Rename a seminar: explicit wins, the standing rule. An empty title clears
// the custom name and the derived title takes over again.
async function renameSeminar(client: SupabaseClient, owner: string, seminarId: string, body: Record<string, unknown>): Promise<Response> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(seminarId)) {
    return json({ error: "invalid_request", error_description: "A valid seminar id is required." }, 400);
  }
  const raw = typeof body.title === "string" ? body.title.trim() : "";
  const title = raw ? raw.slice(0, 200) : null;
  const update = await client.from("conversations")
    .update({ title })
    .eq("owner", owner)
    .eq("id", seminarId)
    .select("id, title")
    .maybeSingle();
  if (update.error) return json({ error: "server_error", error_description: update.error.message }, 500);
  if (!update.data) return json({ error: "not_found" }, 404);
  return json({ seminarId, title: update.data.title ?? null });
}

// Mint a syndication code for an agent the caller owns. Hash-at-rest, shown
// exactly once, like every credential here.
async function mintSyndicationCode(client: SupabaseClient, owner: string, body: Record<string, unknown>): Promise<Response> {
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (!agentId) return json({ error: "invalid_request", error_description: "agentId is required" }, 400);
  const agent = await client.from("source_agents").select("agent_id").eq("owner", owner).eq("agent_id", agentId).maybeSingle();
  if (agent.error || !agent.data) return json({ error: "not_found", error_description: "That source agent is not yours to syndicate." }, 404);
  const maxUses = Math.min(Math.max(Math.trunc(Number(body.maxUses ?? 1) || 1), 1), 100);
  const days = Math.min(Math.max(Math.trunc(Number(body.expiresInDays ?? 30) || 30), 1), 365);
  const code = `smn_syn_${randomBytes(12).toString("hex")}`;
  const insert = await client.from("agent_syndication_codes").insert({
    code_hash: sha256Hex(code),
    agent_id: agentId,
    grantor_user_id: owner,
    max_uses: maxUses,
    expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
  }).select("id, expires_at").single();
  if (insert.error) {
    const limited = isPilotLimitMessage(insert.error.message);
    return json({ error: limited ? "pilot_limit" : "server_error", error_description: insert.error.message }, limited ? 400 : 500);
  }
  return json({ syndicationCodeId: insert.data.id, code, expiresAt: insert.data.expires_at, maxUses }, 201);
}

// The signed-in account's own identity, for the Account section.
async function profile(client: SupabaseClient, owner: string): Promise<Response> {
  const { data } = await client.auth.admin.getUserById(owner);
  return json({ email: data?.user?.email ?? null });
}

// Change the account password. The bearer (connector token or web session)
// is the proof of identity — it already grants full account access, so this
// adds no privilege. The new password travels only in the request body over
// HTTPS, is set via Supabase's admin API, and is never logged or echoed;
// failures return a generic message so nothing about the account leaks.
async function changePassword(client: SupabaseClient, owner: string, body: Record<string, unknown>, currentSessionHash?: string): Promise<Response> {
  const password = typeof body.newPassword === "string" ? body.newPassword : "";
  if (password.length < 8 || password.length > 200) {
    return json({ error: "invalid_request", error_description: "The new password must be 8 to 200 characters." }, 400);
  }
  const updated = await client.auth.admin.updateUserById(owner, { password });
  if (updated.error) return json({ error: "server_error", error_description: "The password could not be updated." }, 500);
  // A password change is often a response to a suspected compromise, so it
  // must cut off every OTHER web session immediately (the current tab is
  // spared so the user is not bounced mid-change). Connector tokens are
  // deliberate long-lived credentials with their own revoke controls and are
  // left untouched.
  let revoke = client.from("web_sessions").update({ revoked_at: new Date().toISOString() })
    .eq("user_id", owner).is("revoked_at", null);
  if (currentSessionHash) revoke = revoke.neq("session_hash", currentSessionHash);
  await revoke;
  return json({ ok: true });
}

async function emailsFor(client: SupabaseClient, userIds: string[]): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  for (const userId of [...new Set(userIds)]) {
    const { data } = await client.auth.admin.getUserById(userId);
    if (data?.user?.email) emails.set(userId, data.user.email);
  }
  return emails;
}

// The sharer sees who holds a grant (syndication is a direct personal
// handoff); the recipient sees who granted. Nothing here reads content.
async function listSyndications(client: SupabaseClient, owner: string): Promise<Response> {
  const [codes, granted, received] = await Promise.all([
    client.from("agent_syndication_codes")
      .select("id, agent_id, max_uses, use_count, expires_at, revoked_at, created_at, source_agents(card)")
      .eq("grantor_user_id", owner).order("created_at", { ascending: false }),
    client.from("agent_syndication_grants")
      .select("id, agent_id, grantee_user_id, local_handle, created_at, revoked_at, source_agents(card)")
      .eq("grantor_user_id", owner).is("revoked_at", null).order("created_at", { ascending: false }),
    client.from("agent_syndication_grants")
      .select("id, agent_id, grantor_user_id, local_handle, created_at, source_agents(card)")
      .eq("grantee_user_id", owner).is("revoked_at", null).order("created_at", { ascending: false }),
  ]);
  if (codes.error || granted.error || received.error) {
    const message = codes.error?.message ?? granted.error?.message ?? received.error?.message ?? "syndications unavailable";
    return json({ error: "server_error", error_description: message }, 500);
  }
  const emails = await emailsFor(client, [
    ...(granted.data ?? []).map((row) => row.grantee_user_id as string),
    ...(received.data ?? []).map((row) => row.grantor_user_id as string),
  ]);
  const cardOf = (row: Record<string, unknown>): AgentCardShape => ((row.source_agents as { card?: AgentCardShape } | null)?.card ?? {});
  return json({
    codes: (codes.data ?? []).map((row) => ({
      syndicationCodeId: row.id,
      agentId: row.agent_id,
      handle: cardOf(row as Record<string, unknown>).handle ?? null,
      maxUses: row.max_uses,
      useCount: row.use_count,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at ?? null,
      createdAt: row.created_at,
    })),
    granted: (granted.data ?? []).map((row) => ({
      grantId: row.id,
      agentId: row.agent_id,
      handle: cardOf(row as Record<string, unknown>).handle ?? null,
      granteeEmail: emails.get(row.grantee_user_id as string) ?? "(unknown)",
      localHandle: row.local_handle,
      createdAt: row.created_at,
    })),
    received: (received.data ?? []).map((row) => {
      const card = cardOf(row as Record<string, unknown>);
      const identity = card.sourceIdentity ?? {};
      return {
        grantId: row.id,
        agentId: row.agent_id,
        localHandle: row.local_handle,
        displayName: card.displayName ?? null,
        citation: identity.citation
          ? { verbatim: identity.citation }
          : mlaCitationParts({ authors: identity.authors ?? [], title: identity.title ?? "", ...(identity.year ? { year: identity.year } : {}) }),
        workType: identity.workType ?? null,
        annotation: identity.annotation ?? null,
        annotationSource: identity.annotationSource ?? null,
        grantorEmail: emails.get(row.grantor_user_id as string) ?? "(unknown)",
        createdAt: row.created_at,
      };
    }),
  });
}

// Redeem a syndication code: the agent joins the recipient's roster under a
// locally-unique handle (the MLA collision rules, applied in the recipient's
// namespace). Custody does not move and nothing is copied.
async function redeemSyndicationCode(client: SupabaseClient, owner: string, body: Record<string, unknown>): Promise<Response> {
  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (code.length < 8 || code.length > 200) return json({ error: "invalid_request", error_description: "A syndication code is required." }, 400);
  const row = await client.from("agent_syndication_codes")
    .select("id, agent_id, grantor_user_id, max_uses, use_count, expires_at, revoked_at")
    .eq("code_hash", sha256Hex(code)).maybeSingle();
  const invalid = () => json({ error: "invalid_code", error_description: "That syndication code is not valid, has expired, or has been used up." }, 400);
  if (row.error || !row.data) return invalid();
  if (row.data.revoked_at || new Date(row.data.expires_at as string) <= new Date() || (row.data.use_count as number) >= (row.data.max_uses as number)) return invalid();
  if (row.data.grantor_user_id === owner) return json({ error: "invalid_request", error_description: "That is your own source agent." }, 400);

  const agent = await client.from("source_agents").select("agent_id, card").eq("agent_id", row.data.agent_id as string).maybeSingle();
  if (agent.error || !agent.data) return invalid();
  const card = (agent.data.card as AgentCardShape) ?? {};
  const identity = card.sourceIdentity ?? {};

  const existing = await client.from("agent_syndication_grants")
    .select("id").eq("agent_id", row.data.agent_id as string).eq("grantee_user_id", owner).is("revoked_at", null).limit(1);
  if (existing.data?.length) return json({ error: "invalid_request", error_description: "That source agent is already on your roster." }, 400);

  const [ownHandles, grantHandles] = await Promise.all([
    client.from("source_agents").select("handle:card->>handle").eq("owner", owner),
    client.from("agent_syndication_grants").select("local_handle").eq("grantee_user_id", owner).is("revoked_at", null),
  ]);
  const taken = new Set<string>([
    ...((ownHandles.data ?? []) as Array<{ handle: string | null }>).map((entry) => entry.handle ?? ""),
    ...((grantHandles.data ?? []) as Array<{ local_handle: string }>).map((entry) => entry.local_handle),
  ].filter(Boolean));
  const candidates = [
    ...(card.handle ? [card.handle] : []),
    ...handleCandidates({ authors: identity.authors ?? [], title: identity.title ?? "", ...(identity.year ? { year: identity.year } : {}) }),
  ];
  const localHandle = candidates.find((candidate) => !taken.has(candidate))
    ?? `${candidates[candidates.length - 1]}-${(row.data.agent_id as string).slice(6, 12)}`;

  // The redemption itself is serialized in the database: the RPC locks the
  // code row (SELECT ... FOR UPDATE), re-validates everything this handler
  // pre-checked for friendly errors, inserts the grant, and increments the
  // count in one transaction. The unlocked check-insert-increment it
  // replaces could overshoot the cap under concurrent redemptions
  // (pre-launch review finding).
  const redeemed = await client.rpc("redeem_syndication_code", {
    p_code_hash: sha256Hex(code),
    p_grantee_user_id: owner,
    p_local_handle: localHandle,
  });
  if (redeemed.error) {
    const limited = isPilotLimitMessage(redeemed.error.message);
    return json({ error: limited ? "pilot_limit" : "invalid_request", error_description: limited ? redeemed.error.message : "That source agent is already on your roster." }, 400);
  }
  const outcome = redeemed.data as { ok?: boolean; reason?: string; grantId?: string } | null;
  if (outcome?.ok !== true) {
    if (outcome?.reason === "own_agent") return json({ error: "invalid_request", error_description: "That is your own source agent." }, 400);
    if (outcome?.reason === "already_granted") return json({ error: "invalid_request", error_description: "That source agent is already on your roster." }, 400);
    return invalid();
  }
  return json({ grantId: outcome.grantId, agentId: row.data.agent_id, localHandle, displayName: card.displayName ?? null }, 201);
}

// Either side of a grant may end it: the grantor withdraws, or the grantee
// leaves. Anyone else sees a 404 rather than an existence oracle.
async function revokeSyndicationGrant(client: SupabaseClient, owner: string, grantId: string): Promise<Response> {
  const grant = await client.from("agent_syndication_grants")
    .select("id, grantor_user_id, grantee_user_id").eq("id", grantId).maybeSingle();
  if (grant.error || !grant.data) return json({ error: "not_found" }, 404);
  if (grant.data.grantor_user_id !== owner && grant.data.grantee_user_id !== owner) return json({ error: "not_found" }, 404);
  const update = await client.from("agent_syndication_grants")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", grantId).is("revoked_at", null).select("id");
  if (update.error) return json({ error: "server_error", error_description: update.error.message }, 500);
  if (!update.data?.length) return json({ error: "not_found" }, 404);
  return json({ revoked: true, grantId });
}

// Signup consumes an invite: validate → create the auth user → redeem. The
// order matters because redeem_invite_code records the redeemed user id; if
// redemption loses the race (code exhausted between preview and redeem), the
// just-created user is deleted so a failed signup leaves no residue. The
// first connector token is returned exactly once, like every token here.
async function signup(request: Request, client: SupabaseClient, config: HostedOAuthEnv): Promise<Response> {
  const validation = validateSignupInput(await request.json().catch(() => null));
  if (!validation.ok) return json({ error: "invalid_request", error_description: validation.message }, 400);
  const { inviteCode, email, password, displayName } = validation.input;
  const codeHash = sha256Hex(inviteCode);

  const preview = await client.rpc("preview_invite_code", { p_code_hash: codeHash });
  if (preview.error || !(preview.data as { valid?: boolean })?.valid) {
    return json({ error: "invalid_invite", error_description: "That invite code is not valid, has expired, or has been used up." }, 400);
  }

  const created = await client.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) {
    // Deliberately vague: an invite gates this door, but the error must not
    // become an email-enumeration oracle.
    return json({ error: "invalid_request", error_description: "An account could not be created with that email." }, 400);
  }
  const userId = created.data.user.id;

  const redeemed = await client.rpc("redeem_invite_code", { p_code_hash: codeHash, p_user_id: userId });
  if (redeemed.error || (redeemed.data as { ok?: boolean })?.ok !== true) {
    await client.auth.admin.deleteUser(userId);
    return json({ error: "invalid_invite", error_description: "That invite code is not valid, has expired, or has been used up." }, 400);
  }

  let connectorToken: string | undefined;
  const token = `suminar_${randomBytes(24).toString("hex")}`;
  const insert = await client.from("connector_tokens").insert({
    owner_user_id: userId,
    name: displayName ? `${displayName} — first token` : "First connector token",
    token_hash: sha256Hex(token),
  });
  if (!insert.error) connectorToken = token;

  await client.from("waitlist").update({ invited_at: new Date().toISOString() }).eq("email", email).is("invited_at", null);
  return json({
    userId,
    email,
    ...(connectorToken
      ? { connectorToken }
      : { note: "The account exists, but the first token could not be issued — mint one with your email and password." }),
  }, 201);
}

async function listTokens(client: SupabaseClient, owner: string): Promise<Response> {
  const { data, error } = await client
    .from("connector_tokens")
    .select("id, name, created_at, last_used_at")
    .eq("owner_user_id", owner)
    .is("revoked_at", null)
    .order("created_at", { ascending: false });
  if (error) return json({ error: "server_error", error_description: error.message }, 500);
  const tokens = (data ?? []).map((row) => ({
    tokenId: row.id,
    name: row.name,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? null,
  }));
  return json({ tokens });
}

async function mintToken(client: SupabaseClient, owner: string, body: Record<string, unknown>): Promise<Response> {
  const name = validateTokenName(body.name);
  const token = `suminar_${randomBytes(24).toString("hex")}`;
  const insert = await client.from("connector_tokens")
    .insert({ owner_user_id: owner, name, token_hash: sha256Hex(token) })
    .select("id, created_at")
    .single();
  if (insert.error) return json({ error: "server_error", error_description: insert.error.message }, 500);
  return json({ tokenId: insert.data.id, name, connectorToken: token, createdAt: insert.data.created_at }, 201);
}

async function revokeToken(client: SupabaseClient, owner: string, tokenId: string): Promise<Response> {
  const update = await client.from("connector_tokens")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", tokenId)
    .eq("owner_user_id", owner)
    .is("revoked_at", null)
    .select("id");
  if (update.error) return json({ error: "server_error", error_description: update.error.message }, 500);
  if (!update.data?.length) return json({ error: "not_found" }, 404);
  return json({ revoked: true, tokenId });
}

async function listInvites(client: SupabaseClient, owner: string): Promise<Response> {
  const { data, error } = await client
    .from("invite_codes")
    .select("id, note, max_uses, use_count, expires_at, revoked_at, created_at")
    .eq("issuer_user_id", owner)
    .order("created_at", { ascending: false });
  if (error) return json({ error: "server_error", error_description: error.message }, 500);
  const invites = (data ?? []).map((row) => ({
    inviteCodeId: row.id,
    note: row.note ?? null,
    maxUses: row.max_uses,
    useCount: row.use_count,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at ?? null,
    createdAt: row.created_at,
  }));
  return json({ invites });
}

// Mirrors admin.ts issueInvite with the bearer's account as issuer. The
// active-codes cap is the database trigger's; a rejection surfaces verbatim.
async function issueInvite(client: SupabaseClient, owner: string, body: Record<string, unknown>): Promise<Response> {
  const maxUses = Math.min(Math.max(Math.trunc(Number(body.maxUses ?? 1) || 1), 1), 100);
  const days = Math.min(Math.max(Math.trunc(Number(body.expiresInDays ?? 30) || 30), 1), 365);
  const note = typeof body.note === "string" && body.note.trim() ? body.note.trim() : null;
  const code = `smn_inv_${randomBytes(12).toString("hex")}`;

  const insert = await client.from("invite_codes").insert({
    code_hash: sha256Hex(code),
    issuer_user_id: owner,
    note,
    max_uses: maxUses,
    expires_at: new Date(Date.now() + days * 86_400_000).toISOString(),
  }).select("id, expires_at").single();
  if (insert.error) {
    const limited = isPilotLimitMessage(insert.error.message);
    return json({ error: limited ? "pilot_limit" : "server_error", error_description: insert.error.message }, limited ? 400 : 500);
  }
  return json({ inviteCodeId: insert.data.id, code, expiresAt: insert.data.expires_at, maxUses }, 201);
}

async function revokeInvite(client: SupabaseClient, owner: string, inviteCodeId: string): Promise<Response> {
  const update = await client.from("invite_codes")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", inviteCodeId)
    .eq("issuer_user_id", owner)
    .is("revoked_at", null)
    .select("id");
  if (update.error) return json({ error: "server_error", error_description: update.error.message }, 500);
  if (!update.data?.length) return json({ error: "not_found" }, 404);
  return json({ revoked: true, inviteCodeId });
}

// Quota visibility: the same rolling windows the enforcement triggers count
// (created_at > now() - 24h / 30 days), so the card never disagrees with a
// rejection. Enforcement stays in the database; this is a mirror, not a gate.
async function usage(client: SupabaseClient, owner: string): Promise<Response> {
  const dayStart = new Date(Date.now() - 86_400_000).toISOString();
  const monthStart = new Date(Date.now() - 30 * 86_400_000).toISOString();

  const [day, month, docs] = await Promise.all([
    client.from("invocation_usage").select("id", { count: "exact", head: true }).eq("owner", owner).gt("created_at", dayStart),
    client.from("invocation_usage").select("id", { count: "exact", head: true }).eq("owner", owner).gt("created_at", monthStart),
    client.from("documents").select("byte_size").eq("owner", owner),
  ]);
  if (day.error || month.error || docs.error) {
    const message = day.error?.message ?? month.error?.message ?? docs.error?.message ?? "usage unavailable";
    return json({ error: "server_error", error_description: message }, 500);
  }
  const storageBytes = (docs.data ?? []).reduce((sum, row) => sum + ((row.byte_size as number) ?? 0), 0);
  return json({
    invocationsToday: day.count ?? 0,
    invocationsThisMonth: month.count ?? 0,
    documents: docs.data?.length ?? 0,
    storageBytes,
    limits: {
      invocationsPerDay: PILOT_LIMITS.invocationsPerAccountPerDay,
      invocationsPerMonth: PILOT_LIMITS.invocationsPerAccountPerMonth,
      documents: PILOT_LIMITS.documentsPerAccount,
      storageBytes: PILOT_LIMITS.storageBytesPerAccount,
    },
  });
}
