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

**Increment 2 (SHIPPED, 1.0.34):** the seminar page — click a seminar (home
row or live-strip title) → `#sem=<id>` → its canonical record, live: every
source-agent turn exactly as authored (📄 badge + handle chip per turn;
minimal safe markdown rendering — paragraphs, bullets, bold, italics — built
from DOM nodes, never innerHTML), user/host turns labeled, timestamps.
Header = title + rename (✎ relocated here; home list is pure navigation) +
participant chip strip; the full shelf stays one tab away. Reads:
`GET /api/account/seminars/:id?after=<seq>` — delta-fetched (poll 15s while
visible + on focus), tokens resolve server-side and never leave, envelopes/
hashes not shipped to the client; runs on its own rate rule
(`seminarsPerAccount`, 600/hr default, SUMINAR_RATE_SEMINARS_PER_HOUR) so
polling never eats the account-operation budget. Later rungs: per-seminar
works-cited export, provenance/signature panel, markdown transcript export.

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

## STANDING CONSTRAINT: platform-agnosticism (Dave, 2026-07-16)

Every Suminar product surface must be agnostic to proprietary chat platforms.
**Hosts are viewports and conduits; the seminar record is the durable,
first-class artifact, and it belongs to the account, not to any host.** A
user must be able to (a) continue one seminar across different hosts
(ChatGPT today, Claude tomorrow), (b) take every seminar with them if they
abandon a platform entirely, and (c) trust that nothing durable lives only
inside a host. Already true for sources, agents, identity, the record, and
the companion; the one violation is the conversation continuation token
living in a single host's working memory. Corollaries: transcript export is
a *principle* (leave-ability covers conversations, not just documents), and
no future feature may store anything durable host-side.

## Seminar portability — Increment A (SHIPPED 1.0.38, 2026-07-16)

**Resume codes**: the companion's seminar page mints a short-lived, one-use,
hash-at-rest code (the invite/syndication pattern). The user pastes it into
any host ("Suminar: resume seminar with code XYZ"); a new MCP tool
`suminar_resume_seminar` redeems it and returns the conversation's
continuation state (token + cursor, standard private-continuation format)
plus a **recap payload** — a bounded verbatim tail of the record with turn
counts — so the resuming host knows where the discussion stands (agents need
nothing; they already read the room server-side). The MCP instructions'
boundary doctrine gains one amendment: a different host thread starts a new
conversation *unless the user presents a resume code*. Portability happens
by explicit user action carrying a visible code — never hidden linkage —
matching the explicit-@handle philosophy. The same primitive repairs
fragmentation: resuming INTO a seminar from the same host stitches a
token-dropped fork back to its record.

**Scope honesty for A:** redemption returns the *same* conversation token
(no rotation): conversations are keyed by token as primary key, so rotation
means a per-participant grants table — which Increment B needs anyway for
identity. Consequence: after a resume, both hosts hold valid tokens (serial
custody is user discipline, not server enforcement, until B), and an old
host's window simply won't show turns made elsewhere — the record is the
complete view (constraint above). Redemptions are one-use and logged.

## Multi-human seminars — Increment B (designed in depth 2026-07-17; DEFERRED — Dave decided not to build)

The direction stays ratified; the build is deliberately deferred. Everything
below is the resumable state of the design, settled in the 2026-07-17
discussion (grounded in a kernel read + a dm_sum recon).

The shape: the same capability-code primitive with a different redeemer —
the convener mints an **invite** and another account joins the seminar as a
human participant, addressable by @handle, speaking through their own host.
Agents already read the whole room; the record already interleaves speakers.

**The four open questions, as they converged:**
1. **Attribution — SETTLED.** Server-stamped from the syncing credential,
   never host-supplied (today `speakerDisplayName` defaults to "User").
   Requires conversation_participants (conversation_agents generalized) +
   per-participant tokens — which retroactively delivers A's missing token
   rotation/revocation. dm_sum proves the pattern (see porting map).
