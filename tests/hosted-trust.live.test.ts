import { createHash, randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The live layer of the structural-trust suite, against the real Suminar
// Supabase project. Env-gated: SUMINAR_TEST_SUPABASE_URL and
// SUMINAR_TEST_SUPABASE_SERVICE_ROLE_KEY enable the service-role properties;
// SUMINAR_TEST_SUPABASE_ANON_KEY additionally enables the RLS-as-authenticated
// properties. Everything creates its own throwaway accounts and rows and
// removes them; nothing here touches real user material.

const url = process.env.SUMINAR_TEST_SUPABASE_URL;
const serviceKey = process.env.SUMINAR_TEST_SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUMINAR_TEST_SUPABASE_ANON_KEY;

const HEX64 = "a".repeat(64);
const MB = 1024 * 1024;

describe.skipIf(!url || !serviceKey)("structural trust (live)", () => {
  const service = createClient(url ?? "http://skipped.invalid", serviceKey ?? "skipped", { auth: { persistSession: false } });
  const password = `Trust-${randomUUID()}!`;
  let userA = "";
  let userB = "";
  let emailA = "";
  let emailB = "";

  beforeAll(async () => {
    emailA = `suminar-trust-a-${randomUUID()}@example.com`;
    emailB = `suminar-trust-b-${randomUUID()}@example.com`;
    for (const email of [emailA, emailB]) {
      const { data, error } = await service.auth.admin.createUser({ email, password, email_confirm: true });
      if (error) throw new Error(error.message);
      if (!userA) userA = data.user.id;
      else userB = data.user.id;
    }
  });

  afterAll(async () => {
    for (const owner of [userA, userB]) {
      if (!owner) continue;
      await service.from("invite_codes").delete().eq("issuer_user_id", owner);
      await service.auth.admin.deleteUser(owner);
    }
    await service.from("rate_limit_counters").delete().like("key", "trust-probe:%");
  });

  it("holds the document and storage caps at the database layer", { timeout: 60_000 }, async () => {
    const row = (i: number, bytes: number) => ({
      owner: userA,
      filename: `trust-${i}.pdf`,
      mime: "application/pdf",
      byte_size: bytes,
      content_sha256: HEX64,
      storage_key: `trust/${userA}/${i}`,
    });

    // A single upload beyond the ceiling is refused outright.
    const oversize = await service.from("documents").insert(row(999, 300 * MB));
    expect(oversize.error?.message ?? "").toMatch(/Suminar pilot limit: a single upload/);

    // 50 documents fit; the 51st is refused.
    const bulk = await service.from("documents").insert(Array.from({ length: 50 }, (_, i) => row(i, 1000)));
    expect(bulk.error).toBeNull();
    const over = await service.from("documents").insert(row(50, 1000));
    expect(over.error?.message ?? "").toMatch(/50 documents per account/);
    await service.from("documents").delete().eq("owner", userA);

    // 4 × 250 MiB fit under 1 GiB; the fifth breaks the account byte cap.
    const big = await service.from("documents").insert(Array.from({ length: 4 }, (_, i) => row(100 + i, 250 * MB)));
    expect(big.error).toBeNull();
    const overflow = await service.from("documents").insert(row(104, 250 * MB));
    expect(overflow.error?.message ?? "").toMatch(/bytes of uploaded sources per account/);
    await service.from("documents").delete().eq("owner", userA);
  });

  it("holds the daily and 30-day invocation caps", { timeout: 120_000 }, async () => {
    const usage = (created?: string) => ({ owner: userA, agent_id: "agent_trustprobe", ...(created ? { created_at: created } : {}) });

    const day = await service.from("invocation_usage").insert(Array.from({ length: 200 }, () => usage()));
    expect(day.error).toBeNull();
    const overDay = await service.from("invocation_usage").insert(usage());
    expect(overDay.error?.message ?? "").toMatch(/invocations per account per day/);
    await service.from("invocation_usage").delete().eq("owner", userA);

    const backdated = new Date(Date.now() - 5 * 86_400_000).toISOString();
    const month = await service.from("invocation_usage").insert(Array.from({ length: 2000 }, () => usage(backdated)));
    expect(month.error).toBeNull();
    const overMonth = await service.from("invocation_usage").insert(usage());
    expect(overMonth.error?.message ?? "").toMatch(/per account per 30 days/);
    await service.from("invocation_usage").delete().eq("owner", userA);
  });

  it("caps active invite codes per issuer", { timeout: 30_000 }, async () => {
    const code = () => ({
      code_hash: createHash("sha256").update(randomUUID(), "utf8").digest("hex"),
      issuer_user_id: userB,
    });
    const bulk = await service.from("invite_codes").insert(Array.from({ length: 10 }, code));
    expect(bulk.error).toBeNull();
    const over = await service.from("invite_codes").insert(code());
    expect(over.error?.message ?? "").toMatch(/active invite codes per account/);
    await service.from("invite_codes").delete().eq("issuer_user_id", userB);
  });

  it("refuses the operator overview to non-operators", async () => {
    const { error } = await service.rpc("admin_overview", { p_operator: userA });
    expect(error?.message ?? "").toMatch(/operator access required/);
  });

  it("counts and then refuses at the rate-limit window", async () => {
    const key = { p_key: `trust-probe:${randomUUID()}`, p_max_hits: 2, p_window_seconds: 60 };
    const first = await service.rpc("check_rate_limit", key);
    const second = await service.rpc("check_rate_limit", key);
    const third = await service.rpc("check_rate_limit", key);
    expect((first.data as { allowed: boolean }).allowed).toBe(true);
    expect((second.data as { allowed: boolean }).allowed).toBe(true);
    expect((third.data as { allowed: boolean; retryAfterSeconds: number }).allowed).toBe(false);
    expect((third.data as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(0);
  });

  describe.skipIf(!anonKey)("as authenticated accounts (RLS)", () => {
    it("scopes rows to their owner and hides private keys entirely", { timeout: 60_000 }, async () => {
      const agentId = `agent_${"b".repeat(12)}`;
      await service.from("documents").insert({
        owner: userA, filename: "rls.pdf", mime: "application/pdf", byte_size: 1000,
        content_sha256: HEX64, storage_key: `trust/${userA}/rls`,
      });
      await service.from("source_agents").insert({
        agent_id: agentId, owner: userA, card: {}, card_digest: HEX64,
        extraction_status: "clean", source_hash: HEX64,
      });
      await service.from("agent_artifacts").insert([
        { agent_id: agentId, kind: "markdown", storage_key: `trust/${userA}/md` },
        { agent_id: agentId, kind: "private_key", storage_key: `trust/${userA}/key` },
      ]);
      await service.from("export_audits").insert({ owner: userA, scope: "bundle" });
      await service.from("invocation_usage").insert({ owner: userA, agent_id: agentId });

      const asUser = async (email: string) => {
        const client = createClient(url!, anonKey!, { auth: { persistSession: false } });
        const signIn = await client.auth.signInWithPassword({ email, password });
        if (signIn.error) throw new Error(signIn.error.message);
        return client;
      };

      try {
        const a = await asUser(emailA);
        expect((await a.from("documents").select("id")).data).toHaveLength(1);
        const artifacts = await a.from("agent_artifacts").select("kind");
        expect(artifacts.data?.map((r) => r.kind)).toEqual(["markdown"]);
        expect((await a.from("export_audits").select("id")).data).toHaveLength(1);
        expect((await a.from("invocation_usage").select("id")).data).toHaveLength(1);

        const b = await asUser(emailB);
        for (const table of ["documents", "source_agents", "agent_artifacts", "export_audits", "invocation_usage"]) {
          expect((await b.from(table).select("*")).data, `${table} must be invisible across accounts`).toHaveLength(0);
        }
        // The meter is read-only even for its owner.
        const tamper = await a.from("invocation_usage").insert({ owner: userA, agent_id: agentId });
        expect(tamper.error).not.toBeNull();
      } finally {
        await service.from("documents").delete().eq("owner", userA);
        await service.from("source_agents").delete().eq("owner", userA);
        await service.from("export_audits").delete().eq("owner", userA);
        await service.from("invocation_usage").delete().eq("owner", userA);
      }
    });
  });
});
