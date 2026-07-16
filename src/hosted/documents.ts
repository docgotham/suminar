import { randomUUID, createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ARTIFACT_BUCKET } from "./supabaseArtifacts.js";
import { HostedIngestionService } from "./ingestionService.js";
import { createHostedOAuthClient, readHostedOAuthEnv, resolveBearerOwner } from "./oauth.js";
import { PILOT_LIMITS, isPilotLimitMessage } from "./limits.js";
import { checkHostedRateLimit, hostedRateLimitRules, rateLimitedResponse } from "./ratelimit.js";
import { mlaCitationParts } from "../suminar/naming.js";
import { buildAnnotationDraftPrompt, sampleChunksForDraft } from "../suminar/annotation.js";
import { deriveMetadata } from "../suminar/metadata.js";
import { loadConfig } from "../suminar/config.js";
import OpenAI from "openai";

const PDF_MIME = "application/pdf";
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const MAX_UPLOAD_BYTES = PILOT_LIMITS.uploadMaxBytes;

function json(payload: unknown, status = 200): Response {
  return withCors(new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8" } }));
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", "*");
  headers.set("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "authorization, content-type");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

// Account-scoped document upload and management. Every route authenticates the
// bearer to an owning account; the service-role client bypasses RLS, so owner
// scoping on each query is the tenant wall.
export async function handleHostedDocumentsRequest(request: Request, env: NodeJS.ProcessEnv = process.env): Promise<Response> {
  if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));
  const config = readHostedOAuthEnv(env);
  if (!config) return json({ error: "server_error", error_description: "Hosted Suminar is not configured" }, 500);
  const owner = await resolveBearerOwner(request, env);
  if (!owner) return json({ error: "unauthorized" }, 401);

  const client = createHostedOAuthClient(config);
  const segments = new URL(request.url).pathname.replace(/^\/+|\/+$/g, "").split("/");
  // segments: ["documents"] or ["documents", "<id>"] or ["documents", "<id>", "process"]
  const documentId = segments[1];
  const action = segments[2];

  // Account-keyed frequency limits on the expensive paths; fail-open (the
  // pilot volume quotas underneath fail closed).
  const rules = hostedRateLimitRules(env);
  // One upload spends one uploadPerAccount token, whether it streams through
  // the function (POST /documents) or goes direct-to-Storage (the signing step,
  // POST /documents/upload-url). register() is left ungated: it can only follow
  // a signed URL that was already metered, and re-registering a documentId trips
  // the primary-key guard.
  const gate = request.method === "POST" && (!documentId || documentId === "upload-url" || ["process", "draft-annotation"].includes(action ?? "")) ? rules.uploadPerAccount
    : request.method === "POST" && documentId && action === "identify" ? rules.identifyPerAccount
    : request.method === "POST" && documentId && action === "metadata" ? rules.accountPerOwner
    : request.method === "GET" && documentId && action === "export" ? rules.exportPerAccount
    : null;
  if (gate) {
    const decision = await checkHostedRateLimit(client, gate, owner);
    if (!decision.allowed) return withCors(rateLimitedResponse(decision, gate.name));
  }

  const origin = new URL(request.url).origin;
  if (request.method === "GET" && !documentId) return listDocuments(client, owner);
  if (request.method === "GET" && documentId && action === "export") return exportDocument(client, owner, documentId);
  if (request.method === "POST" && !documentId) return uploadDocument(request, client, owner, origin);
  if (request.method === "POST" && documentId === "upload-url" && !action) return createUploadUrl(request, client, owner);
  if (request.method === "POST" && documentId === "register" && !action) return registerDocument(request, client, owner, origin);
  if (request.method === "POST" && documentId && action === "process") {
    return processDocument(client, owner, documentId, origin, await request.json().catch(() => ({})) as Record<string, unknown>);
  }
  if (request.method === "POST" && documentId && action === "draft-annotation") return draftAnnotation(client, owner, documentId);
  if (request.method === "POST" && documentId && action === "identify") return identifyDocument(client, owner, documentId);
  if (request.method === "POST" && documentId && action === "metadata") {
    return updateMetadata(client, owner, documentId, await request.json().catch(() => ({})) as Record<string, unknown>);
  }
  if (request.method === "DELETE" && documentId) return deleteDocument(client, owner, documentId);
  return json({ error: "not_found" }, 404);
}

async function listDocuments(client: SupabaseClient, owner: string): Promise<Response> {
  const { data, error } = await client
    .from("documents")
    .select("id, filename, mime, byte_size, status, failure_detail, created_at, source_agents(agent_id, card, extraction_status)")
    .eq("owner", owner)
    .order("created_at", { ascending: false });
  if (error) return json({ error: "server_error", error_description: error.message }, 500);
  interface AgentRow {
    agent_id: string;
    card: {
      handle?: string;
      displayName?: string;
      sourceIdentity?: {
        title?: string; authors?: string[]; year?: number; publicationDate?: string; workType?: string; citation?: string;
        annotation?: string; annotationSource?: string;
        metadataProvenance?: Record<string, string>;
      };
    };
    extraction_status: string;
  }
  const documents = (data ?? []).map((row: Record<string, unknown>) => {
    const agents = (row.source_agents as AgentRow[]) ?? [];
    const agent = agents[0];
    const identity = agent?.card?.sourceIdentity ?? {};
    return {
      documentId: row.id,
      filename: row.filename,
      mime: row.mime,
      byteSize: row.byte_size,
      status: row.status,
      failureDetail: row.failure_detail ?? null,
      createdAt: row.created_at,
      agent: agent ? {
        agentId: agent.agent_id,
        handle: agent.card?.handle,
        displayName: agent.card?.displayName,
        extractionStatus: agent.extraction_status,
        // The editable identity fields, for inline correction in the dashboard.
        title: identity.title ?? "",
        authors: identity.authors ?? [],
        year: identity.year ?? null,
        publicationDate: identity.publicationDate ?? null,
        workType: identity.workType ?? null,
        metadataProvenance: identity.metadataProvenance ?? {},
        // A verbatim owner-supplied citation supersedes the derived MLA parts.
        citation: identity.citation
          ? { verbatim: identity.citation }
          : mlaCitationParts({ authors: identity.authors ?? [], title: identity.title ?? "", ...(identity.year ? { year: identity.year } : {}) }),
        annotation: identity.annotation ?? null,
        annotationSource: identity.annotationSource ?? null,
      } : null,
    };
  });
  return json({ documents });
}

async function uploadDocument(request: Request, client: SupabaseClient, owner: string, origin: string): Promise<Response> {
  let form: FormData;
  try { form = await request.formData(); } catch { return json({ error: "invalid_request", error_description: "Expected multipart/form-data" }, 400); }
  const file = form.get("file");
  if (!(file instanceof File)) return json({ error: "invalid_request", error_description: "A file field is required" }, 400);
  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) return json({ error: "invalid_request", error_description: `File must be between 1 byte and ${Math.floor(MAX_UPLOAD_BYTES / 1_048_576)} MB` }, 400);
  const mime = file.type || PDF_MIME;
  if (mime !== PDF_MIME && mime !== DOCX_MIME) return json({ error: "unsupported_media_type", error_description: "Upload a PDF or .docx file" }, 415);

  const bytes = Buffer.from(await file.arrayBuffer());
  const documentId = randomUUID();
  const ext = mime === PDF_MIME ? "pdf" : "docx";
  const storageKey = `${owner}/originals/${documentId}.${ext}`;
  const upload = await client.storage.from(ARTIFACT_BUCKET).upload(storageKey, bytes, { upsert: false, contentType: mime });
  if (upload.error) return json({ error: "server_error", error_description: `Upload failed: ${upload.error.message}` }, 500);

  const insert = await client.from("documents").insert({
    id: documentId,
    owner,
    filename: (form.get("filename") as string | null)?.trim() || file.name || `document.${ext}`,
    mime,
    byte_size: bytes.byteLength,
    content_sha256: createHash("sha256").update(bytes).digest("hex"),
    storage_key: storageKey,
    status: "uploaded",
  }).select("id, status").single();
  if (insert.error) {
    await client.storage.from(ARTIFACT_BUCKET).remove([storageKey]);
    if (isPilotLimitMessage(insert.error.message)) {
      return json({ error: "pilot_limit", error_description: insert.error.message }, 400);
    }
    return json({ error: "server_error", error_description: `Record failed: ${insert.error.message}` }, 500);
  }

  const metadata = {
    title: (form.get("title") as string | null) ?? undefined,
    authors: (form.get("authors") as string | null) ?? undefined,
    year: form.get("year") ? Number(form.get("year")) : undefined,
    handle: (form.get("handle") as string | null) ?? undefined,
    displayName: (form.get("displayName") as string | null) ?? undefined,
    citation: (form.get("citation") as string | null)?.trim() || undefined,
    annotation: (form.get("annotation") as string | null)?.trim() || undefined,
  };

  // Inline processing for the pilot; a queue is a later refinement. The
  // extraction function handles both kinds (PyMuPDF for PDF, python-docx
  // for .docx); the local pypdf fallback remains PDF-only.
  try {
    const ingestion = new HostedIngestionService(client, owner, { extractBaseUrl: origin });
    const result = await ingestion.processDocument(documentId, metadata);
    return json({ documentId, status: result.status, agentId: result.agentId }, 201);
  } catch (error) {
    return json({ documentId, status: "failed", error_description: error instanceof Error ? error.message : String(error) }, 201);
  }
}