2. **Bidirectional sync — DESIGN SETTLED, still the novel/risky build.**
   Key finding: **adjacency carries causality today, by lock** — the
   single-flight invocation lock guarantees an answer lands adjacent to its
   address; two writers dissolve that guarantee, and the sync kernel is
   strictly single-writer (append at exact head or "gap"; occupied sequence
   = "history conflict"). B2 therefore means: server-assigned sequences;
   every canonical answer event gains an explicit **in-reply-to link**
   (sequence + participant of the address it answers) so causality is
   written down, not inferred from position; **seat, not mirror** delivery —
   a host thread is its human's seat at the table, not the room: own
   exchanges in full, others' activity as *mechanical notices* (names,
   counts, pointers — never content), verbatim blocks fetched on demand;
   the companion renders the braid (reply-links as threading cues).
   Standing principle: **the kernel never paraphrases a human** — a
   server-side summarizer would be a fourth voice in the room; inventory is
   arithmetic, understanding happens host-side on request. Conduct layer:
   "never paraphrase the other human" whispers + eval cases (dm_sum's
   retelling-style display contract is the opposite doctrine and previews
   the default host failure mode). Concurrency posture: two scholars are
   mostly serial; concurrent writes must be SAFE (lock-before-check), not
   the optimized primary path.
3. **@human addressing is correspondence, not invocation — unchanged.**
   Async delivery, companion as notifier; no agent-like latency promised;
   existing address modes extend to human targets.
4. **Convener semantics — one open product call remains: join friction.**
   Invoker-pays (ratified) implies the invitee needs an account + connector
   before speaking. Recommended resolution: account-required-but-free-to-
   join, invite doubles as a pilot pass. Exit rights are two-party and
   **require transcript export to exist** (leave-ability), which makes the
   queued markdown-export item a B deliverable, not a nice-to-have.
   Convener mints/revokes/renames; revocation = delete the grant row.

**Room vs desk (shared-seminar sync scope — settled 2026-07-17).** The
record only ever contains what a host submits; today's instruction is
"submit every visible turn" (full mirror), which is correct solo (thinking
aloud *is* the seminar; situatedness is the product) but wrong shared: it
surveils the other participant's desk, bloats the record (first-invocation
latency; 500-event/50k caps), and drowns the other seat in notices. Shared
seminars narrow the instruction to **sync the exchange, not the desk**: an
@-addressed turn, the answer, the visible follow-up to it, and explicit
hand-ins ("share this draft with the seminar"). Private host-chat between
exchanges is never submitted — it doesn't exist server-side. Consequence:
**addresses must carry their excerpts** (agents read only the record, so a
question about desk work quotes the passage it references — pages brought
to the podium); build work is instruction text + a fail-fast error when an
agent is asked about material the record lacks. Fail-soft both directions:
over-sync is visible and socially correctable; under-sync costs one agent
answer and the cure is inlining the excerpt. Solo seminars keep full
mirror — no regression.

**Rejected alternative (consciously):** per-exchange sub-threads/breakout
rooms. Kills the shared evidentiary ground — one room, one record is what
lets @rozado be asked about what @honeycutt just told the other human.

**Porting map (dm_sum recon, 2026-07-17; repo C:\Users\Dave\dm_sum).**
dm_sum solved participant identity well — port, don't reinvent: seat-first
participants (rows exist before identity binds, survive departure —
attribution never dangles); membership row IS access (delete = revoke, the
whole model); every write re-verifies the (room, participant, account)
triple in both the handler and the SQL RPC (spoofing structurally
impossible); owner-only invites, hash-stored, one-use, idempotent claim,
cap enforced under FOR UPDATE. dm_sum deliberately has NO cursors, NO
delivery, NO live sync (pull-based time-window activity views) — so B2's
multi-writer sync has no precedent in either repo. Their hardest-won lesson
ports anyway: **lock before check, in one global sort order** (their
check-then-lock race silently lost a write), plus dedupe keys with ON
CONFLICT DO NOTHING for any fan-out.

### A2 candidate — grant-based continuation credentials (the solo-valuable B1 subset)

The one part of B1 that improves the SINGLE-human architecture on its own,
buildable standalone and additive (no re-keying; conversations.token stays
PK): a `conversation_grants` table (hash-at-rest grant tokens, label,
last_used_at, revoked_at) resolving to the conversation. The MCP layer
accepts either a legacy raw token (existing threads unaffected) or a grant.
Resume redemption mints a NEW grant instead of returning the raw token —
serial custody becomes server-enforceable instead of user discipline,
closing A's documented scope-honesty gap; the raw token stops traveling.
Companion seminar page gains "connected hosts" chips (label + last-used +
revoke) — answering "who can write to this seminar" for the multi-host
solo workflow that Increment A already created. Events gain grant
provenance (which host carried which turn) — groundwork for the queued
provenance panel. Skip seats/invites/attribution-display entirely (dead
weight without a second human). Status: proposed 2026-07-17, awaiting
Dave's word.

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
