import { createHash, randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { checkHostedRateLimit, clientIpFromHeaders, hostedRateLimitRules, rateLimitedResponse } from "./ratelimit.js";

// OAuth bridge + connector-token resolution for the hosted Suminar MCP endpoint.
// Remote clients (Claude, ChatGPT) get OAuth access/refresh tokens; users
// authorize either with their Supabase account password or by pasting a
// Suminar connector token. Tokens are stored only as SHA-256 hashes, and the
// unauthenticated doors sit behind IP-keyed fixed-window rate limits. The
// shapes here mirror the shipped Mem·Sum OAuth server.

export interface HostedOAuthEnv {
  supabaseUrl: string;
  serviceRoleKey: string;
}

type HostedOAuthClient = SupabaseClient<any>;

interface RegisteredClient {
  client_id: string;
  client_secret_hash: string | null;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
}

interface AuthorizationCodeRow {
  code_hash: string;
  client_id: string;
  user_id: string;
  redirect_uri: string;
  resource: string;
  scope: string | null;
  code_challenge: string;
  code_challenge_method: string;
  expires_at: string;
  consumed_at: string | null;
}

const ACCESS_PREFIX = "smn_oat_";
const REFRESH_PREFIX = "smn_ort_";

export function readHostedOAuthEnv(env: NodeJS.ProcessEnv = process.env): HostedOAuthEnv | null {
  const supabaseUrl = env.SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) return null;
  return { supabaseUrl, serviceRoleKey };
}

// No global authorization override: supabase-js already sends the key as both
// apikey and Authorization. Forcing a second lowercase header made GoTrue
// admin requests carry "Bearer K, Bearer K", which auth rejects as an invalid
// token even though PostgREST tolerates it (found live 2026-07-14). fetchFn
// is a test seam only.
export function createHostedOAuthClient(config: HostedOAuthEnv, fetchFn?: typeof fetch): HostedOAuthClient {
  return createClient<any>(config.supabaseUrl, config.serviceRoleKey, {
    auth: { autoRefreshToken: false, detectSessionInUrl: false, persistSession: false },
    ...(fetchFn ? { global: { fetch: fetchFn } } : {}),
  });
}

export function hostedOAuthResourceUrl(request: Request): string {
  return `${new URL(request.url).origin}/mcp`;
}

function protectedResourceMetadataUrl(request: Request): string {
  return `${new URL(request.url).origin}/.well-known/oauth-protected-resource`;
}

export function hostedMcpUnauthorizedResponse(request: Request, message = "Suminar MCP authorization required"): Response {
  return jsonResponse({ error: "unauthorized", error_description: message }, 401, {
    "www-authenticate": `Bearer resource_metadata="${protectedResourceMetadataUrl(request)}"`,
  });
}

// Resolve a request's bearer token to an owning account. Accepts a Suminar
// OAuth access token (Claude connector flow) or a raw connector token used
// directly as the bearer (power users, testing). Returns the owner user id or
// null. Used by the MCP endpoint to scope the per-request store.
export async function resolveBearerOwner(request: Request, env: NodeJS.ProcessEnv = process.env): Promise<string | null> {
  const token = readBearerToken(request.headers.get("authorization"));
  if (!token) return null;
  const config = readHostedOAuthEnv(env);
  if (!config) return null;
  const client = createHostedOAuthClient(config);

  if (token.startsWith(ACCESS_PREFIX)) {
    const { data, error } = await client
      .from("oauth_access_tokens")
      .select("user_id, resource, access_expires_at, revoked_at")
      .eq("token_hash", sha256(token))
      .maybeSingle();
    if (error || !data || data.revoked_at) return null;
    if (new Date(data.access_expires_at as string).getTime() <= Date.now()) return null;
    if (!sameResource(data.resource as string, hostedOAuthResourceUrl(request))) return null;
    await client.from("oauth_access_tokens").update({ last_used_at: new Date().toISOString() }).eq("token_hash", sha256(token));
    return data.user_id as string;
  }

  // Otherwise treat it as a raw connector token.
  const { data, error } = await client.rpc("resolve_connector_token", { p_token_hash: sha256(token.trim()) });
  if (error || !data || (data as { ok?: boolean }).ok !== true) return null;
  return (data as { userId?: string }).userId ?? null;
}

