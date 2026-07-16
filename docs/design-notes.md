# Design notes — agreed direction, not yet implemented

Working notes for any agent (Claude, Codex, or other) picking up Suminar.
Each entry records a Dave-approved design direction with its rationale, so
the reasoning survives across sessions and tools. Implementation of an entry
should end with its removal from this file (the code and AGENTS.md become
the record).

## Bulk ingestion + the direct-to-Storage upload architecture (RESEARCHED, options for Dave — not yet approved)

**Prompt:** Dave wants to consider letting someone upload many PDFs at once.
Research done 2026-07-16 while he was out; this records findings + a
recommendation, pending his decision.

**The finding that reframes the whole thing.** Vercel serverless functions
have a ~4.5 MB request-body limit. The current upload streams file bytes
*through* `api/documents.js` (`request.formData()` → `arrayBuffer()`), so the
advertised "256 MiB per upload" (`limits.ts uploadMaxBytes`, and the site copy
in `site/index.html` + `site/account/index.html`) is **false**: a 6.2 MiB PDF
returns `413 FUNCTION_PAYLOAD_TOO_LARGE` at the platform edge, before the code's
own 256 MiB check runs (verified live against a throwaway). Today's 2 MB PDFs
work only because they're under 4.5 MB. **This is a latent bug worth fixing
regardless of bulk** — either correct the claim, or (better) remove the limit
by changing the upload path.

**The insight: the right way to build bulk is also the fix for large files —
move uploads OFF the function and DIRECT to Supabase Storage.** supabase-js
2.110 has `createSignedUploadUrl` / `uploadToSignedUrl` (confirmed present);
`content_sha256` is only stored, never used for dedup, so the server no longer
needs to see the bytes.

**Layer 1 — direct-to-Storage upload (fixes large files AND is the substrate for bulk):**
- `POST /documents/upload-url` → returns a Supabase signed upload URL + storage
  key for a filename/mime (validates mime; no bytes through the function).
