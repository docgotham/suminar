import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostedIngestionService } from "../src/hosted/ingestionService.js";
import { SupabaseStore } from "../src/hosted/supabaseStore.js";
import { SupabaseArtifactReader } from "../src/hosted/supabaseArtifacts.js";
import { generateFixtures, fixturesDir } from "./helpers.js";

// End-to-end hosted ingestion against the live project: ingest a fixture PDF
// through Storage + DB, then read the agent back through the same interfaces the
// MCP endpoint uses. Env-gated; skipped without credentials.

const url = process.env.SUMINAR_TEST_SUPABASE_URL;
const serviceKey = process.env.SUMINAR_TEST_SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!url || !serviceKey)("hosted ingestion (live)", () => {
  const admin = createClient(url ?? "http://skipped.invalid", serviceKey ?? "skipped", { auth: { persistSession: false } });
  let owner = "";
  let documentId = "";

  beforeAll(async () => {
    generateFixtures();
    const { data, error } = await admin.auth.admin.createUser({ email: `suminar-ingest-${randomUUID()}@example.com`, email_confirm: true });
    if (error) throw new Error(error.message);
    owner = data.user.id;
    documentId = randomUUID();
    const pdf = fs.readFileSync(path.join(fixturesDir, "clean.pdf"));
    const storageKey = `${owner}/originals/${documentId}.pdf`;
    const up = await admin.storage.from("artifacts").upload(storageKey, pdf, { upsert: true, contentType: "application/pdf" });
    if (up.error) throw new Error(up.error.message);
    const insert = await admin.from("documents").insert({
      id: documentId, owner, filename: "clean.pdf", mime: "application/pdf",
      byte_size: pdf.byteLength, content_sha256: "0".repeat(64), storage_key: storageKey, status: "uploaded",
    });
    if (insert.error) throw new Error(insert.error.message);
  });

  afterAll(async () => {
    if (!owner) return;
    const { data } = await admin.from("source_agents").select("agent_id").eq("owner", owner);
    for (const agent of data ?? []) {
      await admin.storage.from("artifacts").remove(
        ["original", "markdown", "chunks", "embeddings", "extraction_report", "private_key"].map((k) => `${owner}/${agent.agent_id}/${k}`),
      );
    }
    await admin.storage.from("artifacts").remove([`${owner}/originals/${documentId}.pdf`]);
    await admin.auth.admin.deleteUser(owner); // cascades documents, source_agents, agent_artifacts
  });

  it("ingests a PDF to Storage and reads the agent back through the hosted interfaces", async () => {
    const ingestion = new HostedIngestionService(admin, owner);
    const result = await ingestion.processDocument(documentId, { handle: "clean-source", embed: false });
    expect(result.status).toBe("ready");
    expect(result.agentId).toMatch(/^agent_/);

    // The document flipped to ready.
    const doc = await admin.from("documents").select("status").eq("id", documentId).single();
    expect(doc.data?.status).toBe("ready");

    // The store lists the agent for its owner and rebuilds the manifest from
    // storage keys (not filesystem paths).
    const store = new SupabaseStore(admin, owner);
    const manifests = await store.listLocalAgentManifests();
    expect(manifests).toHaveLength(1);
    const manifest = manifests[0]!;
    expect(manifest.privateArtifacts.chunks).toBe(`${owner}/${result.agentId}/chunks`);

    // The artifact reader streams chunks and the signing key back from Storage.
    const reader = new SupabaseArtifactReader(admin);
    const chunks = await reader.readChunks(manifest);
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks.every((chunk) => chunk.agentId === result.agentId)).toBe(true);
    const key = await reader.readPrivateKey(manifest);
    expect(key).toContain("PRIVATE KEY");
  });
});