export async function handleHostedOAuthRequest(request: Request, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  const url = new URL(request.url);
  const pathname = normalizePathname(url.pathname);
  if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

  if (pathname === "/.well-known/oauth-protected-resource" && request.method === "GET") {
    return jsonResponse({
      resource: `${url.origin}/mcp`,
      authorization_servers: [url.origin],
      bearer_methods_supported: ["header"],
      scopes_supported: ["mcp"],
      resource_name: "Suminar Hosted MCP",
    });
  }
  if (pathname === "/.well-known/oauth-authorization-server" && request.method === "GET") {
    return jsonResponse({
      issuer: url.origin,
      authorization_endpoint: `${url.origin}/oauth/authorize`,
      token_endpoint: `${url.origin}/oauth/token`,
      registration_endpoint: `${url.origin}/oauth/register`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic", "none"],
      scopes_supported: ["mcp"],
    });
  }

  const config = readHostedOAuthEnv(env);
  if (!config) return jsonResponse({ error: "server_error", error_description: "Hosted OAuth is not configured" }, 500);
  const client = createHostedOAuthClient(config);

  // IP-keyed limits on the unauthenticated doors; fail-open by design.
  const rules = hostedRateLimitRules(env);
  const ip = clientIpFromHeaders(request.headers);
  const gate = pathname === "/oauth/register" ? rules.oauthRegisterPerIp
    : pathname === "/oauth/authorize" ? rules.oauthAuthorizePerIp
    : pathname === "/oauth/token" ? rules.oauthTokenPerIp
    : null;
  if (gate) {
    const decision = await checkHostedRateLimit(client, gate, ip);
    if (!decision.allowed) return withCors(rateLimitedResponse(decision, gate.name));
  }

  if (pathname === "/oauth/register" && request.method === "POST") return registerClient(request, client);
  if (pathname === "/oauth/authorize" && request.method === "GET") return authorizeForm(request, client);
  if (pathname === "/oauth/authorize" && request.method === "POST") return authorizeSubmit(request, client, config);
  if (pathname === "/oauth/token" && request.method === "POST") return tokenEndpoint(request, client);
  return jsonResponse({ error: "not_found" }, 404);
}

function normalizePathname(pathname: string): string {
  return pathname.replace(/\/$/, "") || "/";
}

const CLIENT_AUTH_METHODS = ["none", "client_secret_post", "client_secret_basic"] as const;
type ClientAuthMethod = (typeof CLIENT_AUTH_METHODS)[number];

// Honor the auth method the client registers with (RFC 7591). Native and
// connector clients register as public ("none") because they cannot keep a
// secret across sessions — PKCE, which the authorize endpoint already
// requires, is their proof of possession. Forcing client_secret_post on them
// broke every hourly refresh with a 401 once the first access token expired
// (found live 2026-07-14: Codex exchanged fine, then refreshed secretless).
export function planClientRegistration(payload: unknown):
  | { ok: true; record: Record<string, unknown>; response: Record<string, unknown> }
  | { ok: false; error: string; message: string } {
  if (!payload || typeof payload !== "object") return { ok: false, error: "invalid_client_metadata", message: "Expected JSON client metadata" };
  const metadata = payload as { redirect_uris?: unknown; client_name?: unknown; token_endpoint_auth_method?: unknown };
  const redirectUris: unknown[] = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
  if (!redirectUris.length || redirectUris.some((uri) => typeof uri !== "string" || !isAllowedRedirectUri(uri))) {
    return { ok: false, error: "invalid_redirect_uri", message: "Expected HTTPS or localhost redirect URIs" };
  }
  const requested = typeof metadata.token_endpoint_auth_method === "string" ? metadata.token_endpoint_auth_method : "client_secret_post";
  const method: ClientAuthMethod = (CLIENT_AUTH_METHODS as readonly string[]).includes(requested)
    ? (requested as ClientAuthMethod)
    : "client_secret_post";
  const clientId = `smn_client_${randomToken(18)}`;
  const clientSecret = method === "none" ? null : `smn_secret_${randomToken(32)}`;
  const clientName = typeof metadata.client_name === "string" && metadata.client_name.trim() ? metadata.client_name.trim() : "OAuth client";
  const shared = {
    client_name: clientName,
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
  };
  return {
    ok: true,
    record: {
      client_id: clientId,
      client_secret_hash: clientSecret ? sha256(clientSecret) : null,
      ...shared,
    },
    response: {
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret, client_secret_expires_at: 0 } : {}),
      ...shared,
    },
  };
}

