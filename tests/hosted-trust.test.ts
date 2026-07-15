import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PILOT_LIMITS } from "../src/hosted/limits.js";

// The drift layer of the structural-trust suite: public claims pinned to
// code. docs/hosted-trust.md is the claims page of record (the Phase 3 site
// copies its trust language from there), so every load-bearing sentence on it
// must keep a matching artifact in the tree — a number in pilot_limits, a
// registered tool, a verification function, a discovery route.

const root = process.cwd();
const read = (...segments: string[]) => fs.readFile(path.join(root, ...segments), "utf8");

describe("public claims stay pinned to code", () => {
  it("the trust page carries every pilot limit, verbatim", async () => {
    const page = await read("docs", "hosted-trust.md");
    for (const [key, value] of Object.entries(PILOT_LIMITS)) {
      expect(page, `docs/hosted-trust.md must state ${key} = ${value}`).toContain(String(value));
    }
    expect(page).toContain("BEFORE INSERT");
    expect(page).toContain("fail open");
    expect(page).toContain("fail closed");
  });

  it("the README tool catalog matches the tools the MCP server registers", async () => {
    const readme = await read("README.md");
    const mcp = await read("src", "suminar", "mcp.ts");
    const registered = [...mcp.matchAll(/registerTool\(\s*"(suminar_[a-z_]+)"/g)].map((m) => m[1]).sort();
    expect(registered.length).toBe(6);
    const documented = [...new Set([...readme.matchAll(/suminar_[a-z_]+/g)].map((m) => m[0]))].sort();
    expect(documented).toEqual(registered);
  });

  it("the can't-misquote claim keeps its verification stack", async () => {
    const page = await read("docs", "hosted-trust.md");
    expect(page).toContain("character-for-character");
    const retrieval = await read("src", "suminar", "retrieval.ts");
    expect(retrieval).toMatch(/export function quotationAppearsInPassages/);
    expect(retrieval).toMatch(/export function quotationMatchingPages/);
    expect(retrieval).toMatch(/export function normalizeQuotationText/);
    // The representative layer actually consults it, and citation-strip
    // degradation never extends to quotations.
    const agent = await read("src", "suminar", "localAgent.ts");
    expect(agent).toMatch(/quotationAppearsInPassages|quotationMatchingPages/);
  });

  it("the operator audit commitment keeps its tables and visibility", async () => {
    const page = await read("docs", "hosted-trust.md");
    expect(page).toContain("If we ever look, you see that we looked");
    expect(page).toContain("no end-to-end encryption, deliberately");
    const migration = await read("supabase", "migrations", "20260714120000_operators_audits_admin.sql");
    expect(migration).toMatch(/operator_access_audits_owner_read/);
    expect(migration).toMatch(/export_audits_owner_read/);
  });

  it("the export claim keeps its endpoint, and signing keys stay home", async () => {
    const documents = await read("src", "hosted", "documents.ts");
    expect(documents).toMatch(/action === "export"/);
    expect(documents).toMatch(/private_key.*continue/);
    expect(documents).toMatch(/export_audits/);
    // Audit lands before release.
    expect(documents.indexOf('from("export_audits")')).toBeLessThan(documents.indexOf("createSignedUrl"));
  });

  it("the verifiable-deployment claim keeps /version wired to the deployed commit", async () => {
    const version = await read("src", "hosted", "version.ts");
    expect(version).toContain("VERCEL_GIT_COMMIT_SHA");
    const rewrites = JSON.parse(await read("vercel.json")) as { rewrites: Array<{ source: string; destination: string }> };
    expect(rewrites.rewrites).toContainEqual({ source: "/version", destination: "/api/version" });
  });

  it("the connector claim matches the discovery routes actually served", async () => {
    const page = await read("docs", "hosted-trust.md");
    const oauth = await read("src", "hosted", "oauth.ts");
    const rewrites = JSON.parse(await read("vercel.json")) as { rewrites: Array<{ source: string; destination: string }> };
    for (const wellKnown of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-authorization-server"]) {
      expect(page).toContain(wellKnown);
      expect(oauth).toContain(`"${wellKnown}"`);
      expect(rewrites.rewrites).toContainEqual({ source: wellKnown, destination: "/api/oauth" });
    }
    expect(page).toContain("S256");
    expect(oauth).toContain("S256");
  });

  it("no hosted page ships analytics scripts", async () => {
    const publicDir = path.join(root, "public");
    for (const file of await fs.readdir(publicDir)) {
      if (!file.endsWith(".html")) continue;
      const html = await fs.readFile(path.join(publicDir, file), "utf8");
      expect(html, `${file} must not load external scripts`).not.toMatch(/<script[^>]+src=["']https?:/i);
      expect(html).not.toMatch(/analytics|gtag|posthog|plausible|segment/i);
    }
  });
});
