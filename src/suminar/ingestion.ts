import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { digestJson, generateSigningKeyPair } from "../core/crypto.js";
import type { AppConfig } from "./config.js";
import type { AgentCard, LocalAgentManifest, SourceIdentity } from "../core/types.js";
import { LocalStore } from "../core/storage.js";
import { deriveDisplayName, handleCandidates } from "./naming.js";
import { deriveAnnotation } from "./annotation.js";

interface IngestionResult {
  agentId: string;
  handle: string;
  displayName: string;
  sourceHash: string;
  extractionStatus: LocalAgentManifest["extractionStatus"];
  sourceIdentity: SourceIdentity;
  privateArtifacts: Omit<LocalAgentManifest["privateArtifacts"], "privateKey">;
}

export interface IngestOptions {
  title?: string;
  authors?: string;
  year?: number;
  citation?: string;
  edition?: string;
  doiOrIsbn?: string;
  handle?: string;
  displayName?: string;
  annotation?: string;
  embed?: boolean;
}

export interface UpdateAgentMetadata {
  title?: string;
  authors?: string[];
  year?: number | null;
  citation?: string;
  edition?: string;
  doiOrIsbn?: string;
  handle?: string;
  displayName?: string;
  representativeCharter?: LocalAgentManifest["card"]["representativeCharter"];
}

// The canonical source-agent card for a locally-hosted representative, shared
// by the open-kernel ingestion path and the hosted ingestion service so both
// produce byte-identical cards for the same inputs.
export function buildSourceAgentCard(
  params: { agentId: string; displayName: string; handle: string; sourceIdentity: SourceIdentity },
  publicKey: string,
): AgentCard {
  return {
    protocolVersions: ["agent-sum/0.1"],
    agentId: params.agentId,
    agentVersion: "1.1.0",
    displayName: params.displayName,
    handle: params.handle,
    origin: `agent-sum-local://${params.agentId}`,
    operator: { type: "local-user" },
    sourceIdentity: params.sourceIdentity,
    representativeCharter: {
      tone: "Natural, careful, scholarly, and responsive to the shared conversation.",
      verbosity: "moderate",
      interpretiveLatitude: "moderate",
      notes: "Represent the source in the third person without impersonating its author.",
    },
    capabilities: ["answer", "quote", "compare", "respond_to_message", "occurrence_search"],
    quotationPolicy: { maxQuoteChars: 600, maxTotalQuoteChars: 1200, maxQuotes: 3 },
    contextPolicy: { acceptsConversationContext: true, maxContextMessages: 12 },
    memoryAndRetention: {
      storesInvocations: true,
      retentionSummary: "Messages are retained only in conversation-scoped local event streams and agent delivery cursors.",
    },
    endpoint: `agent-sum-local://${params.agentId}/invoke`,
    publicKey,
  };
}

function runJsonProcess(command: string, args: string[], cwd: string): Promise<IngestionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: process.env, windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || stdout.trim() || `Ingestion process exited ${code}`));
        return;
      }
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      if (!line) return reject(new Error("Ingestion process returned no JSON"));
      try { resolve(JSON.parse(line) as IngestionResult); }
      catch { reject(new Error(`Invalid ingestion JSON: ${line.slice(0, 500)}`)); }
    });
  });
}

export class IngestionService {
  constructor(private readonly config: AppConfig, private readonly store: LocalStore) {}

  async ingest(pdfPath: string, options: IngestOptions = {}): Promise<LocalAgentManifest> {
    const args = [
      path.join(this.config.projectRoot, "scripts", "ingest_pdf.py"),
      "ingest",
      path.resolve(pdfPath),
      "--data-dir", this.config.dataDir,
    ];
    const flags: Array<[keyof IngestOptions, string]> = [
      ["title", "--title"], ["authors", "--authors"], ["year", "--year"],
      ["citation", "--citation"], ["edition", "--edition"], ["doiOrIsbn", "--doi-or-isbn"],
      ["handle", "--handle"], ["displayName", "--display-name"],
    ];
    for (const [key, flag] of flags) {
      const value = options[key];
      if (value !== undefined && value !== "") args.push(flag, String(value));
    }
    if (options.embed) args.push("--embed");
    const result = await runJsonProcess(this.config.python, args, this.config.projectRoot);
    this.applyNamingDefaults(result, options);
    return this.finalize(result);
  }