async function registerClient(request: Request, client: HostedOAuthClient): Promise<Response> {
  const plan = planClientRegistration(await request.json().catch(() => null));
  if (!plan.ok) return oauthError(plan.error, plan.message, 400);
  const { error } = await client.from("oauth_clients").insert(plan.record);
  if (error) return oauthError("server_error", error.message, 500);
  return jsonResponse(plan.response, 201);
}

async function authorizeForm(request: Request, client: HostedOAuthClient): Promise<Response> {
  const validation = await validateAuthorizeRequest(new URL(request.url).searchParams, client);
  if (!validation.ok) return htmlResponse(errorHtml("Suminar OAuth Error", validation.message), validation.status);
  return htmlResponse(buildConsentHtml(new URL(request.url).searchParams, validation.client.client_name));
}

// Exported for the account surface: signup recovery and password-authorized
// token minting reuse the same GoTrue password grant as the consent form.
export async function signInWithPassword(config: HostedOAuthEnv, email: string, password: string): Promise<string | null> {
  try {
    const response = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { "content-type": "application/json", apikey: config.serviceRoleKey },
      body: JSON.stringify({ email, password }),
    });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null) as { user?: { id?: unknown } } | null;
    const userId = payload?.user?.id;
    return typeof userId === "string" && userId.length > 0 ? userId : null;
  } catch {
    return null;
  }
}

async function authorizeSubmit(request: Request, client: HostedOAuthClient, config: HostedOAuthEnv): Promise<Response> {
  const form = await request.formData();
  const params = new URLSearchParams();
  for (const key of ["response_type", "client_id", "redirect_uri", "state", "scope", "resource", "code_challenge", "code_challenge_method"]) {
    const value = form.get(key);
    if (typeof value === "string") params.set(key, value);
  }
  const validation = await validateAuthorizeRequest(params, client);
  if (!validation.ok) return htmlResponse(errorHtml("Suminar OAuth Error", validation.message), validation.status);
  const clientName = validation.client.client_name;

  let userId: string;
  if (form.get("auth_method") === "password") {
    const email = typeof form.get("email") === "string" ? (form.get("email") as string).trim() : "";
    const password = form.get("password");
    if (!email || typeof password !== "string" || !password.length) {
      return htmlResponse(buildConsentHtml(params, clientName, { error: "Enter your account email and password.", email }), 400);
    }
    const signedIn = await signInWithPassword(config, email, password);
    if (!signedIn) {
      return htmlResponse(buildConsentHtml(params, clientName, { error: "Sign-in failed. Check your credentials, or use a connector token instead.", email }), 401);
    }
    userId = signedIn;
  } else {
    const connectorToken = form.get("connector_token");
    if (typeof connectorToken !== "string" || !connectorToken.startsWith("suminar_")) {
      return htmlResponse(buildConsentHtml(params, clientName, { error: "Paste a valid Suminar connector token." }), 400);
    }
    const { data: resolved, error: resolveError } = await client.rpc("resolve_connector_token", { p_token_hash: sha256(connectorToken.trim()) });
    if (resolveError || !resolved || (resolved as { ok?: boolean }).ok !== true || typeof (resolved as { userId?: unknown }).userId !== "string") {
      return htmlResponse(buildConsentHtml(params, clientName, { error: "That connector token was not accepted." }), 401);
    }
    userId = (resolved as { userId: string }).userId;
  }

  const code = `smn_code_${randomToken(32)}`;
  const { error } = await client.from("oauth_authorization_codes").insert({
    code_hash: sha256(code),
    client_id: validation.client.client_id,
    user_id: userId,
    redirect_uri: params.get("redirect_uri"),
    resource: params.get("resource") ?? hostedOAuthResourceUrl(request),
    scope: params.get("scope") ?? "mcp",
    code_challenge: params.get("code_challenge"),
    code_challenge_method: params.get("code_challenge_method"),
  });
  if (error) return htmlResponse(errorHtml("Suminar OAuth Error", error.message), 500);

  const redirect = new URL(params.get("redirect_uri")!);
  redirect.searchParams.set("code", code);
  const state = params.get("state");
  if (state) redirect.searchParams.set("state", state);
  return new Response(null, { status: 302, headers: { location: redirect.toString() } });
}

