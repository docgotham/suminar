// Fixed-window rate limiting in front of the hosted doors. Counters live in
// Postgres (public.check_rate_limit, service-role only) so limits hold across
// serverless instances. Every rejection is structured and legible — an agent
// or a person always learns the reason and exactly when to retry. The limiter
// fails open: if the counter is unreachable or the environment is not
// configured, requests pass, because rate limiting must never be the outage.
// (Volume quotas — the pilot limits — are the fail-closed layer.)

export interface RateLimitRule {
  name: string;
  maxHits: number;
  windowSeconds: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

function envInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function hostedRateLimitRules(env: NodeJS.ProcessEnv = process.env) {
  return {
    // A runaway agent loop, not a chatty seminar, is the target.
    mcpPerAccount: {
      name: "mcp",
      maxHits: envInt(env, "SUMINAR_RATE_MCP_PER_MINUTE", 120),
      windowSeconds: 60,
    },
    // Credential stuffing and token guessing on the consent form.
    oauthAuthorizePerIp: {
      name: "oauth-authorize",
      maxHits: envInt(env, "SUMINAR_RATE_OAUTH_AUTHORIZE_PER_10_MINUTES", 20),
      windowSeconds: 600,
    },
    // Code/refresh exchange churn.
    oauthTokenPerIp: {
      name: "oauth-token",
      maxHits: envInt(env, "SUMINAR_RATE_OAUTH_TOKEN_PER_10_MINUTES", 60),
      windowSeconds: 600,
    },
    // Unauthenticated client registration writes rows.
    oauthRegisterPerIp: {
      name: "oauth-register",
      maxHits: envInt(env, "SUMINAR_RATE_OAUTH_REGISTER_PER_10_MINUTES", 10),
      windowSeconds: 600,
    },
    // Uploads run extraction and embeddings — the expensive pipeline. Bulk
    // pilot sessions upload many sources at once, so this is generous; the
    // volume quotas underneath are the real ceiling.
    uploadPerAccount: {
      name: "upload",
      maxHits: envInt(env, "SUMINAR_RATE_UPLOADS_PER_HOUR", 40),
      windowSeconds: 3600,
    },
    // Auto-identify (gpt-5 + Crossref + web) fires once per drop. Its own
    // budget, so a dozen drops don't consume the upload allowance twice over.
    identifyPerAccount: {
      name: "identify",
      maxHits: envInt(env, "SUMINAR_RATE_IDENTIFY_PER_HOUR", 40),
      windowSeconds: 3600,
    },
    // Exports sign whole-bundle URLs. Generous: an owner testing their own
    // shelf hits 6/hour in minutes (found live 2026-07-14); the audit row is
    // the real control, this is only the runaway-loop guard.
    exportPerAccount: {
      name: "export",
      maxHits: envInt(env, "SUMINAR_RATE_EXPORTS_PER_HOUR", 30),
      windowSeconds: 3600,
    },
    // Operator tooling; generous, but a leaked operator token should not
    // enumerate freely.
    adminPerOperator: {
      name: "admin",
      maxHits: envInt(env, "SUMINAR_RATE_ADMIN_PER_HOUR", 120),
      windowSeconds: 3600,
    },
    // The one anonymous write.
    waitlistPerIp: {
      name: "waitlist",
      maxHits: envInt(env, "SUMINAR_RATE_WAITLIST_PER_HOUR", 5),
      windowSeconds: 3600,
    },
    // Self-serve signup creates an auth user and consumes an invite.
    signupPerIp: {
      name: "signup",
      maxHits: envInt(env, "SUMINAR_RATE_SIGNUPS_PER_HOUR", 5),
      windowSeconds: 3600,
    },
    // Authenticated account-surface operations (tokens, invites, usage).
    accountPerOwner: {
      name: "account",
      maxHits: envInt(env, "SUMINAR_RATE_ACCOUNT_PER_HOUR", 120),
      windowSeconds: 3600,
    },
    // Companion reads: the seminar record polls every ~15s while a seminar
    // page is visible, plus the home list each minute — cheap owner-scoped
    // selects that must not eat the account-operation budget.
    seminarsPerAccount: {
      name: "seminars",
      maxHits: envInt(env, "SUMINAR_RATE_SEMINARS_PER_HOUR", 600),
      windowSeconds: 3600,
    },
  } satisfies Record<string, RateLimitRule>;
}

// First hop of x-forwarded-for is the client on Vercel; requests that carry
// neither header (local dev, tests) share one bucket rather than skipping.
export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip")?.trim();
  return real || "unknown";
}

interface RateLimitRpcClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

export async function checkHostedRateLimit(
  client: RateLimitRpcClient,
  rule: RateLimitRule,
  subject: string,
): Promise<RateLimitDecision> {
  const pass: RateLimitDecision = { allowed: true, remaining: rule.maxHits, retryAfterSeconds: 0 };
  try {
    const { data, error } = await client.rpc("check_rate_limit", {
      p_key: `${rule.name}:${subject}`,
      p_max_hits: rule.maxHits,
      p_window_seconds: rule.windowSeconds,
    });
    if (error) {
      console.warn(`Suminar rate limit check failed (${error.message}); allowing request`);
      return pass;
    }
    const payload = data as { allowed?: unknown; remaining?: unknown; retryAfterSeconds?: unknown } | null;
    if (!payload || typeof payload.allowed !== "boolean") {
      console.warn("Suminar rate limit check returned an unexpected payload; allowing request");
      return pass;
    }
    return {
      allowed: payload.allowed,
      remaining: typeof payload.remaining === "number" ? payload.remaining : 0,
      retryAfterSeconds: typeof payload.retryAfterSeconds === "number" ? payload.retryAfterSeconds : 0,
    };
  } catch (error) {
    console.warn(`Suminar rate limit check failed (${error instanceof Error ? error.message : "error"}); allowing request`);
    return pass;
  }
}

export function rateLimitedResponse(decision: RateLimitDecision, surface: string): Response {
  const retryAfter = Math.max(1, decision.retryAfterSeconds);
  return new Response(
    JSON.stringify({
      error: "rate_limited",
      error_description: `Too many ${surface} requests. Retry in ${retryAfter} seconds.`,
      retryAfterSeconds: retryAfter,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfter),
      },
    },
  );
}
