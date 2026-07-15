import { createHostedOAuthClient, readHostedOAuthEnv } from "./oauth.js";
import { checkHostedRateLimit, clientIpFromHeaders, hostedRateLimitRules, rateLimitedResponse } from "./ratelimit.js";

// The public waitlist endpoint — the site's one anonymous write. The
// database function owns validation, normalization, the cap, and
// enumeration-proof deduplication; this handler relays, behind an IP-keyed
// rate limit.

function json(payload: unknown, status = 200): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "POST, OPTIONS");
  headers.set("access-control-allow-headers", "content-type");
  return new Response(JSON.stringify(payload), { status, headers });
}

export async function handleHostedWaitlistRequest(request: Request, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  if (request.method === "OPTIONS") return json(null, 204);
  if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const config = readHostedOAuthEnv(env);
  if (!config) return json({ error: "server_error", error_description: "Hosted Suminar is not configured" }, 500);

  let body: { email?: string };
  try { body = await request.json(); } catch { return json({ error: "invalid_request", error_description: "Expected a JSON body" }, 400); }

  const client = createHostedOAuthClient(config);
  const decision = await checkHostedRateLimit(client, hostedRateLimitRules(env).waitlistPerIp, clientIpFromHeaders(request.headers));
  if (!decision.allowed) {
    const limited = rateLimitedResponse(decision, "waitlist");
    const headers = new Headers(limited.headers);
    headers.set("access-control-allow-origin", "*");
    return new Response(limited.body, { status: limited.status, headers });
  }

  const { error } = await client.rpc("join_waitlist", { p_email: body.email ?? "" });
  if (error) return json({ error: "invalid_request", error_description: error.message }, 400);
  return json({ ok: true });
}
