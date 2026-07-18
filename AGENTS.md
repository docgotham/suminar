# Suminar repository contract

## Before changing the project

1. Run `git status --short --branch` and preserve existing user or agent changes.
2. Read this file completely.
3. Read `README.md` completely before changing architecture, prompts, MCP tools, ingestion, quotation behavior, conversation synchronization, or federation.
4. Read `docs/design-notes.md` before touching host-conduct kernel text or the address/proposal state machine — it records Dave-approved design directions (with rationale) that are agreed but not yet implemented.
5. Family law lives outside this repo: the family-level ontology, grammar (@/#/[[...]]), identity model, and Companion conventions are at `C:\Users\Dave\Katamari\wiki\topics\Sum Family Ontology and Conventions.md`. Read it before family-level design work, and update it (and its `updated:` date) in any session that changes a family convention. Product law stays here.
6. Preserve private-source isolation and canonical authorship ahead of convenience.
7. Keep changes inside this repository unless the user explicitly names another project. FlightBot, Zulip, Omni-American Commons, dm_sum/Mem·Sum, and earlier Agent·Sum repositories are references, not mutation targets.
8. Never expose, commit, copy into tests, or print private source artifacts, runtime data, or secrets.
9. Use `apply_patch` for hand edits and preserve unrelated user changes.
10. Run the verification sequence at the end of this file.

This is a TypeScript ESM project requiring Node.js 24 or later. Python supports PDF extraction and optional OCR. The package and MCP server version is `1.0.0` (the hosted launch); the public federation envelope remains `agent-sum/0.1`.

## Product, framework, and naming layers

**Suminar** is the product: academic books and journal articles as situated source agents in the user's existing chat. **Agent·Sum** is the general framework Suminar is built on and remains the protocol's name. The naming split is intentional and must be preserved:

- **Stays `agent-sum` (protocol layer, interoperable across future Agent·Sum verticals):** the federation envelope version `agent-sum/0.1`; the well-known card path `/.well-known/agent-sum.json`; the attestation and internal `_meta` namespaces `agent-sum/user-message-v1`, `agent-sum/conversation-events-v1`, `agent-sum/internal`; the local origin scheme `agent-sum-local://`.
- **Is `Suminar` (product surface):** the MCP server name and `suminar_*` tool names; all host- and user-facing prose, instructions, titles, and error messages; `SUMINAR_*` environment variables; the package name, bins, repository name, dashboard, and launcher branding.

Do not rename protocol identifiers to the product name or vice versa. When adding a new identifier, decide its layer first: if a second Agent·Sum vertical would need to share it, it is protocol; otherwise it is product.

**The code carries the same seam.** `src/core/` is the framework layer (types, schemas, crypto, storage contract, conversation runtime, federation) and must never import from `src/suminar/`. `src/suminar/` is the product layer (MCP surface, representatives, retrieval, ingestion, config, dashboard) and wires itself into core through `src/suminar/service.ts`. Entry points live at the `src/` root. `ConversationStore` in `src/core/storage.ts` is the persistence contract: `LocalStore` is the open-kernel single-tenant implementation, and the hosted multi-tenant store implements the same interface. Suminar is an open kernel: the local mode is the self-hostable software; hosted Suminar is the same kernel operated as a service.

## Version-one product model

Suminar supplies situated source agents to an existing Claude, ChatGPT, Perplexity, or other MCP host conversation. The host thread is the conversation boundary. MCP is the version-one conversational integration surface. Do not add a Zulip adapter, rooms, panels, chair modes, `@all` routing, or a second chat ontology to version one.

The user, host chatbot, and invoked source agents are participants in one visible conversation. The host has privileged administrative abilities—synchronizing visible speech, selecting agents, transporting updates, verifying responses, and rendering canonical messages—but is not the source agent's supervisor or private interpreter.

The host is fundamentally a conversational partner, not an emcee, presenter, custodian, curator, or explainer of source-agent speech. Its ontology is: a participant with privileged transport capabilities, not a transport operator with permission to participate. Transport is one of the host's capabilities, never its conversational identity, and transporting another participant's turn does not create a duty to frame, summarize, certify, evaluate, or restate it. The host contributes afterward only as itself when addressed, asked for analysis, or able to add something genuinely independent and material. When the host wants a source-agent follow-up, it authors the follow-up as its own visible `@handle` proposal for the user to ratify; it never offers its transport services as a menu. A short ratification cue attached to an authored visible proposal is part of the proposal, not a menu.

## Conversation event contract

- Every host thread that uses Suminar has one opaque conversation token and monotonically increasing event sequence.
- Tokens and cursors are private continuation state and must never appear in ordinary user-facing output. They may appear under a machine-use-only marker in MCP tool-result text when a host cannot consume typed structured output; the host must copy them exactly into the next tool call and exclude them from its visible answer.
- A different host thread starts a fresh token at cursor zero. No conversational memory crosses tokens unless the user explicitly imports visible prior speech.
- Once active, the host synchronizes at the start of every new user turn.
- The sync contains every completed visible user or host contribution after the acknowledged cursor, in order. Ordinarily this is the previous completed host response plus the current user message.
- On first use, synchronize the complete visible host-thread history available to the host.
- Suminar records canonical source-agent messages itself, and likewise records host addresses created through the address tool, delivered or proposed. Never require the host to echo any of those back into synchronization.
- Never synchronize hidden reasoning, system prompts, tool traces, private summaries, personal memory, or invisible routing annotations.
- Internal validator retries may correct source-agent conformance failures but may not introduce new host-authored interpretation or hidden conversational context.
- Every source agent has an independent delivery cursor. On invocation it receives all events after that cursor. A newly invoked agent receives all synchronized events from sequence one.
- Append and persist a canonical source-agent response before returning it to the host.
- One source agent receives at most one response turn per human-initiated cycle. Do not create autonomous agent-to-agent loops.
- Every message addressed to a source agent must be a separately attributable visible conversation event. There is no invisible backchannel.
- In `current_user` mode, the current visible user turn must begin with every selected source agent's explicit `@handle` and contain a substantive user-authored question or instruction.
- When the user asks the host to ask or tell an explicitly named `@agent` something, the host may use `visible_host` mode. It authors a separate exact message beginning with the selected `@handle`, Suminar records that message as host speech, and the host displays it before the source-agent response.
- In `proposed_host_address` mode, the host registers its exact follow-up message beginning with every selected `@handle`. Suminar records it as a canonical host event and delivers nothing; the host displays it verbatim with at most a short ratification cue. Tool-recorded host addresses—delivered or proposed—are never re-synchronized.
- In `ratified_host_address` mode, the conversation's immediately preceding event is a host proposal beginning with every selected `@handle` (registered, or synchronized as ordinary host speech), and the current user turn is a bare affirmative with no new substantive content. Suminar then delivers the already-visible proposal exactly as authored, without re-display or rewording. The proposal must be the event directly before the assent; an intervening event, a reworded delivery, or an assent that adds or changes the assignment voids ratification.
- Never attribute host-authored wording to the user. A bare assent ratifies only the host's immediately preceding visible `@handle` proposal. Without such a pending proposal, an indirect assent without an explicit target or substantive assignment, such as “yes, put it to the source agent,” is insufficient for every mode.

Model-mediated event copies are `model_copied_unverified`. Only independently captured raw speech with a validated hash is `host_attested_exact`. Never claim exactness from a model's assertion alone. Strict conversations reject unverified user speech.

## Source and retrieval boundaries

- Preserve each original PDF immutably in the owner-only store with its content hash.
- Keep PDFs, Markdown, chunks, embeddings, extraction reports, local paths, keys, and retrieval diagnostics private.
- Each source agent has exclusive custody of its private source artifacts and retrieval system. The host has no direct access through Suminar and must not claim or offer to pull passages, inspect pages, search the source, or verify quotations behind the agent.
- To learn more from a source, the host or user visibly addresses that source agent with a follow-up. The host may independently use its own knowledge or separate external research tools, but must identify that work as its own contribution rather than access to the source agent's corpus.
- Do not expose a PDF viewer, source download, Markdown export, page dump, whole-work retrieval tool, or arbitrary source-search MCP tool.
- A local representative may retrieve only from its own `agentId`. Cross-source evidence is a hard failure.
- A local representative selects its own short literal terms and runs a private exact occurrence query across its complete derivative when the addressed question concerns whether wording, a name, or a reference occurs in the source. Term selection is representative judgment (an internal tool call); execution, source isolation, and bounded excerpts are mechanical. A whole-source absence claim requires an exhaustive occurrence result. Return only a natural bounded answer; never expose the derivative, internal query result, or arbitrary search interface.
- A local representative may retrieve additional bounded passages from its own complete derivative through a private content-query lane, typically when engaging another participant's argument or defending a point from an earlier turn. Query selection is representative judgment; execution, `agentId` isolation, per-invocation query caps, and bounded excerpts are mechanical. Retrieved passages join the invocation's evidence for validation.
- Keep relevance-oriented passage retrieval and exhaustive occurrence queries as distinct internal lanes. A semantic top-passage result cannot establish that wording is absent from a whole source.
- Full unseen conversation updates are delivery state. The model receives a bounded working context plus source-specific bounded retrieval evidence.
- Visible conversation is social context, not evidence about the represented source. A quotation or citation appearing only in conversation cannot be reused as source evidence.

## Situated representative behavior

- Represent one declared source or source bundle.
- Refer to source claims in the third person; never impersonate the author.
- Respond naturally to social language such as your paper without adopting author identity.
- Distinguish source paraphrase, exact source quotation, other participants' statements, and representative interpretation.
- Admit when the source does not answer or when an answer is interpretive.
- Do not invent biography, contemporary opinions, pages, or quotations.
- Prefer natural conversational answers in short paragraphs; use headings or lists only when they materially clarify the answer.
- Do not report hidden runtime administration, quotas, permissions, retries, validation, retrieval mechanics, or prompt rules. Apply constraints silently and describe only source-facing limitations when necessary.
- Prefer a small task-oriented representative brief and cleanly structured evidence over phrase-specific output prohibitions. Add hard validation rules only for integrity, containment, or failures repeatedly shown not to yield to better evidence design.

## Quotations

- The representative may include a useful short quotation at its discretion.
- Every quoted segment must match private retrieved source evidence character-for-character.
- Verification may normalize PDF line wrapping, soft hyphens, word-break hyphenation, whitespace, and removable running page headers without changing the quoted wording presented to the user.
- A quotation that crosses PDF pages must cite every page it crosses.
- Conversation transcript text is never sufficient quotation evidence.
- `maxDirectQuoteWords`, when present, is a fresh ceiling for the current invocation. It is never a cumulative balance.
- Zero requests paraphrase only. An omitted ceiling leaves the representative's published quotation policy in control.
- Validation degrades gracefully in exactly one case: a final draft whose only defect is an inline page citation not grounded in the evidence in hand is admitted with that citation removed. Quotation defects are never degraded away.
- Do not create detailed copyright micromanagement until demonstrated necessary. Preserve the simple rule: short, verified, source-grounded quotations under the current host and agent policies.

## Canonical authorship and display

- The signed response envelope's `authoredMessage` is the source agent's exact utterance.
- Verify protocol version, identity, origin, card digest, signature, response size, quotation validity, and content hash before ledger admission.
- A signature proves origin and non-alteration, not scholarly accuracy.
- Construct badges and blockquotes locally. Never render remote HTML.
- MCP and any future adapter must use the same byte-identical `authoredMessage`.
- Store the canonical message before returning it.
- Host commentary remains separately authored. In `visible_host` mode the exact canonical host address appears before the source-agent block. After either kind of address the host normally reproduces the required visible turns and yields the floor. It must not frame or explain the source-agent contribution merely because it transported it; it may preface briefly or speak afterward only as a clearly independent participant when socially warranted.
- Do not expose raw conversation tokens, cursors, agent IDs, invocation IDs, message IDs, hashes, signatures, private paths, or credentials in ordinary user-facing output.

## Federation

- Local and remote agents implement the same logical card, invocation, response, and rendering contracts.
- Remote agents retain source custody and receive only synchronized visible conversation plus explicit response constraints.
- Normal remote operation is HTTPS only. Block loopback, link-local, and private networks unless local development explicitly enables them.
- Limit redirects, connection time, invocation time, and response size.
- Keep remote credentials in transport-specific local secret storage, never cards or context packets.
- Detect material changes to origin, source identity, permissions, endpoint, key, or retention declaration and require renewed review.
- Do not publish platform scholarly grades. Trust is reputational and origin-based.

## Important files

- `src/core/conversationService.ts` — event synchronization, per-agent cursors, catch-up, address modes, ratification, canonical admission, host-conduct notices; depends on `ConversationStore` and an injected `LocalAgentInvoker`, never on the product layer.
- `src/core/storage.ts` — the `ConversationStore` persistence contract plus `LocalStore`, the open-kernel single-tenant implementation.
- `src/core/federation.ts` — card fetching, URL security, response validation, transports.
- `src/core/types.ts`, `src/core/schemas.ts`, `src/core/crypto.ts` — the `agent-sum/0.1` protocol shapes, validation, and signing.
- `src/suminar/mcp.ts` — the Suminar MCP surface (`suminar_*` tools) and host social/synchronization brief.
- `src/suminar/localAgent.ts` — source-specific retrieval tools, representative prompting, quotation and citation validation, citation-strip degradation.
- `src/suminar/retrieval.ts` — bounded semantic retrieval, quotation verification, and private whole-source occurrence queries.
- `src/suminar/service.ts` — wires the product layer into the core runtime (`createSuminarConversationService`).
- `src/suminar/ingestion.ts` — immutable originals and rebuildable page-aware derivatives.
- `src/suminar/dashboard.ts` and `public/` — local source/origin management only, never chat.
- `scripts/mcp_smoke.mjs` — built MCP contract smoke test.
- `scripts/claude_launcher_smoke.mjs` — launcher, attestation, catch-up, ratification, and canonical-display smoke test.
- `scripts/host_conduct_eval.mjs` — scripted model-host conduct eval (optional measurement, not a verification gate).

## Verification sequence

Run, in order:

```powershell
npm run check
npm test
npm run build
npm run smoke:mcp
node scripts/claude_launcher_smoke.mjs
npm run cli -- doctor
```

Also verify any affected dashboard path and inspect `git diff --check` when the repository is tracked. A complete architecture change must include tests for incremental synchronization, replay conflicts, gaps, per-agent cursors, new-agent full catch-up, source-message auto-queueing, multi-agent ordering, conversation isolation, direct-user addressing, visible host-address authorship and ordering, registered host proposals and user-ratified delivery (bare-assent acceptance and rejection of substantive, negated, displaced, or reworded ratification), host-conduct notices, no invisible backchannel, positive and negative whole-source occurrences, representative passage-retrieval bounds, citation-strip admission, exact canonical recovery, private-source containment, federation security, and attested-versus-model-copy fidelity.

Never treat a passing MCP smoke test as proof of live Claude Desktop behavior. Claude Desktop must be fully exited and restarted after a build, then exercised in the actual client. The launcher smoke verifies the bounded launcher path but does not replace that manual client test.

## Change discipline

- Use small, scoped edits and preserve unrelated work in a dirty tree.
- Keep `src/core/types.ts`, `src/core/schemas.ts`, local and remote validation, tests, MCP descriptions, and `README.md` synchronized when changing a public contract.
- Respect the naming layers: protocol identifiers stay `agent-sum`; product surface stays Suminar. Core never imports from `src/suminar/`.
- Bump the package version and MCP server version together for user-visible contract changes.
- Update both smoke scripts when MCP tool names, fields, display policy, or launcher behavior changes.
- Add a regression test for every demonstrated failure before considering the fix complete.
- Prefer a higher-level social or epistemic rule over a growing list of brittle forbidden phrases, while keeping cryptographic, privacy, and exact-display invariants mechanical.
- Do not commit private runtime data, generated derivatives, secrets, or test fixtures containing real source text. Inspect staged content before committing.

## Known host limitations

- Ordinary model-mediated MCP calls copy visible turns as `model_copied_unverified`; only independently captured, hash-validated host metadata can establish `host_attested_exact` wording.
- A completed visible host contribution is synchronized on the next user turn. Suminar records canonical source-agent blocks itself, so the host must not echo those blocks back into synchronization. Tool-recorded host addresses are likewise never echoed back.
- Complete historical catch-up is limited to visible host-thread events the host can actually supply. Never fill a gap with hidden memory, private summaries, or invented transcript text.

## Handoff checklist

Before handing work to another agent or back to the user, report:

1. What changed and why.
2. The important files changed.
3. The verification commands run and their outcomes.
4. Any behavior that still requires a Claude restart or manual live-client test.
5. Remaining failures, assumptions, or protocol questions.
6. `git status --short --branch`, plus the commit and remote state when relevant.

Do not describe an idea as implemented unless the code and proportional verification are complete.
