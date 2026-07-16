import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConfig } from "../suminar/config.js";
import { IngestionService, buildSourceAgentCard } from "../suminar/ingestion.js";
import type { IngestOptions } from "../suminar/ingestion.js";
import { deriveDisplayName, handleCandidates, slugifyName } from "../suminar/naming.js";
import { deriveAnnotation } from "../suminar/annotation.js";
import { LocalStore } from "../core/storage.js";
import { digestJson } from "../core/crypto.js";
import { generateSigningKeyPair } from "../core/crypto.js";
import type { AgentCard, ChunkRecord, LocalAgentManifest, MetadataField, MetadataOrigin, SourceIdentity } from "../core/types.js";
import OpenAI from "openai";
import type { EmbeddingRecord } from "../suminar/artifacts.js";
import { ARTIFACT_BUCKET } from "./supabaseArtifacts.js";

type ArtifactKind = "original" | "markdown" | "chunks" | "embeddings" | "extraction_report" | "private_key";

// Must match the query-time model: retrieval derives the query-embedding model
// from the stored records, and the open-kernel pipeline defaults to the same.
const EMBEDDING_MODEL = "text-embedding-3-small";
// Smaller batches keep each request modest so one stall costs little; the
// per-request timeout makes a stall fail fast instead of hanging to the
// platform kill, and the total budget bounds a large multi-batch document.
// A single un-timed 81-chunk request once ran a source to the 300s function
// kill, orphaning it in "processing" (2026-07-15).
const EMBEDDING_BATCH = 32;
const EMBEDDING_REQUEST_TIMEOUT_MS = 45_000;
const EMBEDDING_TOTAL_BUDGET_MS = 180_000;

interface ExtractionResult {
  agentId: string;
  sourceHash: string;
  extractionStatus: LocalAgentManifest["extractionStatus"];
  pageCount: number;
  markdown: string;
  chunks: ChunkRecord[];
  extractionReport?: unknown;
}

function documentStatusFor(extractionStatus: LocalAgentManifest["extractionStatus"]): string {
  if (extractionStatus === "clean") return "ready";
  if (extractionStatus === "partial_needs_ocr_review" || extractionStatus === "needs_ocr") return "needs_ocr_review";
  return "failed";
}

// Turns an uploaded document into a hosted source agent. On Vercel, extraction
// runs in the PyMuPDF Python function (reached over HTTP with a signed Storage
// URL); locally, when no extract endpoint is configured, it falls back to the
// open-kernel pypdf pipeline. Either way the derivatives land in private
// Storage and the owner-scoped rows are written here in Node.
export class HostedIngestionService {
  constructor(
    private readonly client: SupabaseClient,
    private readonly owner: string,
    private readonly options: { extractBaseUrl?: string; bucket?: string } = {},
  ) {}

  private get bucket(): string { return this.options.bucket ?? ARTIFACT_BUCKET; }

  private storageKey(agentId: string, kind: ArtifactKind): string {
    return `${this.owner}/${agentId}/${kind}`;
  }

  private extractEndpoint(): string | undefined {
    return process.env.SUMINAR_EXTRACT_URL || (this.options.extractBaseUrl ? `${this.options.extractBaseUrl}/api/extract` : undefined);
  }

  private async uploadFile(agentId: string, kind: ArtifactKind, filePath: string): Promise<{ storageKey: string; byteSize: number }> {
    return this.uploadBytes(agentId, kind, fs.readFileSync(filePath));
  }

  private async uploadBytes(agentId: string, kind: ArtifactKind, body: Buffer | string): Promise<{ storageKey: string; byteSize: number }> {
    const buffer = typeof body === "string" ? Buffer.from(body, "utf8") : body;
    const storageKey = this.storageKey(agentId, kind);
    const { error } = await this.client.storage.from(this.bucket).upload(storageKey, buffer, { upsert: true, contentType: "application/octet-stream" });
    if (error) throw new Error(`Artifact upload failed for ${kind}: ${error.message}`);
    return { storageKey, byteSize: buffer.byteLength };
  }

