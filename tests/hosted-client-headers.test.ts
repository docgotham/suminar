import { describe, expect, it } from "vitest";
import { createHostedOAuthClient } from "../src/hosted/oauth.js";

// Regression for a demonstrated production failure (2026-07-14): a global
// authorization header override doubled up with supabase-js's own header on
// GoTrue admin requests ("Bearer K, Bearer K"), so the deployed function
// could not provision accounts even though every PostgREST call worked. The
// hosted client must send exactly one Authorization value everywhere.
describe("hosted Supabase client headers", () => {
  it("sends a single Authorization header to auth admin and to PostgREST", async () => {
    const seen: Array<{ url: string; authorization: string | null }> = [];
    const spyFetch: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
      seen.push({
        url: String(input instanceof Request ? input.url : input),
        authorization: headers.get("authorization"),
      });
      return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
    };

    const client = createHostedOAuthClient({ supabaseUrl: "https://spy.invalid", serviceRoleKey: "service-key-value" }, spyFetch);
    await client.from("operators").select("user_id").limit(1).then(() => undefined, () => undefined);
    await client.auth.admin.createUser({ email: "x@example.com" }).then(() => undefined, () => undefined);

    const rest = seen.find((request) => request.url.includes("/rest/v1/"));
    const auth = seen.find((request) => request.url.includes("/auth/v1/admin/"));
    expect(rest, "PostgREST request captured").toBeTruthy();
    expect(auth, "GoTrue admin request captured").toBeTruthy();
    for (const request of [rest!, auth!]) {
      expect(request.authorization, `${request.url} must carry one Bearer value`).toBe("Bearer service-key-value");
    }
  });
});
