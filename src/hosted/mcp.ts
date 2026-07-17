import { createHash } from "node:crypto";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSuminarMcpServer } from "../suminar/mcp.js";
import type { ResumeSeminarResult } from "../suminar/mcp.js";
import { createSuminarConversationService } from "../suminar/service.js";
import { loadConfig } from "../suminar/config.js";
import { SupabaseStore } from "./supabaseStore.js";
import { GrantResolvingStore, SupabaseGrantDirectory } from "./grants.js";
import type { GrantDirectory } from "./grants.js";
import { SupabaseArtifactReader } from "./supabaseArtifacts.js";
import { MeteredLocalInvoker } from "./metering.js";
import { checkHostedRateLimit, hostedRateLimitRules, rateLimitedResponse } from "./ratelimit.js";
import {
  createHostedOAuthClient,
  hostedMcpUnauthorizedResponse,
  readHostedOAuthEnv,
  resolveBearerOwner,
} from "./oauth.js";

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type, mcp-session-id, mcp-protocol-version");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Stateless JSON-response mode is POST-only. A conformant Streamable HTTP
// client (mcp-remote, the SDK client) probes GET to open a standing
// server->client SSE stream, and may send DELETE to end a session; with no
// session to attach either to, the spec-correct answer is 405 Method Not
// Allowed. Returning 405 rather than any retryable status is load-bearing:
// the client reads 405 on the GET probe as "this endpoint offers no
// server-initiated stream" and drops it silently, whereas 429/5xx drives a
// reconnection storm the host surfaces as a dead connection. Observed in
// production 2026-07-14: the pre-auth rate limiter answered the GET stream
// probe with 429, mcp-remote exhausted its reconnects, and Claude Desktop
// reported the source agent as timed out.
function methodNotAllowed(): Response {
  return new Response(
    JSON.stringify({
      error: "method_not_allowed",
      error_description: "The stateless Suminar MCP endpoint accepts POST only.",
    }),
    { status: 405, headers: { "content-type": "application/json", allow: "POST, OPTIONS" } },
  );
}

