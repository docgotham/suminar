import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PILOT_LIMITS } from "../src/hosted/limits.js";

const MIGRATION = "20260714110000_invites_waitlist.sql";

// Shape assertions on the invite/waitlist migration: the doors of the invite
// beta keep their security properties even if the SQL is later reworked.
// Behavioral proof (issue → redeem → exhaust → expiry) lives in the live
// trust suite.
describe("invites and waitlist migration", () => {
  const sql = () => fs.readFile(path.join(process.cwd(), "supabase", "migrations", MIGRATION), "utf8");

  it("stores invite codes hash-at-rest and caps active codes per issuer from pilot_limits", async () => {
    const text = await sql();
    expect(text).toMatch(/code_hash text not null unique check \(code_hash ~ '\^\[a-f0-9\]\{64\}\$'\)/);
    expect(text).not.toMatch(/\bcode text\b/); // never a plaintext code column
    expect(text).toMatch(/'activeInviteCodesPerIssuer'/);
    expect(text).toMatch(new RegExp(`use_count < max_uses\\) >= v_limit`));
    expect(text).toMatch(/before insert on public\.invite_codes/);
    expect(PILOT_LIMITS.activeInviteCodesPerIssuer).toBeGreaterThan(0);
  });

  it("keeps redemption and preview service-role only, and redemptions invisible to issuers", async () => {
    const text = await sql();
    for (const fn of ["redeem_invite_code", "preview_invite_code"]) {
      expect(text).toMatch(new RegExp(`Suminar ${fn} is service-role only`));
    }
    expect(text).toMatch(/revoke all on table public\.invite_redemptions from public, anon, authenticated/);
    // Redemption serializes per code so a shared code cannot exceed max_uses.
    expect(text).toMatch(/for update/);
  });

  it("keeps the waitlist enumeration-proof and capped from pilot_limits", async () => {
    const text = await sql();
    expect(text).toMatch(/on conflict \(email\) do nothing/);
    expect(text).toMatch(/'waitlistMaxEntries'/);
    expect(text).toMatch(/revoke all on table public\.waitlist from public, anon, authenticated/);
    expect(PILOT_LIMITS.waitlistMaxEntries).toBe(10_000);
  });
});