function extForMime(mime: string): "pdf" | "docx" { return mime === DOCX_MIME ? "docx" : "pdf"; }

// Direct-to-Storage upload, step one: mint a one-time signed URL the browser
// PUTs the original straight to Storage with — bypassing the ~4.5 MB Vercel
// function request-body limit that a through-function upload hits. No documents
// row is written yet; register() records the file once it has actually landed.
async function createUploadUrl(request: Request, client: SupabaseClient, owner: string): Promise<Response> {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const mime = typeof body.mime === "string" && body.mime ? body.mime : PDF_MIME;
  if (mime !== PDF_MIME && mime !== DOCX_MIME) return json({ error: "unsupported_media_type", error_description: "Upload a PDF or .docx file" }, 415);
  const size = typeof body.size === "number" ? body.size : undefined;
  if (size !== undefined && size > MAX_UPLOAD_BYTES) {
    return json({ error: "invalid_request", error_description: `File exceeds the ${Math.floor(MAX_UPLOAD_BYTES / 1_048_576)} MB per-file limit` }, 400);
  }
  const documentId = randomUUID();
  const storageKey = `${owner}/originals/${documentId}.${extForMime(mime)}`;
  const signed = await client.storage.from(ARTIFACT_BUCKET).createSignedUploadUrl(storageKey);
  if (signed.error || !signed.data) return json({ error: "server_error", error_description: `Could not create an upload URL: ${signed.error?.message ?? "unknown"}` }, 500);
  return json({ documentId, mime, uploadUrl: signed.data.signedUrl, token: signed.data.token }, 201);
}