- Client uploads bytes **browser → Supabase Storage** via `uploadToSignedUrl`,
  bypassing the 4.5 MB limit (up to Storage's own, far larger, ceiling).
- `POST /documents/register` → `{ storageKey, filename, mime, metadata? }`
  creates the `documents` row (hash lazily or drop it) and kicks
  `processDocument` (extract + embed) exactly as today; `/identify` then runs
  per source as now.
- Independently shippable for the *single*-file path first: fixes the large-PDF
  bug with no UX change, and makes the 256 MiB claim true.

**Layer 2 — bulk orchestration on top:**
- **Option B (client-orchestrated, bounded concurrency) — RECOMMENDED FIRST.**
  `<input multiple>` / drag-many → per file: get-url → direct-upload → register
  → identify, ~3 concurrent. Per-file progress (queued → uploading → building →
  identifying → ready / failed); partial failures isolated; every source lands
  in the shelf with identified metadata + provenance chips ready to correct.
  Reuses the entire proven pipeline. Tab-bound (a dozen ≈ a few minutes with
  concurrency) with a "keep this tab open" note.
- **Option D (server-durable queue) — LATER, only if users bulk-upload big
  batches.** Register all as `queued` rows fast, drain with a worker (Supabase
  Edge Function + pg_cron, or Vercel Cron). Survives tab close. Heavier; not
  pilot-necessary, and Suminar has no worker tier today (pure Vercel+Supabase).

**Constraints bulk must respect:**
- Rate limits: `upload` 40/hr, `identify` 40/hr → a dozen is fine; a 40+ batch
  hits the ceiling. With direct-to-Storage the register call is cheap, so
  re-budget (a dedicated bulk/register limit) or gate batch size.
- Per-file cost is unchanged (~10-20 s build + ~30-60 s identify); bulk is the
  client iterating, and concurrency cuts wall-clock ~3×. No 300 s risk (each
  register+process is a single file).

**Recommended sequence:** (1) ship Layer 1 direct-to-Storage for single upload —
fixes the large-file bug, corrects the 256 MiB claim, no UX change; (2) add the
multiple-file client orchestration (Layer 2 Option B) on top; (3) defer the
durable queue until a real user needs to close the tab mid-batch.

## Host over-deliberation: terrain fixes, never disposition fixes

**The incident (2026-07-14, live seminar):** the host described an @handle
question the user *could* ask instead of registering it as a proposal; the
user's "good. pose it." then landed on a state no affirmative could ratify,
and the host agonized for ~two minutes before repairing correctly. The state
machine converted host imprecision into latency instead of integrity loss —
acceptable, but the latency is worth engineering away.

**Dave's constraints (all agreed):** do not add "ask clarifying questions"
instructions (fights a high-reasoning host's trained autonomy, and the host
discovers ambiguity mid-inference, too late to interrupt); do not add
front-end classifiers (Rube Goldberg). Everything below is kernel text and
error copy — whisper-grade, zero new components.

**Three terrain moves, in order of leverage:**

1. **Prevent the ambiguous state at authoring time.** A standing line in the
   address/sync tool-result hostConduct notices — read at composing time,
   which is *before* the ambiguity gets created: if your reply will contain
   an @handle-led question you authored, register it with
   proposed_host_address in the same call; an unregistered suggestion
   creates a state no affirmative can ratify.

2. **Fail-fast tool errors are the clarifying question.** A reasoning model
   cannot be interrupted, but its first cheap action can return the
   information that ends deliberation (act → observe → adjust is the
   tendency being channeled, not fought). When an affirmative arrives with
   no registered proposal, the error should state the exit: "No proposal is
   registered. If your previous visible message contained an @handle
   question, deliver it now with visible_host, quoting yourself verbatim."
   Evidence the channel works: hosts comply immediately with the failure
   contract and handle-collision refusals.

3. **Name the safe harbor (Dave's favorite).** The host may agonize partly
   because the quick disambiguating question ("send it as written?")
   pattern-matches to the banned service-menu offer. One contract sentence
   dissolves the fear without instructing anyone to ask: *a one-line
   clarifying question about the user's own instruction is a participant's
   move, not a service offer.* Redirection by permission — it removes a
   rule-shaped fear rather than adding a rule.

**Measure, don't assume:** the host-conduct eval harness already carries the
two cases from the live transcript (coaching-instead-of-proposing;
affirming-an-unregistered-suggestion). Take base rates before and after the
kernel edits.

## Mention is not address: the @handle dual register

A host will sometimes name a source agent only to *comment* on what it said
("@sowell-affirmative-action takes a harder line above") — no draft, no
delivery intent. The terrain moves above must not pressure such mentions
into proposal registration, or hosts will either over-register or stop
referring to agents at all.

**Prior art — the CRCH Zulip Academic Bots prototype
(CodexProjects/crch-zulip-bot) solved this with two explicit conventions:**

- **Position carries the summons.** `extract_leading_mentioned_bot_names`
  responds only to @-mentions at the head of a message's first line;
  interior mentions never trigger a reply.
- **Register carries the reference type.** Every bot charter: use @-format
  when referring to a *participant's in-thread speech* ("Earlier in this
  thread, @**Michael et al. 2023** said …"), and the bare scholarly name
  when citing the *work as literature* ("… but Khan et al. 2024 argues").
- (It even carried a TODO for bot-to-bot @mentions with per-cycle reply
  budgets — Suminar's cross-agent addressing, prefigured.)

**Mapping to Suminar:** the leading-position convention is already latent in
the product — current_user mode requires the user's message to *begin with*
each selected @handle. Extend the same rule to host speech and to the
whisper in terrain move 1: the registration pressure keys on **@handle-led
authored messages** (address-shaped), never on interior mentions. Optionally
adopt the register nuance in the conduct contract: refer to the agent's
in-conversation speech by @handle, refer to the work itself by its
display-name citation ("Sowell's Affirmative Action Around the World
argues…"). Note the prototype had no host agent, so the host-side register
is new ground — evaluate with the same harness cases.
## Known limitation (residual): a single slow attempt vs host client budgets

Mostly addressed in 1.0.4 after the failure bit twice in one real ChatGPT
thread (2026-07-15): every synchronization now resupplies the last three
canonical turns under a conditional display contract (the host skips
blocks already visible, displays any that are missing), so an answer
whose response the client abandoned heals on the next call — including
the failure and proposal result shapes. A slow-retry cutoff (45s) keeps
the service-level retry from pushing calls past observed client budgets
(~45-60s). The residual: a single generation attempt can still run
~100s at medium reasoning and outlive an impatient client — that turn's
answer lands and heals one exchange later, but the user sees a transient
error first. If that residue proves annoying in practice, the
protocol-correct fix is SSE progress notifications on the POST response
(MCP clients reset their timeout on progress) — weigh against the
deliberately pinned JSON transport (see the 2026-07-14 SSE bug history)
— or per-deployment round/effort tuning.
