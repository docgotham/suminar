import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  handleHostedAdminRequest,
  issueInvite,
  markWaitlistInvited,
  provisionAccount,
} from "../src/hosted/admin.js";
import { handleHostedWaitlistRequest } from "../src/hosted/waitlist.js";

const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");

// Identifiers that carry or key user material. No migration that defines the
// operator surface may mention them — so an operator surface that starts
// reading what users uploaded, asked, or were answered fails this suite
// before it ships.
const CONTENT_IDENTIFIERS = [
  /\bfilename\b/,
  /\bstorage_key\b/,
  /\bcontent_sha256\b/,
  /\bfailure_detail\b/,
  /\bmime\b/,
  /\bcard\b/,
  /\bcard_digest\b/,
  /\bconversation_events\b/,
  /\bevent\b/,
  /\bauthored\w*\b/,
  /\braw_text\b/,
  /\bmarkdown\b/,
  /\bchunks\b/,
  /\bembeddings\b/,
  /\bextraction_report\b/,
  /\bprivate_key\b/,
];

describe("content-blind operator surface", () => {
  it("no migration defining admin_overview references a content-bearing identifier", async () => {
    const adminMigrations: Array<{ file: string; sql: string }> = [];
    for (const file of await fs.readdir(MIGRATIONS_DIR)) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), "utf8");
      if (sql.includes("admin_overview")) adminMigrations.push({ file, sql });
    }
    expect(adminMigrations.length).toBeGreaterThanOrEqual(1);
    for (const { file, sql } of adminMigrations) {
      for (const banned of CONTENT_IDENTIFIERS) {
        expect(sql, `${file} must not reference ${banned}`).not.toMatch(banned);
      }
    }
  });

  it("keeps the operator gate and audit visibility in the migration", async () => {
    const sql = await fs.readFile(path.join(MIGRATIONS_DIR, "20260714120000_operators_audits_admin.sql"), "utf8");
    expect(sql).toMatch(/create table if not exists public\.operators/);
    expect(sql).toMatch(/'0920def0-fcaa-4d65-a270-b821cb126297'/);
    expect(sql).toMatch(/function public\.require_operator/);
    expect(sql).toMatch(/'Suminar operator access required'/);
    expect(sql).toMatch(/perform public\.require_operator\(p_operator\)/);
    // The audited can read their audits; nobody else's.
    expect(sql).toMatch(/export_audits_owner_read[\s\S]*?owner = auth\.uid\(\)/);
    expect(sql).toMatch(/operator_access_audits_owner_read[\s\S]*?owner = auth\.uid\(\)/);
  });

  it("the admin handler itself never selects content columns", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "src", "hosted", "admin.ts"), "utf8");
    for (const banned of [/\bstorage\b/, /\bconversation_events\b/, /\bagent_artifacts\b/, /createSignedUrl/, /\bdocuments\b/]) {
      expect(source, `admin.ts must not touch ${banned}`).not.toMatch(banned);
    }
  });
});

function adminStubClient(stub: unknown): SupabaseClient {
  return stub as SupabaseClient;
}

describe("admin handlers", () => {
  it("refuses to run unconfigured", async () => {
    const response = await handleHostedAdminRequest(new Request("https://suminar.example/admin/overview"), {} as NodeJS.ProcessEnv);
    expect(response.status).toBe(500);
  });

  it("issues an invite code whose hash — never the code — is stored, and returns the code once", async () => {
    const inserted: Array<Record<string, unknown>> = [];
    const client = adminStubClient({
      from: (table: string) => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push({ table, ...row });
          return {
            select: () => ({ single: async () => ({ data: { id: "invite-1", expires_at: "2026-08-13T00:00:00Z" }, error: null }) }),
          };
        },
      }),
    });
    const response = await issueInvite(client, "op-1", new Request("https://x/admin/invites", {
      method: "POST",
      body: JSON.stringify({ note: "for a friend", maxUses: 2 }),
    }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.code).toMatch(/^smn_inv_[a-f0-9]{24}$/);
    expect(inserted).toHaveLength(1);
    expect(inserted[0].code_hash).toBe(createHash("sha256").update(body.code, "utf8").digest("hex"));
    expect(inserted[0].note).toBe("for a friend");
    expect(inserted[0].max_uses).toBe(2);
    expect(JSON.stringify(inserted[0])).not.toContain(body.code);
  });

  it("rejects a malformed provisioning email before touching auth", async () => {
    const client = adminStubClient({});
    const response = await provisionAccount(client, "op-1", new Request("https://x/admin/accounts", {
      method: "POST",
      body: JSON.stringify({ email: "not-an-email" }),
    }));
    expect(response.status).toBe(400);
  });

  it("reports whether a waitlist email was known when marking it invited", async () => {
    const client = adminStubClient({
      from: () => ({
        update: () => ({
          eq: () => ({ select: async () => ({ data: [], error: null }) }),
        }),
      }),
    });
    const response = await markWaitlistInvited(client, new Request("https://x/admin/waitlist/invited", {
      method: "POST",
      body: JSON.stringify({ email: "unknown@example.com" }),
    }));
    expect(await response.json()).toMatchObject({ ok: true, known: false });
  });
});

describe("public waitlist endpoint", () => {
  it("only accepts POST", async () => {
    const response = await handleHostedWaitlistRequest(new Request("https://suminar.example/waitlist"), {} as NodeJS.ProcessEnv);
    expect(response.status).toBe(405);
  });

  it("refuses to run unconfigured", async () => {
    const response = await handleHostedWaitlistRequest(new Request("https://suminar.example/waitlist", {
      method: "POST",
      body: JSON.stringify({ email: "a@b.co" }),
    }), {} as NodeJS.ProcessEnv);
    expect(response.status).toBe(500);
  });
});