// Direct-to-Storage upload, step two: record a file the browser uploaded
// directly, then build its source agent. The storage key is re-derived from the
// owner + documentId (never trusted from the client, so one owner can't register
// another's object), the object is downloaded once to establish an authoritative
// byte size + content hash and confirm it actually landed, and the remainder is
// the same insert-then-process path a through-function upload runs.
async function registerDocument(request: Request, client: SupabaseClient, owner: string, origin: string): Promise<Response> {
  const body = await request.json().catch(() => ({})) as Record<string, unknown>;
  const documentId = typeof body.documentId === "string" ? body.documentId.trim() : "";
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) {
    return json({ error: "invalid_request", error_description: "A valid documentId is required" }, 400);
  }
  const mime = typeof body.mime === "string" && body.mime ? body.mime : PDF_MIME;
  if (mime !== PDF_MIME && mime !== DOCX_MIME) return json({ error: "unsupported_media_type", error_description: "Upload a PDF or .docx file" }, 415);
  const ext = extForMime(mime);
  const storageKey = `${owner}/originals/${documentId}.${ext}`;

  const download = await client.storage.from(ARTIFACT_BUCKET).download(storageKey);
  if (download.error || !download.data) {
    return json({ error: "invalid_request", error_description: "We couldn't find your uploaded file yet — it may not have finished uploading. Please try the upload again." }, 400);
  }
  const bytes = Buffer.from(await download.data.arrayBuffer());
  if (bytes.byteLength <= 0) {
    await client.storage.from(ARTIFACT_BUCKET).remove([storageKey]);
    return json({ error: "invalid_request", error_description: "The uploaded file was empty." }, 400);
  }

  const insert = await client.from("documents").insert({
    id: documentId,
    owner,
    filename: (typeof body.filename === "string" && body.filename.trim()) ? body.filename.trim() : `document.${ext}`,
    mime,
    byte_size: bytes.byteLength,
    content_sha256: createHash("sha256").update(bytes).digest("hex"),
    storage_key: storageKey,
    status: "uploaded",
  }).select("id, status").single();
  if (insert.error) {
    if (/duplicate key/i.test(insert.error.message)) {
      return json({ error: "conflict", error_description: "This upload was already registered." }, 409);
    }
    // The object is orphaned without its row — remove it so a rejected upload
    // leaves no residue against the storage quota.
    await client.storage.from(ARTIFACT_BUCKET).remove([storageKey]);
    if (isPilotLimitMessage(insert.error.message)) return json({ error: "pilot_limit", error_description: insert.error.message }, 400);
    return json({ error: "server_error", error_description: `Record failed: ${insert.error.message}` }, 500);
  }

  const metadata = {
    title: (typeof body.title === "string" && body.title.trim()) ? body.title.trim() : undefined,
    authors: (typeof body.authors === "string" && body.authors.trim()) ? body.authors.trim() : undefined,
    year: body.year !== undefined && body.year !== null && body.year !== "" ? Number(body.year) : undefined,
    handle: (typeof body.handle === "string" && body.handle.trim()) ? body.handle.trim() : undefined,
    displayName: (typeof body.displayName === "string" && body.displayName.trim()) ? body.displayName.trim() : undefined,
    citation: (typeof body.citation === "string" && body.citation.trim()) ? body.citation.trim() : undefined,
    annotation: (typeof body.annotation === "string" && body.annotation.trim()) ? body.annotation.trim() : undefined,
  };

  // Inline processing, mirroring the through-function upload; a queue is a later
  // refinement. The original already sits in Storage, so this only extracts,
  // embeds, and writes the owner-scoped rows.
  try {
    const ingestion = new HostedIngestionService(client, owner, { extractBaseUrl: origin });
    const result = await ingestion.processDocument(documentId, metadata);
    return json({ documentId, status: result.status, agentId: result.agentId }, 201);
  } catch (error) {
    return json({ documentId, status: "failed", error_description: error instanceof Error ? error.message : String(error) }, 201);
  }
}