  // MLA naming, mirroring the hosted rules: explicit options win, an existing
  // agent keeps its identity across re-ingestion, and only silence receives
  // the derived surname-plus-short-title default (superseding the Python
  // pipeline's author-year fallback).
  private applyNamingDefaults(result: IngestionResult, options: IngestOptions): void {
    let existingCard: AgentCard | undefined;
    try { existingCard = this.store.getLocalAgentManifest(result.agentId).card; } catch { /* first ingest */ }
    const identity = { authors: result.sourceIdentity.authors, title: result.sourceIdentity.title, year: result.sourceIdentity.year };
    if (!options.handle) {
      result.handle = existingCard?.handle ?? this.firstFreeLocalHandle(handleCandidates(identity), result.agentId);
    }
    if (!options.displayName) {
      result.displayName = existingCard?.displayName ?? deriveDisplayName(identity);
    }
    // Annotation tiers, minus mining (locally the markdown lives on disk;
    // the hosted path mines from the in-hand extraction).
    const annotation = deriveAnnotation({
      supplied: options.annotation,
      existing: existingCard?.sourceIdentity.annotation
        ? { text: existingCard.sourceIdentity.annotation, source: existingCard.sourceIdentity.annotationSource ?? "supplied" }
        : undefined,
      markdown: "",
      identity: { ...identity, pageCount: result.sourceIdentity.pageCount },
    });
    result.sourceIdentity.annotation = annotation.text;
    result.sourceIdentity.annotationSource = annotation.source;
  }

  private firstFreeLocalHandle(candidates: string[], agentId: string): string {
    const taken = new Set(
      this.store.listLocalAgentManifests()
        .filter((manifest) => manifest.agentId !== agentId)
        .map((manifest) => manifest.card.handle),
    );
    for (const candidate of candidates) {
      if (!taken.has(candidate)) return candidate;
    }
    return `${candidates[candidates.length - 1]}-${agentId.slice(0, 6)}`;
  }

  async retryMistralOcr(agentId: string): Promise<LocalAgentManifest> {
    const result = await runJsonProcess(this.config.python, [
      path.join(this.config.projectRoot, "scripts", "ingest_pdf.py"),
      "ocr-mistral", agentId, "--data-dir", this.config.dataDir,
    ], this.config.projectRoot);
    return this.finalize(result);
  }

  updateMetadata(agentId: string, updates: UpdateAgentMetadata): LocalAgentManifest {
    const manifest = this.store.getLocalAgentManifest(agentId);
    const sourceIdentity = { ...manifest.card.sourceIdentity };
    if (updates.title !== undefined) sourceIdentity.title = updates.title.trim();
    if (updates.authors !== undefined) sourceIdentity.authors = updates.authors.map((author) => author.trim()).filter(Boolean);
    if (updates.year === null) delete sourceIdentity.year;
    else if (updates.year !== undefined) sourceIdentity.year = updates.year;
    for (const key of ["citation", "edition", "doiOrIsbn"] as const) {
      const value = updates[key];
      if (value === "") delete sourceIdentity[key];
      else if (value !== undefined) sourceIdentity[key] = value.trim();
    }
    if (!sourceIdentity.title || !sourceIdentity.authors.length) throw new Error("Title and at least one author are required");
    const [major = 1, minor = 0, patchVersion = 0] = manifest.card.agentVersion.split(".").map(Number);
    manifest.card = {
      ...manifest.card,
      ...(updates.handle ? { handle: updates.handle.trim() } : {}),
      ...(updates.displayName ? { displayName: updates.displayName.trim() } : {}),
      ...(updates.representativeCharter ? { representativeCharter: updates.representativeCharter } : {}),
      agentVersion: `${major}.${minor}.${patchVersion + 1}`,
      sourceIdentity,
    };
    manifest.cardDigest = digestJson(manifest.card);
    manifest.updatedAt = new Date().toISOString();
    this.store.saveLocalAgentManifest(manifest);
    this.store.refreshLocalAgentReferences(manifest);
    return manifest;
  }

  private finalize(result: IngestionResult): LocalAgentManifest {
    this.store.ensureLayout();
    const keysDir = path.join(this.store.privateDir, "keys");
    fs.mkdirSync(keysDir, { recursive: true });
    const privateKeyPath = path.join(keysDir, `${result.agentId}.pem`);
    const publicKeyPath = path.join(keysDir, `${result.agentId}.pub.pem`);
    if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) {
      const keys = generateSigningKeyPair();
      fs.writeFileSync(privateKeyPath, keys.privateKey, { encoding: "utf8", mode: 0o600 });
      fs.writeFileSync(publicKeyPath, keys.publicKey, "utf8");
    }
    const publicKey = fs.readFileSync(publicKeyPath, "utf8");
    const card = buildSourceAgentCard({
      agentId: result.agentId,
      displayName: result.displayName,
      handle: result.handle,
      sourceIdentity: result.sourceIdentity,
    }, publicKey);
    const now = new Date().toISOString();
    let createdAt = now;
    try { createdAt = this.store.getLocalAgentManifest(result.agentId).createdAt; } catch { /* first ingest */ }
    const manifest: LocalAgentManifest = {
      schemaVersion: 1,
      agentId: result.agentId,
      card,
      cardDigest: digestJson(card),
      privateArtifacts: { ...result.privateArtifacts, privateKey: privateKeyPath },
      extractionStatus: result.extractionStatus,
      sourceHash: result.sourceHash,
      createdAt,
      updatedAt: now,
    };
    this.store.saveLocalAgentManifest(manifest);
    return manifest;
  }
}
