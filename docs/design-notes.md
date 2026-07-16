# Design notes — agreed direction, not yet implemented

Working notes for any agent (Claude, Codex, or other) picking up Suminar.
Each entry records a Dave-approved design direction with its rationale, so
the reasoning survives across sessions and tools. Implementation of an entry
should end with its removal from this file (the code and AGENTS.md become
the record).

## Bulk ingestion — multiple-file orchestration on the direct-to-Storage substrate (Layer 1 SHIPPED; bulk NOT yet built)

**Prompt:** Dave wants to consider letting someone upload many PDFs at once.
Researched 2026-07-16; **Layer 1 (the direct-to-Storage single-file path)
shipped 2026-07-16 (v1.0.18)**. Layer 2 (the bulk UX on top) remains an open,
Dave-pending design — recorded here so the reasoning survives.

**Layer 1 — direct-to-Storage upload — SHIPPED (v1.0.18).** The through-function
upload (`POST /documents`) capped at Vercel's ~4.5 MB request body, so large
PDFs `413 FUNCTION_PAYLOAD_TOO_LARGE`'d at the edge before our code ran (the old
"256 MiB per upload" claim was false — nothing over ~4.5 MB uploaded at all).
As built:
- `POST /documents/upload-url` mints a Supabase signed upload URL (owner-scoped
  storage key; no `documents` row yet; metered under `uploadPerAccount`).
- Browser PUTs the file **direct to Storage** (multipart body, token in the URL,
  no Supabase credentials in the client), bypassing the function body limit.
- `POST /documents/register` re-derives the key from owner+documentId (never
  trusts the client, so one owner can't register another's object), downloads
  the object once for an authoritative `byte_size` + `content_sha256` and to
  confirm it landed, inserts the row, then runs the same extract/embed/persist
  path; `/identify` runs after, unchanged. Ungated (only follows a metered
  signed URL; a re-register trips the primary-key guard). A rejected insert
  removes the object so nothing orphans against the storage quota.
- **Real per-file ceiling is now 50 MiB** — the `artifacts` bucket's object-size
  limit (verified live 2026-07-16: 46.7 MiB accepted, 52.5 MiB rejected with
  "object exceeded the maximum allowed size"). `uploadMaxBytes`, the trust doc,
  and the site copy were corrected 256 MiB → 50 MiB. Raising it later means
  bumping the bucket's `file_size_limit` (dashboard/API) AND watching the
  register download's memory (it pulls the whole object into the function to
  hash). The `20260715220000_upload_ceiling_50mib.sql` migration lowers the DB
  trigger cap to match; apply it in prod when convenient (the bucket binds
  first, so behavior is already correct).
- The old through-function `POST /documents` stays for small files / API clients.

**Layer 2 — bulk orchestration on top (NOT built; Dave-pending):**
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

**Recommended sequence:** (1) ✅ DONE — Layer 1 direct-to-Storage for single
upload (v1.0.18): fixed the large-file bug, corrected the ceiling to the real
50 MiB, no UX change; (2) add the multiple-file client orchestration (Layer 2
Option B) on top; (3) defer the durable queue until a real user needs to close
the tab mid-batch.

## The companion surface (Dave-approved 2026-07-16; increment 1 SHIPPED, increment 2 open)

**The pattern.** Suminar has no chat surface by design — the host thread is
the conversation. The flip side: Suminar's own window is free to be the
*instrument panel beside the seminar*. Dave's observed workflow (chatbot
window left, Suminar window right, copy @handles across) is the architecture
made visible. Guardrails: the companion must be a **plain URL** (works in any
browser window or embedded webview; no host-ecosystem coupling — explicitly
NOT a Claude artifact), and it stays **instruments, not dialogue** — it may
prepare speech (copy chips, composed @prefixes) but never deliver it (no send
button; that would recreate a second chat surface and the broadcast
temptation).

**Ontology.** *Shelf* = your sources. *Seminar* = one host thread's
conversation: named (derived-by-default from the first user turn + date;
owner rename wins forever; empty rename reverts), publicly identified by
`conversations.id` uuid (tokens are credentials and never appear in URLs),
with a canonical record. *Companion* = the URL presenting both, narrow-first.

**Increment 1 (shipped, 1.0.31):** `/companion` — filter-as-you-type palette
(styled citations, copy chips, status dots, no admin actions), named seminar
list (LIVE badge when recently active; zero-agent-turn conversations — sync
stubs and token-loss husks — hidden behind "show all"), inline rename.
Owner-scoped `GET /api/account/seminars` (via `list_seminars()` SQL,
migration 20260716200000) + `POST /api/account/seminars/:id/title`. Account
page gains "Companion ↗" (window.open) and hands the session token to the
companion over same-origin postMessage — credentials never ride URLs.
Refresh: on focus + 60s while visible (stays inside accountPerOwner budget).

**Increment 2 (open):** the seminar page — click a seminar → its canonical
record, live-updating: every source-agent turn exactly as authored (badge,
styled titles, citations), healing host-side display lossiness (orphaned
answers, stripped badges). **Header = title + rename + participant chip
strip** (Dave, 2026-07-16): the page carries its own people as copy chips in
the header and needs no palette of its own — the full shelf stays one tab
away. **Renaming lives here**: the record view is where a seminar is managed;
the companion-home list becomes pure navigation and its interim ✎ relocates
here. Needs an owner-scoped events read (seminar id → ordered canonical
turns; tokens stay server-side). Later rungs: per-seminar works-cited export,
provenance/signature panel, markdown transcript export.

**The live strip (shipped 1.0.33):** "current seminar" is not a selection —
liveness IS the signal. While a seminar's record is growing (updated within
~3 min), its participants pin automatically to the top of the Shelf tab as a
labeled chip strip, and fade when it goes quiet. This is the selection-free
resolution of "pin my current seminar's agents": no cross-tab hidden state,
no mode to forget, the pinning driven by reality. Seminars with no seated
agents pin nothing.

**Scale plan (implemented 1.0.32):** the shelf must survive 300 sources —
search-first, not scan-first. The companion is two TABS (Shelf | Seminars,
one tap apart at any shelf size; last tab persisted; live dot on the
Seminars tab when a record is growing), and the unfiltered palette shows only
the ~15 most recent sources ("Showing 15 of N — type to search the rest, or
Show all"); typing always searches the whole shelf. Future recency upgrade:
order by last-invoked rather than last-uploaded once usage data is worth
reading.

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