// Reprocess doubles as metadata editing: any field supplied in the body wins
// over the existing card (explicit > existing > derived, the standing rule),
// including a new @handle — which passes the per-owner uniqueness check and
// is refused with a clear message on collision. An empty body reprocesses
// with everything preserved.
async function processDocument(client: SupabaseClient, owner: string, documentId: string, origin: string, body: Record<string, unknown> = {}): Promise<Response> {
  const metadata = {
    title: typeof body.title === "string" && body.title.trim() ? body.title.trim() : undefined,
    authors: typeof body.authors === "string" && body.authors.trim() ? body.authors.trim() : undefined,
    year: body.year !== undefined && body.year !== null && body.year !== "" ? Number(body.year) : undefined,
    publicationDate: typeof body.publicationDate === "string" && body.publicationDate.trim() ? body.publicationDate.trim() : undefined,
    handle: typeof body.handle === "string" && body.handle.trim() ? body.handle.trim() : undefined,
    displayName: typeof body.displayName === "string" && body.displayName.trim() ? body.displayName.trim() : undefined,
    citation: typeof body.citation === "string" && body.citation.trim() ? body.citation.trim() : undefined,
    annotation: typeof body.annotation === "string" && body.annotation.trim() ? body.annotation.trim() : undefined,
  };
  try {
    const ingestion = new HostedIngestionService(client, owner, { extractBaseUrl: origin });
    const result = await ingestion.processDocument(documentId, metadata);
    return json({ documentId, status: result.status, agentId: result.agentId });
  } catch (error) {
    return json({ documentId, status: "failed", error_description: error instanceof Error ? error.message : String(error) }, 400);
  }
}