// Seminar portability (increment A): redeem a resume code for the SAME
// conversation's continuation state plus a bounded recap. Self-resume only —
// the code's owner must be the authenticated account (cross-account
// participation is increment B, with its own identity model). One-use is
// enforced with a race-safe conditional update.
async function redeemResumeCode(client: SupabaseClient, owner: string, code: string, grants: GrantDirectory): Promise<ResumeSeminarResult | null> {
  if (!/^smn_res_[a-f0-9]{16,}$/i.test(code)) return null;
  const hash = createHash("sha256").update(code, "utf8").digest("hex");
  const row = await client.from("seminar_resume_codes")
    .select("id, conversation_token, owner, expires_at, used_at")
    .eq("code_hash", hash).maybeSingle();
  if (row.error || !row.data) return null;
  if (row.data.owner !== owner) return null;
  if (row.data.used_at) return null;
  if (Date.parse(row.data.expires_at as string) < Date.now()) return null;
  const marked = await client.from("seminar_resume_codes")
    .update({ used_at: new Date().toISOString() })
    .eq("id", row.data.id).is("used_at", null)
    .select("id").maybeSingle();
  if (marked.error || !marked.data) return null;

  const token = row.data.conversation_token as string;
  const conv = await client.from("conversations")
    .select("title, last_sequence").eq("token", token).eq("owner", owner).maybeSingle();
  if (conv.error || !conv.data) return null;
  const [agents, tail, firstUser] = await Promise.all([
    client.from("conversation_agents").select("agent_ref").eq("conversation_token", token).order("created_at", { ascending: true }),
    client.from("conversation_events")
      .select("sequence, speakerType:event->>speakerType, speakerDisplayName:event->>speakerDisplayName, text:event->>authoredMessage")
      .eq("conversation_token", token)
      .order("sequence", { ascending: false })
      .limit(8),
    client.from("conversation_events")
      .select("text:event->>authoredMessage")
      .eq("conversation_token", token)
      .eq("event->>speakerType", "user")
      .order("sequence", { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  const customTitle = conv.data.title as string | null;
  const firstLine = ((firstUser.data as { text?: string } | null)?.text ?? "").replace(/\s+/g, " ").trim();
  const title = customTitle ?? (firstLine ? (firstLine.length > 80 ? `${firstLine.slice(0, 80)}…` : firstLine) : "Seminar");
  // A2: the resuming host receives its own revocable grant, not the raw
  // token (the conversation's unrotatable primary key). Fail open to the
  // raw token only if minting itself fails — a resume must never break on
  // its enhancement.
  let continuation = token;
  try {
    continuation = (await grants.mint(token, `Resumed ${new Date().toISOString().slice(0, 10)}`)).grantToken;
  } catch {
    // pre-A2 behavior remains the floor
  }
  return {
    conversationToken: continuation,
    cursor: (conv.data.last_sequence as number) ?? 0,
    title,
    agentHandles: ((agents.data ?? []) as Array<{ agent_ref: { handle?: string } }>)
      .map((entry) => entry.agent_ref?.handle ?? "")
      .filter(Boolean),
    totalEvents: (conv.data.last_sequence as number) ?? 0,
    recap: ((tail.data ?? []) as Array<Record<string, unknown>>).reverse().map((entry) => ({
      speakerType: String(entry.speakerType ?? ""),
      speakerDisplayName: (entry.speakerDisplayName as string | null) ?? null,
      text: String(entry.text ?? "").slice(0, 1500),
    })),
  };
}

// The hosted Suminar MCP endpoint. Each request is authenticated to an owning
// account, then served by a fresh stateless MCP server whose store and
// artifacts are scoped to that account. The service-role client bypasses RLS,
// so SupabaseStore's owner scoping is the tenant wall.
export async function handleHostedMcpRequest(request: Request, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
  // Everything past here is the POST JSON-RPC path. Non-POST methods (the GET
  // SSE-stream probe, DELETE session teardown) are unsupported in stateless
  // mode and must 405 ahead of auth and the rate limiter — see methodNotAllowed.
  if (request.method !== "POST") return withCors(methodNotAllowed());

  const config = readHostedOAuthEnv(env);
  if (!config) {
    return withCors(new Response(JSON.stringify({ error: "server_error", error_description: "Hosted Suminar is not configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }));
  }

  const owner = await resolveBearerOwner(request, env);
  if (!owner) return withCors(hostedMcpUnauthorizedResponse(request));

  const client = createHostedOAuthClient(config);
  // Account-keyed frequency limit: a runaway agent loop, not a chatty
  // seminar, is the target. Fails open; the invocation quota fails closed.
  const decision = await checkHostedRateLimit(client, hostedRateLimitRules(env).mcpPerAccount, owner);
  if (!decision.allowed) return withCors(rateLimitedResponse(decision, "MCP"));
  // Grants resolve at the store boundary: hosts hold revocable convg_
  // credentials while the raw conversation token stays server-side.
  const grants = new SupabaseGrantDirectory(client, owner);
  const store = new GrantResolvingStore(new SupabaseStore(client, owner), grants);
  const service = createSuminarConversationService(loadConfig(), store, {
    artifactReader: new SupabaseArtifactReader(client),
    wrapLocalInvoker: (invoker) => new MeteredLocalInvoker(invoker, client, owner),
  });
  const server = createSuminarMcpServer(service, {
    resumeSeminar: (code) => redeemResumeCode(client, owner, code, grants),
  });
  // JSON response mode is load-bearing: in SSE mode handleRequest resolves
  // before the JSON-RPC reply is written to the stream, so the close() below
  // tears the stream down and a conformant client sees an empty body and
  // times out. In JSON mode handleRequest resolves with the complete
  // response, which is exactly right for a stateless per-request server.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    return withCors(await transport.handleRequest(request));
  } finally {
    await server.close();
  }
}