async function tokenEndpoint(request: Request, client: HostedOAuthClient): Promise<Response> {
  const form = await request.formData();
  const grantType = stringFormValue(form, "grant_type");
  const clientAuth = await authenticateClient(request, form, client);
  if (!clientAuth.ok) return oauthError("invalid_client", clientAuth.message, 401);
  if (grantType === "authorization_code") return exchangeAuthorizationCode(form, client, clientAuth.client);
  if (grantType === "refresh_token") return refreshAccessToken(form, client, clientAuth.client);
  return oauthError("unsupported_grant_type", "Unsupported grant_type", 400);
}

async function exchangeAuthorizationCode(form: FormData, client: HostedOAuthClient, oauthClient: RegisteredClient): Promise<Response> {
  const code = stringFormValue(form, "code");
  const redirectUri = stringFormValue(form, "redirect_uri");
  const verifier = stringFormValue(form, "code_verifier");
  const resource = stringFormValue(form, "resource");
  if (!code || !redirectUri || !verifier || !resource) {
    return oauthError("invalid_request", "code, redirect_uri, code_verifier, and resource are required", 400);
  }
  const { data, error } = await client
    .from("oauth_authorization_codes")
    .select("code_hash, client_id, user_id, redirect_uri, resource, scope, code_challenge, code_challenge_method, expires_at, consumed_at")
    .eq("code_hash", sha256(code))
    .maybeSingle();
  if (error || !data) return oauthError("invalid_grant", "Authorization code is not valid", 400);
  const row = data as AuthorizationCodeRow;
  if (row.client_id !== oauthClient.client_id) return oauthError("invalid_grant", "Authorization code client mismatch", 400);
  if (row.redirect_uri !== redirectUri) return oauthError("invalid_grant", "Authorization code redirect mismatch", 400);
  if (!sameResource(row.resource, resource)) return oauthError("invalid_target", "Authorization code resource mismatch", 400);
  if (row.consumed_at) return oauthError("invalid_grant", "Authorization code was already used", 400);
  if (new Date(row.expires_at).getTime() <= Date.now()) return oauthError("invalid_grant", "Authorization code expired", 400);
  if (row.code_challenge_method !== "S256" || pkceS256(verifier) !== row.code_challenge) {
    return oauthError("invalid_grant", "PKCE verification failed", 400);
  }
  await client.from("oauth_authorization_codes").update({ consumed_at: new Date().toISOString() }).eq("code_hash", row.code_hash);
  return issueTokenResponse(client, { userId: row.user_id, clientId: row.client_id, resource: row.resource, scope: row.scope ?? "mcp" });
}

async function refreshAccessToken(form: FormData, client: HostedOAuthClient, oauthClient: RegisteredClient): Promise<Response> {
  const refreshToken = stringFormValue(form, "refresh_token");
  const resource = stringFormValue(form, "resource");
  if (!refreshToken) return oauthError("invalid_request", "refresh_token is required", 400);
  const { data, error } = await client
    .from("oauth_access_tokens")
    .select("refresh_token_hash, user_id, client_id, resource, scope, refresh_expires_at, revoked_at")
    .eq("refresh_token_hash", sha256(refreshToken))
    .maybeSingle();
  if (error || !data) return oauthError("invalid_grant", "Refresh token is not valid", 400);
  if (data.client_id !== oauthClient.client_id) return oauthError("invalid_grant", "Refresh token client mismatch", 400);
  if (data.revoked_at) return oauthError("invalid_grant", "Refresh token revoked", 400);
  if (new Date(data.refresh_expires_at as string).getTime() <= Date.now()) return oauthError("invalid_grant", "Refresh token expired", 400);
  if (resource && !sameResource(data.resource as string, resource)) return oauthError("invalid_target", "Refresh token resource mismatch", 400);

  const accessToken = `${ACCESS_PREFIX}${randomToken(32)}`;
  const nextRefreshToken = `${REFRESH_PREFIX}${randomToken(32)}`;
  const { error: updateError } = await client
    .from("oauth_access_tokens")
    .update({
      token_hash: sha256(accessToken),
      refresh_token_hash: sha256(nextRefreshToken),
      access_expires_at: new Date(Date.now() + 3600_000).toISOString(),
      refresh_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      last_used_at: null,
    })
    .eq("refresh_token_hash", sha256(refreshToken));
  if (updateError) return oauthError("server_error", updateError.message, 500);
  return jsonResponse({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: nextRefreshToken, scope: (data.scope as string) ?? "mcp" });
}