// Drafts a two-sentence annotation with the configured answer model and
// returns it UNSAVED. Approval flows through the reprocess-metadata path as a
// supplied-tier annotation: the owner is the review gate, so model-generated
// text has no route to display without a human deciding it should be there.
async function draftAnnotation(client: SupabaseClient, owner: string, documentId: string): Promise<Response> {
  const agentRow = await client.from("source_agents")
    .select("agent_id, card")
    .eq("owner", owner).eq("document_id", documentId).maybeSingle();
  if (agentRow.error || !agentRow.data) return json({ error: "not_found", error_description: "No source agent exists for this document yet." }, 404);
  const artifact = await client.from("agent_artifacts")
    .select("storage_key").eq("agent_id", agentRow.data.agent_id as string).eq("kind", "chunks").maybeSingle();
  if (artifact.error || !artifact.data) return json({ error: "not_found", error_description: "This agent has no readable text yet." }, 404);
  const download = await client.storage.from(ARTIFACT_BUCKET).download(artifact.data.storage_key as string);
  if (download.error || !download.data) return json({ error: "server_error", error_description: "The source text could not be read." }, 500);
  const chunks = (await download.data.text()).split(/\r?\n/).filter(Boolean)
    .map((line) => JSON.parse(line) as { page: number; text: string });
  const identity = (agentRow.data.card as { sourceIdentity?: { title?: string; authors?: string[]; year?: number } }).sourceIdentity ?? {};
  const prompt = buildAnnotationDraftPrompt(
    { title: identity.title ?? "", authors: identity.authors ?? [], ...(identity.year ? { year: identity.year } : {}) },
    sampleChunksForDraft(chunks),
  );
  const model = loadConfig().openAiModel;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const response = await openai.responses.create({
      model,
      instructions: prompt.instructions,
      input: prompt.input,
      max_output_tokens: 1_000,
      store: false,
      ...(/^gpt-5(?:-|$)/i.test(model) ? { reasoning: { effort: "low" as const }, text: { verbosity: "low" as const } } : {}),
    });
    const draft = (response.output_text ?? "").trim();
    if (!draft) return json({ error: "server_error", error_description: "The model returned no draft." }, 502);
    return json({ documentId, draft });
  } catch (error) {
    return json({ error: "server_error", error_description: error instanceof Error ? error.message : String(error) }, 502);
  }
}

