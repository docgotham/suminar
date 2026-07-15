import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { createSuminarMcpServer } from "../suminar/mcp.js";
import { createSuminarConversationService } from "../suminar/service.js";
import { loadConfig } from "../suminar/config.js";
import { SupabaseStore } from "./supabaseStore.js";
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
  const store = new SupabaseStore(client, owner);
  const service = createSuminarConversationService(loadConfig(), store, {
    artifactReader: new SupabaseArtifactReader(client),
    wrapLocalInvoker: (invoker) => new MeteredLocalInvoker(invoker, client, owner),
  });
  const server = createSuminarMcpServer(service);
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