  private async httpExtract(endpoint: string, secret: string, sourceUrl: string, kind: "pdf" | "docx"): Promise<ExtractionResult> {
    // Bounded below the function's own 300s budget: if extraction grinds, the
    // catch in processDocument must still get to run and record an honest
    // "failed" — an aborted fetch beats a hard-killed function that orphans
    // the document in "processing" forever (observed live, 2026-07-15).
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-suminar-extract-secret": secret },
      body: JSON.stringify({ sourceUrl, kind }),
      signal: AbortSignal.timeout(240_000),
    });
    if (!response.ok) throw new Error(`Extraction function returned ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return await response.json() as ExtractionResult;
  }

  // Embeds chunks with the house OpenAI key. Returns the embeddings artifact as
  // JSONL, or undefined when no key is configured (retrieval falls back to
  // lexical scoring).
  private async computeEmbeddings(chunks: ChunkRecord[]): Promise<string | undefined> {
    if (!process.env.OPENAI_API_KEY || !chunks.length) return undefined;
    // Embeddings are an optional accelerator: retrieval falls back to lexical
    // scoring without them, so this must never throw and never hang. Each
    // request is timeout-bounded (fail fast, no SDK retry to double it), and a
    // stall or the total budget abandons embeddings for this document rather
    // than orphaning it — the document still becomes ready with lexical
    // retrieval, which is the design intent.
    try {
      const client = new OpenAI({
        apiKey: process.env.OPENAI_API_KEY,
        timeout: EMBEDDING_REQUEST_TIMEOUT_MS,
        maxRetries: 0,
      });
      const records: EmbeddingRecord[] = [];
      const deadline = Date.now() + EMBEDDING_TOTAL_BUDGET_MS;
      for (let start = 0; start < chunks.length; start += EMBEDDING_BATCH) {
        if (Date.now() > deadline) {
          throw new Error(`embedding budget exhausted after ${records.length}/${chunks.length} chunks`);
        }
        const batch = chunks.slice(start, start + EMBEDDING_BATCH);
        const response = await client.embeddings.create({ model: EMBEDDING_MODEL, input: batch.map((chunk) => chunk.text) });
        response.data.forEach((row, index) => {
          records.push({ chunkId: batch[index]!.chunkId, model: EMBEDDING_MODEL, embedding: row.embedding });
        });
      }
      return records.map((record) => JSON.stringify(record)).join("\n");
    } catch (error) {
      console.error(`[suminar] embeddings skipped for this source, lexical retrieval retained: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }

  // Per-owner handle uniqueness: the MLA convention's invariant. Handles live
  // inside the card jsonb, so the check queries the json path directly.
  private async handleTakenByAnother(handle: string, agentId: string): Promise<boolean> {
    const { data, error } = await this.client
      .from("source_agents")
      .select("agent_id")
      .eq("owner", this.owner)
      .eq("card->>handle", handle)
      .neq("agent_id", agentId)
      .limit(1);
    if (error) throw new Error(`Handle uniqueness check failed: ${error.message}`);
    return Boolean(data?.length);
  }

  private async firstFreeHandle(candidates: string[], agentId: string): Promise<string> {
    for (const candidate of candidates) {
      if (!(await this.handleTakenByAnother(candidate, agentId))) return candidate;
    }
    // Deterministic last resort beyond the candidate list.
    return `${candidates[candidates.length - 1]}-${agentId.slice(0, 6)}`;
  }

  // Explicit upload options win; otherwise fall back to the existing agent's
  // metadata (so reprocessing preserves it); defaults last.
  private sourceIdentityFrom(options: IngestOptions, filename: string, pageCount: number, existing?: SourceIdentity): SourceIdentity {
    const authors = options.authors ? options.authors.split(/[;|]/).map((a) => a.trim()).filter(Boolean) : (existing?.authors ?? []);
    const title = options.title?.trim() || existing?.title || filename.replace(/\.(pdf|docx)$/i, "") || "Untitled source";
    const edition = options.edition ?? existing?.edition;
    const doiOrIsbn = options.doiOrIsbn ?? existing?.doiOrIsbn;
    const year = options.year ?? existing?.year;
    const publicationDate = options.publicationDate ?? existing?.publicationDate;
    const citation = options.citation ?? existing?.citation;
    return {
      title,
      authors,
      ...(edition ? { edition } : {}),
      ...(doiOrIsbn ? { doiOrIsbn } : {}),
      ...(year ? { year } : {}),
      ...(publicationDate ? { publicationDate } : {}),
      ...(citation ? { citation } : {}),
      ...(pageCount ? { pageCount } : {}),
      ...(existing?.metadataProvenance ? { metadataProvenance: existing.metadataProvenance } : {}),
    };
  }

  // Lightweight metadata edit: rewrite only the agent card's identity, handle,
  // and display name — no re-extraction, no re-embedding. This is the path for
  // both auto-identify (applying derived metadata) and inline field edits, so
  // neither pays the full ingestion cost. The signing key and every other card
  // field are preserved.
  async updateAgentMetadata(documentId: string, fields: {
    title?: string;
    authors?: string[];
    year?: number | null;
    publicationDate?: string | null;
    citation?: string | null;
    handle?: string;
    rederiveHandle?: boolean;
    provenance?: Partial<Record<MetadataField, MetadataOrigin>>;
  }): Promise<{ agentId: string; handle: string; displayName: string; identity: SourceIdentity }> {
    const row = await this.client.from("source_agents")
      .select("agent_id, card").eq("owner", this.owner).eq("document_id", documentId).maybeSingle();
    if (row.error || !row.data) throw new Error("No source agent exists for this document yet.");
    const agentId = row.data.agent_id as string;
    const card = row.data.card as AgentCard;
    const identity: SourceIdentity = { ...card.sourceIdentity };
    if (fields.title !== undefined) identity.title = fields.title.trim() || identity.title;
    if (fields.authors !== undefined) identity.authors = fields.authors.map((a) => a.trim()).filter(Boolean);
    if (fields.year !== undefined) { if (fields.year === null) delete identity.year; else identity.year = fields.year; }
    if (fields.publicationDate !== undefined) { const v = fields.publicationDate?.trim(); if (v) identity.publicationDate = v; else delete identity.publicationDate; }
    if (fields.citation !== undefined) { const v = fields.citation?.trim(); if (v) identity.citation = v; else delete identity.citation; }
    if (fields.provenance) identity.metadataProvenance = { ...identity.metadataProvenance, ...fields.provenance };

    const namingIdentity = { authors: identity.authors, title: identity.title, ...(identity.year ? { year: identity.year } : {}) };
    let handle = card.handle;
    const explicit = fields.handle?.trim();
    if (explicit) {
      const slug = slugifyName(explicit);
      if (!slug) throw new Error("That handle has no usable characters — try letters and numbers.");
      if (slug !== card.handle && await this.handleTakenByAnother(slug, agentId)) {
        throw new Error(`The handle "@${slug}" already belongs to another of your source agents — choose a different one.`);
      }
      handle = slug;
    } else if (fields.rederiveHandle) {
      handle = await this.firstFreeHandle(handleCandidates(namingIdentity), agentId);
    }
    const displayName = deriveDisplayName(namingIdentity);

    const updatedCard: AgentCard = { ...card, handle, displayName, sourceIdentity: identity };
    const update = await this.client.from("source_agents")
      .update({ card: updatedCard, card_digest: digestJson(updatedCard) })
      .eq("owner", this.owner).eq("agent_id", agentId);
    if (update.error) throw new Error(`Metadata update failed: ${update.error.message}`);
    return { agentId, handle, displayName, identity };
  }

  // Persist an extraction result (from the HTTP function) into Storage + DB.
  // The original artifact references the already-uploaded document object rather
  // than duplicating it. Embeddings are deferred; lexical retrieval covers the
  // pilot and hosted embeddings are a follow-up.
  private async persistExtraction(
    documentId: string,
    doc: { filename: string; storage_key: string },
    extraction: ExtractionResult,
    options: IngestOptions,
  ): Promise<{ agentId: string; extractionStatus: LocalAgentManifest["extractionStatus"] }> {
    const agentId = extraction.agentId;
    const keys = generateSigningKeyPair();
    // Reprocessing preserves an existing agent's identity; explicit options override.
    const existing = await this.client.from("source_agents").select("card").eq("owner", this.owner).eq("agent_id", agentId).maybeSingle();
    const existingCard = existing.data?.card as AgentCard | undefined;
    const sourceIdentity = this.sourceIdentityFrom(options, doc.filename, extraction.pageCount, existingCard?.sourceIdentity);
    const identity = { authors: sourceIdentity.authors, title: sourceIdentity.title, year: sourceIdentity.year };
    // MLA naming: an explicit handle wins but must not collide with a sibling
    // agent; an existing agent keeps its identity across reprocessing; only
    // silence receives the derived surname-plus-short-title default.
    const explicitHandle = options.handle?.trim();
    let handle: string;
    if (explicitHandle) {
      if (await this.handleTakenByAnother(explicitHandle, agentId)) {
        throw new Error(`The handle "@${explicitHandle}" already belongs to another of your source agents — choose a different handle or omit it.`);
      }
      handle = explicitHandle;
    } else if (existingCard?.handle) {
      handle = existingCard.handle;
    } else {
      handle = await this.firstFreeHandle(handleCandidates(identity), agentId);
    }
    const displayName = options.displayName?.trim() || existingCard?.displayName || deriveDisplayName(identity);
    const t0 = Date.now();
    const stamp = (label: string): void => console.log(`[suminar-timing] ${agentId} ${label} @${Date.now() - t0}ms`);
    stamp("persist begin");
    // The annotated-bibliography line: supplied wins, the source's own opening
    // text is mined next, metadata composition is the floor.
    const annotation = deriveAnnotation({
      supplied: options.annotation,
      existing: existingCard?.sourceIdentity.annotation
        ? { text: existingCard.sourceIdentity.annotation, source: existingCard.sourceIdentity.annotationSource ?? "supplied" }
        : undefined,
      markdown: extraction.markdown,
      chunks: extraction.chunks.map((chunk) => ({ page: chunk.page, text: chunk.text })),
      identity: { ...identity, pageCount: extraction.pageCount },
    });
    sourceIdentity.annotation = annotation.text;
    sourceIdentity.annotationSource = annotation.source;
    const card = buildSourceAgentCard({ agentId, displayName, handle, sourceIdentity }, keys.publicKey);

    stamp("card built");
    const chunksJsonl = extraction.chunks.map((chunk) => JSON.stringify(chunk)).join("\n");
    const uploads: Array<{ kind: ArtifactKind; storageKey: string; byteSize: number | null }> = [];
    uploads.push({ kind: "markdown", ...(await this.uploadBytes(agentId, "markdown", extraction.markdown)) });
    stamp("markdown uploaded");
    uploads.push({ kind: "chunks", ...(await this.uploadBytes(agentId, "chunks", chunksJsonl)) });
    stamp("chunks uploaded");
    uploads.push({ kind: "extraction_report", ...(await this.uploadBytes(agentId, "extraction_report", JSON.stringify(extraction.extractionReport ?? {}))) });
    uploads.push({ kind: "private_key", ...(await this.uploadBytes(agentId, "private_key", keys.privateKey)) });
    stamp("report+key uploaded");
    const embeddingsJsonl = await this.computeEmbeddings(extraction.chunks);
    stamp(`embeddings ${embeddingsJsonl ? "computed" : "skipped"}`);
    if (embeddingsJsonl) {
      uploads.push({ kind: "embeddings", ...(await this.uploadBytes(agentId, "embeddings", embeddingsJsonl)) });
      stamp("embeddings uploaded");
    }
    // The original stays where the upload put it; reference it in place.
    uploads.push({ kind: "original", storageKey: doc.storage_key, byteSize: null });

    const sourceAgent = await this.client.from("source_agents").upsert({
      agent_id: agentId,
      owner: this.owner,
      document_id: documentId,
      card,
      card_digest: digestJson(card),
      extraction_status: extraction.extractionStatus,
      source_hash: extraction.sourceHash,
    }, { onConflict: "agent_id" }).select("agent_id").single();
    if (sourceAgent.error) throw new Error(`Persist source agent: ${sourceAgent.error.message}`);

    const artifactInsert = await this.client.from("agent_artifacts").upsert(
      uploads.map((upload) => ({ agent_id: agentId, kind: upload.kind, storage_key: upload.storageKey, byte_size: upload.byteSize })),
      { onConflict: "agent_id,kind" },
    ).select("id");
    if (artifactInsert.error) throw new Error(`Persist artifacts: ${artifactInsert.error.message}`);
    stamp("db rows written — persist complete");

    return { agentId, extractionStatus: extraction.extractionStatus };
  }

  // Local fallback (dev / self-host): reuse the open-kernel pipeline into a temp
  // data dir, then upload the produced files.
  private async ingestLocalFile(localPath: string, documentId: string, options: IngestOptions): Promise<{ agentId: string; extractionStatus: LocalAgentManifest["extractionStatus"] }> {
    const config = loadConfig({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "suminar-ingest-")) });
    const tempStore = new LocalStore(config.dataDir);
    const ingestion = new IngestionService(config, tempStore);
    try {
      const manifest = await ingestion.ingest(localPath, options);
      const artifacts = manifest.privateArtifacts;
      const plan: Array<[ArtifactKind, string | undefined]> = [
        ["original", artifacts.originalPdf],
        ["markdown", artifacts.markdown],
        ["chunks", artifacts.chunks],
        ["embeddings", artifacts.embeddings],
        ["extraction_report", artifacts.extractionReport],
        ["private_key", artifacts.privateKey],
      ];
      const uploads: Array<{ kind: ArtifactKind; storageKey: string; byteSize: number }> = [];
      for (const [kind, filePath] of plan) {
        if (!filePath || !fs.existsSync(filePath)) continue;
        uploads.push({ kind, ...(await this.uploadFile(manifest.agentId, kind, filePath)) });
      }
      const sourceAgent = await this.client.from("source_agents").upsert({
        agent_id: manifest.agentId,
        owner: this.owner,
        document_id: documentId,
        card: manifest.card,
        card_digest: manifest.cardDigest,
        extraction_status: manifest.extractionStatus,
        source_hash: manifest.sourceHash,
      }, { onConflict: "agent_id" }).select("agent_id").single();
      if (sourceAgent.error) throw new Error(`Persist source agent: ${sourceAgent.error.message}`);
      const artifactInsert = await this.client.from("agent_artifacts").upsert(
        uploads.map((upload) => ({ agent_id: manifest.agentId, kind: upload.kind, storage_key: upload.storageKey, byte_size: upload.byteSize })),
        { onConflict: "agent_id,kind" },
      ).select("id");
      if (artifactInsert.error) throw new Error(`Persist artifacts: ${artifactInsert.error.message}`);
      return { agentId: manifest.agentId, extractionStatus: manifest.extractionStatus };
    } finally {
      fs.rmSync(config.dataDir, { recursive: true, force: true });
    }
  }

  async processDocument(documentId: string, options: IngestOptions = {}): Promise<{ agentId: string; status: string }> {
    const doc = await this.client
      .from("documents")
      .select("id, owner, filename, mime, storage_key, status")
      .eq("owner", this.owner)
      .eq("id", documentId)
      .maybeSingle();
    if (doc.error || !doc.data) throw new Error("Document not found");
    const mime = doc.data.mime as string;
    const kind: "pdf" | "docx" = mime === "application/pdf" ? "pdf" : "docx";

    await this.client.from("documents").update({ status: "processing", failure_detail: null }).eq("owner", this.owner).eq("id", documentId);
    const endpoint = this.extractEndpoint();
    const secret = process.env.SUMINAR_EXTRACT_SECRET;
    try {
      let result: { agentId: string; extractionStatus: LocalAgentManifest["extractionStatus"] };
      if (endpoint && secret) {
        const te = Date.now();
        const signed = await this.client.storage.from(this.bucket).createSignedUrl(doc.data.storage_key as string, 300);
        if (signed.error || !signed.data?.signedUrl) throw new Error(`Signed URL failed: ${signed.error?.message ?? "no url"}`);
        console.log(`[suminar-timing] ${documentId} extract begin @${Date.now() - te}ms`);
        const extraction = await this.httpExtract(endpoint, secret, signed.data.signedUrl, kind);
        console.log(`[suminar-timing] ${documentId} extract returned @${Date.now() - te}ms (${extraction.pageCount}p ${extraction.chunks.length}ch)`);
        result = await this.persistExtraction(documentId, { filename: doc.data.filename as string, storage_key: doc.data.storage_key as string }, extraction, options);
      } else {
        if (kind !== "pdf") throw new Error("Local fallback ingestion supports PDF only; configure the extraction function for .docx");
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "suminar-src-"));
        const localPath = path.join(tempDir, `${randomUUID()}.pdf`);
        try {
          const download = await this.client.storage.from(this.bucket).download(doc.data.storage_key as string);
          if (download.error || !download.data) throw new Error(`Original download failed: ${download.error?.message ?? "no data"}`);
          fs.writeFileSync(localPath, Buffer.from(await download.data.arrayBuffer()));
          result = await this.ingestLocalFile(localPath, documentId, { embed: Boolean(process.env.OPENAI_API_KEY), ...options });
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }
      const status = documentStatusFor(result.extractionStatus);
      await this.client.from("documents").update({ status }).eq("owner", this.owner).eq("id", documentId);
      return { agentId: result.agentId, status };
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      await this.client.from("documents").update({ status: "failed", failure_detail: detail }).eq("owner", this.owner).eq("id", documentId);
      throw error;
    }
  }
}