// Auto-identify a source's bibliographic metadata and APPLY it (the owner
// chose auto-apply-then-edit). The derivation reads the document's own front
// matter first, refines via Crossref on a DOI, and scoped-web-searches only a
// missing date; fields it cannot ground stay empty, and per-field provenance
// rides back so the dashboard flags the web-guessed ones. The handle is
// re-derived from the identified names, upgrading the filename-provisional one.
async function identifyDocument(client: SupabaseClient, owner: string, documentId: string): Promise<Response> {
  const agentRow = await client.from("source_agents")
    .select("agent_id").eq("owner", owner).eq("document_id", documentId).maybeSingle();
  if (agentRow.error || !agentRow.data) return json({ error: "not_found", error_description: "No source agent exists for this document yet." }, 404);
  const artifact = await client.from("agent_artifacts")
    .select("storage_key").eq("agent_id", agentRow.data.agent_id as string).eq("kind", "markdown").maybeSingle();
  if (artifact.error || !artifact.data) return json({ error: "not_found", error_description: "This agent has no readable text yet." }, 404);
  const download = await client.storage.from(ARTIFACT_BUCKET).download(artifact.data.storage_key as string);
  if (download.error || !download.data) return json({ error: "server_error", error_description: "The source text could not be read." }, 500);
  // The front matter carries the citation; strip the extractor's HTML comments.
  const frontMatter = (await download.data.text()).replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();

  const model = loadConfig().openAiModel;
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  let proposal;
  try {
    proposal = await deriveMetadata({ frontMatter, openai, model, allowWeb: true });
  } catch (error) {
    return json({ error: "server_error", error_description: error instanceof Error ? error.message : String(error) }, 502);
  }

  // Only apply fields the derivation actually grounded — never blank an
  // existing value with a gap.
  const fields: Parameters<HostedIngestionService["updateAgentMetadata"]>[1] = { rederiveHandle: true, provenance: proposal.provenance };
  if (proposal.title) fields.title = proposal.title;
  if (proposal.authors?.length) fields.authors = proposal.authors;
  if (proposal.year !== undefined) fields.year = proposal.year;
  if (proposal.publicationDate !== undefined) fields.publicationDate = proposal.publicationDate;
  if (proposal.workType !== undefined) fields.workType = proposal.workType;
  try {
    const ingestion = new HostedIngestionService(client, owner);
    const applied = await ingestion.updateAgentMetadata(documentId, fields);
    return json({
      documentId,
      handle: applied.handle,
      displayName: applied.displayName,
      applied: {
        title: applied.identity.title,
        authors: applied.identity.authors,
        year: applied.identity.year ?? null,
        publicationDate: applied.identity.publicationDate ?? null,
      },
      provenance: proposal.provenance,
      notes: proposal.notes,
    });
  } catch (error) {
    return json({ error: "server_error", error_description: error instanceof Error ? error.message : String(error) }, 500);
  }
}

// Inline metadata edit: a lightweight card update, no re-extraction. Every
// edited field is stamped "manual" provenance so the dashboard stops flagging
// it. Handles are slugified and uniqueness-checked inside updateAgentMetadata.
async function updateMetadata(client: SupabaseClient, owner: string, documentId: string, body: Record<string, unknown>): Promise<Response> {
  const fields: Parameters<HostedIngestionService["updateAgentMetadata"]>[1] = {};
  const provenance: Record<string, "manual"> = {};
  if (typeof body.title === "string") { fields.title = body.title; provenance.title = "manual"; }
  if (Array.isArray(body.authors)) { fields.authors = body.authors.filter((a): a is string => typeof a === "string"); provenance.authors = "manual"; }
  else if (typeof body.authors === "string") { fields.authors = body.authors.split(/[;|]/).map((a) => a.trim()).filter(Boolean); provenance.authors = "manual"; }
  if ("year" in body) { fields.year = body.year === null || body.year === "" ? null : Number(body.year); provenance.year = "manual"; }
  if ("publicationDate" in body) { fields.publicationDate = body.publicationDate == null ? null : String(body.publicationDate); provenance.publicationDate = "manual"; }
  if ("workType" in body) {
    const wt = body.workType;
    if (wt === null || wt === "") { fields.workType = null; provenance.workType = "manual"; }
    else if (wt === "standalone" || wt === "contained") { fields.workType = wt; provenance.workType = "manual"; }
    else return json({ error: "invalid_request", error_description: "workType must be \"standalone\" or \"contained\"." }, 400);
  }
  if (typeof body.handle === "string") fields.handle = body.handle;
  if (typeof body.citation === "string") fields.citation = body.citation;
  if (Object.keys(provenance).length) fields.provenance = provenance;
  if (fields.year !== undefined && fields.year !== null && !Number.isInteger(fields.year)) {
    return json({ error: "invalid_request", error_description: "Year must be a whole number." }, 400);
  }
  try {
    const ingestion = new HostedIngestionService(client, owner);
    const result = await ingestion.updateAgentMetadata(documentId, fields);
    return json({ documentId, handle: result.handle, displayName: result.displayName });
  } catch (error) {
    return json({ error: "invalid_request", error_description: error instanceof Error ? error.message : String(error) }, 400);
  }
}

