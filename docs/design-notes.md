# Design notes — agreed direction, not yet implemented

Working notes for any agent (Claude, Codex, or other) picking up Suminar.
Each entry records a Dave-approved design direction with its rationale, so
the reasoning survives across sessions and tools. Implementation of an entry
should end with its removal from this file (the code and AGENTS.md become
the record).

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
## Known limitation: long-turn latency vs host client timeouts

A worst-case source-agent turn (several retrieval rounds at medium
reasoning, ~100s; longer if the service-level retry fires) can exceed a
host MCP client's request timeout. Observed 2026-07-15: a 103-second
discourse-shaped turn completed and stored its canonical answer, but the
calling client had timed out at ~60s and showed an error. The room state
stays consistent — the answer is in the conversation and later agents
see it — but the host that timed out never displays it, and there is no
re-display mechanism (hosts do not re-read past canonical turns; the
messageId arrives only in the response that timed out). ChatGPT waited
2.7 minutes happily; timeout budgets vary by host. Candidate mitigations
when this bites in practice: skip the service-level retry when the first
attempt already consumed most of a typical client budget; a recovery
affordance that lets a host fetch undisplayed canonical turns since its
cursor; or per-deployment round/effort tuning. Deferred until a real
host shows the failure more than rarely.
