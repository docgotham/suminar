# Hosted Suminar — Phase 2 architecture

Status: blueprint of record, approved direction (Dave, 2026-07-13). Open Kernel + hosted-first launch; v1 source agents are private to their owning account (not shareable); 1.0.0 reserved for launch. This document is the execution reference for Phase 2 and follows the shipped Mem·Sum patterns in `C:\Users\Dave\dm_sum` (the as-built census is that repo's "Mem·Sum Ontology and Functional Spec (v3)").

## Topology

Same shape as Mem·Sum: **Vercel functions + Supabase + the open kernel**.

- `api/*.js` — thin Vercel function shims (`export default { fetch }` ) into `dist/hosted/*`.
- `src/hosted/` — the hosted layer (TypeScript, sibling of `src/core/` and `src/suminar/`): MCP endpoint, OAuth, upload/management API, ingestion orchestration, Supabase store, limits, audits, version.
- `vercel.json` — framework null; rewrites for `/mcp`, `/oauth/*`, `/.well-known/oauth-protected-resource*`, `/.well-known/oauth-authorization-server*`, `/version`, `/api/*`; cron for the ingestion worker tick if queueing needs it.
- Supabase: Postgres 17 + Supabase Auth (`auth.users`, `auth.uid()`) + Storage (private buckets) + RLS everywhere.
- The kernel is unchanged: `src/core/` runtime + `src/suminar/` representatives run inside the hosted MCP function, wired through `createSuminarConversationService` with a `SupabaseStore` and hosted artifact access instead of `LocalStore` and file paths.

## Data model (initial migrations)

Migration-per-concern (dm_sum convention), enums via `do $$ ... duplicate_object` blocks, `pgcrypto`. Tables, all `public`, all RLS-enabled:

- `profiles` — `id uuid pk references auth.users`, display_name, created/updated. (Mem·Sum pattern.)
- `documents` — id, owner uuid → auth.users, original filename, mime (`application/pdf` | docx), byte size, content sha256, storage_key (original), **status enum**: `uploaded → processing → ready → needs_ocr_review → failed`, failure_detail, created/updated. The upload/management page reads this table.
- `source_agents` — id (text agent_id as today), owner uuid, document_id → documents, card jsonb, card_digest, extraction_status, source_hash, agent_version, created/updated. Mirrors `LocalAgentManifest` minus private paths.
- `agent_artifacts` — agent_id, kind enum (`original|markdown|chunks|embeddings|extraction_report|private_key`), storage_key, byte size, sha256. **Artifact references are opaque storage keys, never filesystem paths** (fixes the absolute-path fragility found in the Phase-1 rename). Private keys may live here (service-role-only row policy) or in a `agent_keys` table; either way no plaintext key ever reaches a client.
- `conversations` — token (the opaque `conv_…` id as pk), owner uuid, input_fidelity_policy, last_sequence, created/updated.
- `conversation_agents` — conversation token, agent ref jsonb snapshot, joined_at_sequence, last_delivered_sequence (the per-agent cursor).
- `conversation_events` — conversation token, sequence (unique per conversation), event jsonb (exact `ConversationEvent`), append-only (no update/delete grants). The JSONL stream becomes an append-only table; the event stream remains the state.
- OAuth: `oauth_clients` (dynamic registration), `oauth_authorization_codes`, `connector_tokens` (access + refresh, hashed) — copy dm_sum's shapes.
- `pilot_limits()` function + per-account counters (documents ingested, agent invocations/day, storage bytes) — dm_sum's metering pattern.
- `export_audits` + `operator_audits` — member-visible audit rows for any operator/content access or export ("if we ever look, you see that we looked").

**Tenant isolation:** every content table carries `owner` and an RLS policy `owner = auth.uid()` for authenticated reads where applicable; the hosted layer runs service-role but **scopes every query by the account resolved from the bearer token** (dm_sum pattern: token → account → handler bound to that account). The kernel's per-agent `agentId` evidence isolation stays as the second wall. Live RLS tests prove cross-account reads fail.

## The store and artifact access

- `src/hosted/supabaseStore.ts` implements **`ConversationStore`** (`src/core/storage.ts`) bound to one account: manifests from `source_agents`+`agent_artifacts`, conversations/events from their tables, `appendConversationEvent` as insert with sequence uniqueness enforcing the no-gap/no-rewrite contract at the DB layer.
- **New core seam needed:** `LocalSourceAgent`/retrieval currently read artifacts via `fs` paths on the manifest. Introduce an `ArtifactReader` interface (read chunks JSONL, embeddings JSONL, private key PEM) injected into the product layer; `LocalArtifactReader` wraps today's fs behavior (open kernel unchanged), `SupabaseArtifactReader` streams from Storage with a small in-function cache. Manifest `privateArtifacts` values become reader-scoped keys.
- Signing keys: generated at ingestion (as today), stored service-role-only, read only inside the invocation path.

## MCP endpoint + OAuth

Mirror `dm_sum/src/hosted/mcp.ts` + `oauth.ts`:

- `@modelcontextprotocol/server@2.0.0-alpha.2`, `WebStandardStreamableHTTPServerTransport`, one shared transport, `AsyncLocalStorage<Request>` carrying the authenticated request into tool handlers.
- Tools: the same six `suminar_*` tools, built from the existing `createSuminarMcpServer` factoring — the hosted entry constructs the service per request with the account-scoped `SupabaseStore` and hosted `ArtifactReader`. (Refactor note: `createSuminarMcpServer(service)` already takes the service; hosted needs per-request service resolution — either rebuild server per request as dm_sum does with its handler indirection, or parameterize tool handlers by a `currentService()` lookup through AsyncLocalStorage. Follow dm_sum's `currentHandler()` shape.)
- OAuth: in-house AS — `/.well-known/oauth-protected-resource` + `/.well-known/oauth-authorization-server` metadata, dynamic client registration, `authorization_code` + `refresh_token` grants, bearer header only; 401 responses advertise the metadata so Claude/ChatGPT connector flows discover it. Login page = Supabase Auth (email) rendered by the oauth function.
- Rate limits per token/IP (dm_sum `ratelimit.ts` pattern; fail-open protection, fail-closed mutation).
- Hosted inference: `OPENAI_API_KEY` from Vercel env (house key), model per `SUMINAR_OPENAI_MODEL`; invocation counts metered against `pilot_limits`.

## Ingestion pipeline

**Runtime decision (2026-07-13): extraction runs as a Vercel Python function using PyMuPDF.** Chosen for two-column reading-order fidelity, which is load-bearing for a product whose promise is faithful scholarly representation. Note the deliberate divergence: the open-kernel local pipeline (`scripts/ingest_pdf.py`) uses `pypdf`; the hosted function (`api/extract.py`) uses PyMuPDF — a hosted quality upgrade, not a kernel change. OCR stays on the Mistral **API** (no ML models bundled in any function), so the extraction function is lean (PyMuPDF + python-docx only).

- Upload API (`/api/documents`, `src/hosted/documents.ts`): auth required. **Direct-to-Storage (v1.0.18):** `POST /documents/upload-url` mints a Supabase signed upload URL; the browser PUTs the original straight to Storage (`{owner}/originals/{id}.{ext}`), bypassing the ~4.5 MB function request-body limit that a through-function upload hits; `POST /documents/register` re-derives the key from owner+documentId, downloads the object once for an authoritative byte size + sha256, inserts the `documents` row (`uploaded`), and processes inline. Per-file ceiling is the `artifacts` bucket's **50 MiB** object-size limit (verified live). The legacy through-function `POST /documents` (multipart, ≤ the same cap but bounded by 4.5 MB at the edge) remains for small files / API clients. The `documents` status enum already models the async swap for later.
- Extraction function (`api/extract.py`): **stateless and secret-free** — it fetches the source from a short-lived Storage **signed URL** (avoids the 4.5 MB function-body limit and keeps Storage/DB creds out of Python), runs PyMuPDF (pdf) or python-docx (docx), and returns `{agentId, sourceHash, extractionStatus, markdown, chunks}` as JSON. Guarded by a shared secret header (`SUMINAR_EXTRACT_SECRET`). Chunking mirrors the kernel's `build_chunks`, so chunk IDs and shapes match. `.docx` converts near-losslessly (structured text, never OCR); the whole doc is one page.
- Node orchestration (`HostedIngestionService`): mint signed URL → call the function (`HttpExtractor` when `SUMINAR_EXTRACT_URL` is set; else the local `pypdf` shell path for dev/self-host) → generate the signing key (Node crypto), embeddings (house OpenAI key), and card in Node → upload derivatives to Storage → write `source_agents` + `agent_artifacts` rows → flip `documents.status`.
- Status transitions written to `documents`; `needs_ocr_review` surfaces the Mistral OCR retry as an authenticated action.
- **Deploy spike (gated on Vercel access):** confirm the PyMuPDF wheel deploys on a Vercel Python function; if it resists, the documented fallback is a TS port (`unpdf`). Wiring `HttpExtractor` into `HostedIngestionService` and this spike happen together in the deploy step, since the HTTP path can only be exercised against a deployed function.

## Structural-trust suite (properties, not promises)

Three layers (dm_sum: "the suite is the contract"): contract/unit tests (existing 37 + hosted units), **drift tests** (public claims pinned to code: tool catalog ↔ registered tools, limits page ↔ `pilot_limits`, connector guide ↔ OAuth metadata), **live tests** (BEGIN…ROLLBACK against the real database: RLS cross-account denial, append-only event stream, content-blind admin — the admin surface's migrations must reference no content-bearing column, enforced by a migration-shape scan). `/version` names the deployed commit. No client-side analytics. No-E2EE stated plainly (agents read derivatives server-side). Export path: originals + derivatives downloadable by their owner (the leave-ability property), with member-visible audit rows.

## Increment order (each gate: check, tests, existing smokes stay green)

1. **Migrations + SupabaseStore + ArtifactReader seam** — kernel tests keep passing with `LocalStore`/`LocalArtifactReader`; new hosted unit tests; live RLS tests once the project exists.
2. **OAuth + hosted MCP endpoint** — connector connects from Claude; the six tools work against a seeded account.
3. **Upload API + ingestion worker (.docx included)** — document lifecycle end-to-end; management API (list/status/rename/delete/OCR retry).
4. **Limits + audits + trust suite + /version** — drift and live layers.
5. **Deploy to Vercel** (needs Vercel connector re-auth in Dave's claude.ai settings, or `npm i -g vercel` CLI), wire domain later in Phase 3.

## As built — Increment 4 (2026-07-14)

Invite-only launch hardening, shipped as four migrations plus the hosted wiring:

- **Pilot limits + metering** (`pilot_limits()`, `invocation_usage`): 200 invocations/day, 2000/30d, 50 documents, 1 GiB stored sources, 50 MiB per upload — BEFORE INSERT triggers, so the service-role layer and any future authenticated path share one gate. The MCP invocation path reserves a usage row before the model call (fail closed) via `MeteredLocalInvoker`; `createSuminarConversationService` gained `wrapLocalInvoker` for that seam. `src/hosted/limits.ts` is the TS mirror drift tests pin.
- **Invites + waitlist**: `invite_codes` (hash-at-rest, per-issuer active cap, `issue`/`redeem`/`preview` functions, FOR UPDATE serialization), `waitlist` (anonymous, enumeration-proof, capped), `POST /waitlist`.
- **Operators + audits + admin**: `operators` (Dave seeded), `require_operator`, content-blind `admin_overview` (aggregates + account metadata only; migration-shape scan enforced), `export_audits` + `operator_access_audits` (owner-readable). HTTP surface `/admin/*`: overview, account provisioning (connector token returned once), invite issue/revoke, waitlist bookkeeping. `GET /documents/:id/export` releases signed URLs for the original + derivatives (never signing keys) only after the audit row lands.
- **Rate limits**: `check_rate_limit` fixed-window counters behind MCP (account-keyed), OAuth doors (IP-keyed), uploads/exports, admin, waitlist; fail-open, `SUMINAR_RATE_*` tunable.
- **Trust suite**: `docs/hosted-trust.md` is the public claims page of record; `tests/hosted-trust.test.ts` pins claims to code (limits, tool catalog, quotation stack, audits, /version, discovery routes, no-analytics); `tests/hosted-trust.live.test.ts` proves caps, RLS scoping, private-key invisibility, operator gate, and the counter against the real project (service key gates it; anon key additionally gates the RLS-as-authenticated block).

## Open items

- **Supabase project**: org `docgotham's Org` has three active projects; a new project costs **$10/month**. Awaiting Dave's confirmation to provision `suminar` (recommended: dedicated project — Supabase Auth is project-global, so sharing dmsum-hosted-mvp would entangle two products' user pools).
- Vercel access for deployment (connector re-auth or CLI install) — needed at increment 5, not before.
- suminar.ai DNS → Vercel at Phase 3.

## As built — Phase 3 (2026-07-14, v0.11.0 → 1.0.0)

Everything below shipped after the Increment 4 census above, live at
suminar.ai (domain attached to the Vercel project; apex canonical).

- **Public site** (`site/`, `outputDirectory` seals static serving to it —
  the framework-null deploy had served the repository root until then):
  Lapis-brand landing with the canonical-block hero, trust section quoting
  `docs/hosted-trust.md`, waitlist form, self-hosted OFL fonts (Source
  Serif 4 reserved for source speech; Instrument Sans elsewhere), og card.
  Brand spec of record: `docs/brand.md`.
- **Account surface** (`src/hosted/account.ts` behind `/api/account/*`):
  invite-redeeming signup (preview → create → redeem with compensating
  delete; first connector token shown once), token list/mint/revoke (mint
  accepts email+password as the lost-token recovery path), friend invites,
  usage mirror counting the same rolling windows the enforcement triggers
  count. Pages: `/account` (token-gated dashboard) and `/account/redeem`.
- **Dashboard** as annotated bibliography: MLA citation lead (verbatim
  supplied citation supersedes derivation), annotation subline with
  provenance tier, filename demoted to provenance microtext, per-row
  disclosure carrying actions and feedback, utility rail (tokens, invites,
  usage) beside the shelf.
- **Naming and annotations**: `naming.ts` (MLA derivation, inversion-safe
  authors, per-owner uniqueness enforced at persist) and `annotation.ts`
  (supplied > mined > composed; structural page-skip for book front matter;
  gpt-5 drafting endpoint returns unsaved drafts approved into the supplied
  tier via reprocess-metadata, which doubles as rename/retitle).
- **Syndication** (migration `20260715090000`): `agent_syndication_codes` +
  `agent_syndication_grants` (service-role only, cap triggers in
  `pilot_limits()`), endpoints under `/api/account/syndications`, and the
  one store aperture — `SupabaseStore.listLocalAgentManifests` /
  `getLocalAgentManifest` union active grants, rewriting only the handle
  (card origin is a URL by schema and custody genuinely does not move).
  No-export is structural: the grantee owns no artifacts. Proven live with
  a two-account E2E including a cross-tenant MCP invocation.
- **Transport hardening**: `/mcp` is POST-only — GET/DELETE return 405
  ahead of auth and rate limiting (a 429 on the SSE probe once reconnect-
  stormed a conformant client into reporting the server dead).

## As built — Phase 4 (2026-07-16, auto-identify metadata, 1.0.11 → 1.0.14)

- **Metadata identification** (`src/suminar/metadata.ts` `deriveMetadata`):
  most-trusted evidence first — gpt-5 extracts title/authors/year/DOI from the
  document's own front matter (grounded, decoy-rejecting), a Crossref lookup
  authoritatively refines a DOI'd work, and a scoped web search (GA
  `web_search` tool, reasoning-effort capped so it does not starve the answer
  budget) fills only a *missing* date, anchored on the known title/author. Per-
  field provenance (document / crossref / web / manual); an ungrounded field
  stays blank, never fabricated. `SourceIdentity` gains `publicationDate`
  (display date; `year` stays the handle/sort key) and `metadataProvenance`.
- **Endpoints**: `POST /documents/:id/identify` (derive + auto-apply, re-
  derives the handle; own `identifyPerAccount` budget) and `POST
  /documents/:id/metadata` (inline field edit, stamps `manual`, handle
  slugified + uniqueness-checked). Both route through
  `HostedIngestionService.updateAgentMetadata` — a card-only rewrite (no re-
  extraction/re-embedding), the lightweight primitive the full-reprocess path
  is too heavy for.
- **Dashboard**: per-source inline editor (title / authors / year / publication
  date / @handle) with live handle-slug preview and provenance chips; auto-
  identify default-on per upload; prompt-based Rename retired.
- **Proven**: clean-room DOI PDF → Crossref-authoritative in ~9s; dateless
  essay → web date (`2015-08-11`) in ~18s; inline-edit save path 10/10.
  Regression tests in `tests/metadata.test.ts`.
- **Known nuance (open for Dave):** `Re-identify` always re-derives the handle,
  so it overwrites a hand-customized one. Auto-identify (the dominant path) is
  correct; preserving a manual handle across re-identify would need handle-
  provenance tracking. **Also pending:** a trust-doc line disclosing that
  identify sends public bibliographic facts (DOI/title/author) to Crossref and
  OpenAI web search — no private content leaves, but honesty favors saying so.