const EXPORT_URL_TTL_SECONDS = 600;

// The leave-ability property: an owner can always take the original and every
// derivative with them, and each export leaves an audit row the owner can
// read. Signing keys are agent custody, not user material — never exported.
// If the audit row cannot be written, nothing is released.
async function exportDocument(client: SupabaseClient, owner: string, documentId: string): Promise<Response> {
  const doc = await client.from("documents")
    .select("id, storage_key, byte_size, source_agents(agent_id)")
    .eq("owner", owner).eq("id", documentId).maybeSingle();
  if (doc.error || !doc.data) return json({ error: "not_found" }, 404);
  const agentIds = ((doc.data.source_agents as Array<{ agent_id: string }>) ?? []).map((agent) => agent.agent_id);

  const targets: Array<{ kind: string; key: string; byteSize: number | null }> = [
    { kind: "original", key: doc.data.storage_key as string, byteSize: (doc.data.byte_size as number) ?? null },
  ];
  if (agentIds.length) {
    const artifacts = await client.from("agent_artifacts")
      .select("agent_id, kind, storage_key, byte_size")
      .in("agent_id", agentIds);
    if (artifacts.error) return json({ error: "server_error", error_description: artifacts.error.message }, 500);
    for (const row of artifacts.data ?? []) {
      if (row.kind === "private_key" || row.kind === "original") continue;
      targets.push({ kind: row.kind as string, key: row.storage_key as string, byteSize: (row.byte_size as number) ?? null });
    }
  }

  const audit = await client.from("export_audits").insert({ owner, document_id: documentId, scope: "bundle" });
  if (audit.error) {
    return json({ error: "server_error", error_description: `Export was not recorded, so nothing was released: ${audit.error.message}` }, 500);
  }

  const files: Array<{ kind: string; url: string; byteSize: number | null }> = [];
  for (const target of targets) {
    const signed = await client.storage.from(ARTIFACT_BUCKET).createSignedUrl(target.key, EXPORT_URL_TTL_SECONDS);
    if (signed.error || !signed.data) continue;
    files.push({ kind: target.kind, url: signed.data.signedUrl, byteSize: target.byteSize });
  }
  if (!files.length) return json({ error: "server_error", error_description: "No exportable files were available" }, 500);
  return json({ documentId, files, expiresInSeconds: EXPORT_URL_TTL_SECONDS });
}

async function deleteDocument(client: SupabaseClient, owner: string, documentId: string): Promise<Response> {
  const doc = await client.from("documents").select("id, storage_key, source_agents(agent_id)").eq("owner", owner).eq("id", documentId).maybeSingle();
  if (doc.error || !doc.data) return json({ error: "not_found" }, 404);
  const agentIds = ((doc.data.source_agents as Array<{ agent_id: string }>) ?? []).map((agent) => agent.agent_id);

  // Remove Storage objects (not cascaded by the DB): the original plus every
  // agent artifact prefix.
  const keys: string[] = [doc.data.storage_key as string];
  for (const agentId of agentIds) {
    for (const kind of ["original", "markdown", "chunks", "embeddings", "extraction_report", "private_key"]) {
      keys.push(`${owner}/${agentId}/${kind}`);
    }
  }
  await client.storage.from(ARTIFACT_BUCKET).remove(keys);

  // Deleting the document cascades source_agents and agent_artifacts rows.
  const del = await client.from("documents").delete().eq("owner", owner).eq("id", documentId);
  if (del.error) return json({ error: "server_error", error_description: del.error.message }, 500);
  return json({ deleted: true, documentId });
}