async function issueTokenResponse(client: HostedOAuthClient, input: { userId: string; clientId: string; resource: string; scope: string }): Promise<Response> {
  const accessToken = `${ACCESS_PREFIX}${randomToken(32)}`;
  const refreshToken = `${REFRESH_PREFIX}${randomToken(32)}`;
  const { error } = await client.from("oauth_access_tokens").insert({
    token_hash: sha256(accessToken),
    refresh_token_hash: sha256(refreshToken),
    user_id: input.userId,
    client_id: input.clientId,
    resource: input.resource,
    scope: input.scope,
    access_expires_at: new Date(Date.now() + 3600_000).toISOString(),
    refresh_expires_at: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  });
  if (error) return oauthError("server_error", error.message, 500);
  return jsonResponse({ access_token: accessToken, token_type: "Bearer", expires_in: 3600, refresh_token: refreshToken, scope: input.scope });
}

async function authenticateClient(request: Request, form: FormData, client: HostedOAuthClient): Promise<{ ok: true; client: RegisteredClient } | { ok: false; message: string }> {
  const basic = parseBasicAuth(request.headers.get("authorization"));
  const clientId = basic?.clientId ?? stringFormValue(form, "client_id");
  const clientSecret = basic?.clientSecret ?? stringFormValue(form, "client_secret");
  if (!clientId) return { ok: false, message: "client_id is required" };
  const { data, error } = await client
    .from("oauth_clients")
    .select("client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error || !data) return { ok: false, message: "OAuth client is not registered" };
  const row = data as RegisteredClient;
  if (row.token_endpoint_auth_method !== "none") {
    if (!clientSecret || sha256(clientSecret) !== row.client_secret_hash) return { ok: false, message: "OAuth client secret is not valid" };
  }
  return { ok: true, client: row };
}

async function validateAuthorizeRequest(params: URLSearchParams, client: HostedOAuthClient): Promise<{ ok: true; client: RegisteredClient } | { ok: false; message: string; status: number }> {
  if (params.get("response_type") !== "code") return { ok: false, message: "response_type=code is required", status: 400 };
  if (params.get("code_challenge_method") !== "S256" || !params.get("code_challenge")) return { ok: false, message: "PKCE S256 code challenge is required", status: 400 };
  const clientId = params.get("client_id");
  const redirectUri = params.get("redirect_uri");
  if (!clientId || !redirectUri) return { ok: false, message: "client_id and redirect_uri are required", status: 400 };
  const { data, error } = await client
    .from("oauth_clients")
    .select("client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) return { ok: false, message: error.message, status: 500 };
  if (!data) return { ok: false, message: "OAuth client is not registered", status: 400 };
  const row = data as RegisteredClient;
  if (!isRegisteredRedirectUri(redirectUri, row.redirect_uris)) return { ok: false, message: "redirect_uri is not registered", status: 400 };
  const resource = params.get("resource");
  if (resource && !isAllowedResource(resource)) return { ok: false, message: "resource is not a valid Suminar MCP URL", status: 400 };
  return { ok: true, client: row };
}

export function buildConsentHtml(params: URLSearchParams, clientName: string, options: { error?: string; email?: string } = {}): string {
  const hidden = [...params.entries()].map(([key, value]) => `<input type="hidden" name="${escapeHtml(key)}" value="${escapeHtml(value)}">`).join("\n");
  const escapedClientName = escapeHtml(clientName);
  const emailValue = options.email ? escapeHtml(options.email) : "";
  const openTokenSection = Boolean(options.error && !options.email);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Connect Suminar</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 680px; margin: 48px auto; padding: 0 20px; line-height: 1.5; color: #1b1a17; }
    label { display: block; font-weight: 650; margin: 18px 0 8px; }
    input[type="email"], input[type="password"] { width: 100%; box-sizing: border-box; font: inherit; padding: 12px; border: 1px solid #c8bfa8; border-radius: 8px; }
    button { margin-top: 18px; font: inherit; font-weight: 650; padding: 10px 16px; border: 0; border-radius: 8px; background: #8a3f10; color: white; }
    .error { color: #8a1f11; background: #fdeee6; padding: 10px 12px; border-radius: 8px; }
    .note { color: #5c5647; }
    details { margin-top: 28px; border-top: 1px solid #e4dcc9; padding-top: 16px; }
    summary { cursor: pointer; font-weight: 650; color: #5c5647; }
  </style>
</head>
<body>
  <h1>Connect Suminar to ${escapedClientName}</h1>
  <p class="note">Sign in to authorize ${escapedClientName} for this hosted Suminar account. ${escapedClientName} receives OAuth tokens — never your password or connector token.</p>
  ${options.error ? `<p class="error">${escapeHtml(options.error)}</p>` : ""}
  <form method="post" action="/oauth/authorize">
    ${hidden}
    <input type="hidden" name="auth_method" value="password">
    <label for="email">Email</label>
    <input id="email" name="email" type="email" autocomplete="email" value="${emailValue}" required>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" autocomplete="current-password" required>
    <button type="submit">Sign in and connect</button>
  </form>
  <details${openTokenSection ? " open" : ""}>
    <summary>Use a connector token instead</summary>
    <form method="post" action="/oauth/authorize">
      ${hidden}
      <input type="hidden" name="auth_method" value="connector_token">
      <label for="connector_token">Suminar connector token</label>
      <input id="connector_token" name="connector_token" type="password" placeholder="suminar_..." autocomplete="off" required>
      <button type="submit">Connect with token</button>
    </form>
  </details>
</body>
</html>`;
}

function errorHtml(title: string, message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
}

function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

function oauthError(error: string, description: string, status: number): Response {
  return jsonResponse({ error, error_description: description }, status);
}

function jsonResponse(payload: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return withCors(new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders } }));
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function parseBasicAuth(value: string | null): { clientId: string; clientSecret: string } | null {
  const match = value?.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  const decoded = Buffer.from(match[1]!, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return null;
  return { clientId: decoded.slice(0, separator), clientSecret: decoded.slice(separator + 1) };
}

function readBearerToken(value: string | null): string | null {
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1] ? match[1].trim() : null;
}

function stringFormValue(form: FormData, key: string): string | null {
  const value = form.get(key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isAllowedRedirectUri(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || isLoopbackRedirectUrl(url);
  } catch {
    return false;
  }
}

function isRegisteredRedirectUri(candidate: string, registeredUris: string[]): boolean {
  if (registeredUris.includes(candidate)) return true;
  let candidateUrl: URL;
  try { candidateUrl = new URL(candidate); } catch { return false; }
  if (!isLoopbackRedirectUrl(candidateUrl)) return false;
  return registeredUris.some((registered) => {
    try {
      const registeredUrl = new URL(registered);
      if (!isLoopbackRedirectUrl(registeredUrl)) return false;
      return registeredUrl.protocol === candidateUrl.protocol
        && registeredUrl.hostname === candidateUrl.hostname
        && registeredUrl.pathname === candidateUrl.pathname
        && (registeredUrl.port === "" || registeredUrl.port === candidateUrl.port);
    } catch {
      return false;
    }
  });
}

function isLoopbackRedirectUrl(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

function isAllowedResource(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.pathname === "/mcp" || url.pathname === "");
  } catch {
    return false;
  }
}

export function sameResource(a: string, b: string): boolean {
  return normalizeResource(a) === normalizeResource(b);
}

function normalizeResource(value: string): string {
  const url = new URL(value);
  const host = url.host.toLowerCase();
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  return `${url.protocol.toLowerCase()}//${host}${path}`;
}

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
