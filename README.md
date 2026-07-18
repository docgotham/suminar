# Suminar — situated source agents for scholarly texts

**Suminar** turns a private academic PDF into a named conversational representative for one source. The source agent is not the author, the document itself, or a neutral search utility. It speaks as a situated participant whose claims, interpretations, and short quotations remain grounded in its private source. Address two of them in the same thread and you have a suminar: a seminar of sources, held inside the chat you already use.

Version 1.0 is deliberately roomless. Claude, ChatGPT, Perplexity, or another MCP host already supplies the conversation boundary. Suminar contributes source agents to that existing thread without creating a second room, panel, or chat surface.

The host chatbot is treated as one participant among the user and source agents. It additionally holds administrative transport privileges — synchronizing visible speech, delivering addresses, verifying envelopes, reproducing canonical turns — but those privileges are capabilities, not its conversational identity, and all of that work happens silently.

## Product and framework

Suminar is the first product built on **Agent·Sum**, a general framework for composing named specialist agents into a user's existing primary chat. The split is deliberate and layered:

- **The protocol keeps the Agent·Sum name.** The federation envelope is `agent-sum/0.1`, remote agents publish cards at `/.well-known/agent-sum.json`, attestation `_meta` keys use the `agent-sum/*` namespace, and local origins use the `agent-sum-local://` scheme. Any future Agent·Sum vertical interoperates at this layer.
- **The product surface is Suminar.** The MCP server presents as `suminar`, tools are `suminar_*`, hosts speak the name to users, and configuration uses `SUMINAR_*` environment variables.
- **The code carries the seam.** `src/core/` is the framework — conversation runtime, event streams and cursors, address modes, canonical authorship, federation, crypto, and the `ConversationStore` persistence contract. `src/suminar/` is the product — scholarly representatives, retrieval lanes, quotation and citation validation, ingestion, the local dashboard, and the MCP surface. Core never imports from the product layer.

Suminar is an **open kernel**: the single-tenant local mode in this repository is the software anyone is encouraged to run themselves, and the hosted product is the same kernel operated as a service — multi-tenant store behind the same `ConversationStore` interface, accounts, a web upload/management surface, and hosted inference. Nothing in this repository requires the hosted service.

## Hosted Suminar

The hosted service runs at **[suminar.ai](https://suminar.ai)** as an invite-only pilot. The MCP endpoint is `https://suminar.ai/mcp` (OAuth with PKCE; a connector token is the pilot credential). The account page manages sources, connector tokens, invites, and syndication; [the trust page](https://suminar.ai/#trust) states the public claims of record — verified quotation, database-enforced quotas, content-blind operation, owner-exportable material, no client analytics, and a `/version` endpoint naming the exact deployed commit. Those claims are pinned by tests in this repository (`docs/hosted-trust.md` is the page's source of truth), so the page cannot quietly drift from the code.

## What version 1.0 does

- Ingests local PDFs into immutable originals and rebuildable, page-aware private derivatives.
- Keeps PDFs, Markdown, chunks, embeddings, local paths, and extraction diagnostics unavailable to conversational clients.
- Lists and invokes local or public HTTPS source agents through one MCP server.
- Copies visible user and host speech into a private, ordered event stream for each host thread.
- Gives every invoked source agent all events it has not yet received, tracked by an independent cursor.
- Gives a newly invoked source agent the complete synchronized conversation from sequence 1.
- Automatically records each canonical source-agent response as the next conversation event.
- Stores and recovers the exact signed source-agent utterance.
- Keeps conversation state isolated across opaque host-thread tokens.
- Requires every source-agent address to be a visible, separately attributed user or host turn; there is no invisible backchannel.
- Lets the host propose a follow-up as its own visible `@handle` message, which the user's bare affirmative can ratify for delivery exactly as authored.
- Lets the host synchronize the current turn's visible events and deliver an address in one call.
- Returns private host-conduct notices when a synchronized host turn narrates transport, offers to manage further queries, coaches the user on addressing, or echoes a canonical block.
- Gives local representatives a private exact whole-source occurrence lane for questions such as whether a work mentions or cites a person or phrase.
- Derives agent names MLA-style — surname plus shortened title (`@sowell-affirmative-action`), titles disambiguating a same-author shelf rather than dates — with per-owner handle uniqueness and Works Cited display names.
- Carries an annotated-bibliography line on every agent card, in three never-fabricate tiers: owner-supplied, mined from the source's own opening prose behind front-matter filters, or composed purely from metadata; a model-drafted annotation reaches display only through the owner's explicit approval.
- Ingests PDF and .docx on the hosted path (PyMuPDF and python-docx behind one extraction function; the local fallback remains PDF).
- Syndicates a source agent to another account by a shown-once code: the grant moves permission, never custody — artifacts stay in the owner's storage, the recipient can address but never export, and either side can revoke.

Suminar verifies origin, protocol behavior, message integrity, containment, and exact canonical delivery. It does not certify that a remote agent represents its source well. Trust in remote source agents is primarily trust in their recognizable operator and origin, much as it is with websites.

## Conversation synchronization

Once Suminar becomes active in a host thread, the host keeps a private conversation token and cursor. At the beginning of each new user turn it calls `suminar_sync_conversation` with every completed visible user or host contribution after the acknowledged cursor. Ordinarily that means the preceding completed host response followed by the current user message. On first use, it supplies the complete visible history available to it. When the same turn culminates in addressing source agents, the host may instead pass those new events directly to `suminar_address_source_agents`, which synchronizes and delivers in one call — one fewer round trip and one fewer opportunity to narrate setup.

Suminar itself records canonical source-agent messages, so the host never copies those blocks back into synchronization. Hidden reasoning, tool traces, system prompts, personal memory, and private summaries are never conversation events.

This incremental scheme prevents arbitrary recent-message windows:

1. The server maintains one ordered event stream per host thread.
2. Each participating source agent maintains its own last-delivered sequence.
3. On invocation, the agent receives every later event as a catch-up update.
4. A bounded recent working context is selected for the model call, while the complete unseen update remains part of the delivery contract.
5. The canonical response is appended before it is returned to the host.

An ordinary model calling an MCP tool can only provide `model_copied_unverified` wording. A trusted adapter may attach hash-validated raw events as `host_attested_exact`. The system preserves this distinction; it never upgrades a model copy by assertion. Full-history reliability ultimately depends on host access to raw thread events, but incremental calls are safer and easier for an unmodified chatbot than periodically reconstructing a long transcript.

## Direct addressing and authorship

Suminar supports four address modes, all visible in the shared conversation.

In `current_user` mode, the user's current turn begins with every selected `@handle` and supplies the substantive question. Suminar preserves that user-authored turn exactly as the addressed message.

In `visible_host` mode, the user asks the host to put a substantive question to an explicitly named source agent, for example: `Use Suminar. Ask @loury-foreword what the Foreword considers its strongest practical argument.` Claude may fulfill that request by authoring its own separate visible turn:

```text
@loury-foreword What does the Foreword consider its strongest practical argument?
```

Suminar records that exact wording as host-authored speech, delivers it to the source agent, and returns a deterministic display order: the host's visible address first, then the source agent's canonical block. The original user request remains separately identified as user context. Claude's wording is never attributed to the user and is never sent invisibly.

The remaining two modes form a propose-and-ratify pair that lets the host participate on its own initiative — but only with the user's sanction. Instead of offering to relay a follow-up, the host authors the follow-up itself and registers it (`proposed_host_address`) so Suminar records the exact wording as visible host speech:

```text
@loury-foreword How does that practical argument differ from the diversity rationale the Court relied on?
```

Nothing is delivered yet. The host displays the recorded proposal verbatim; a short ratification cue after it — say the word and I'll send it — is part of the proposal, not a service offer. If the user's next turn is a bare affirmative — `Yes, go ahead.` — the host synchronizes only that one user message (the proposal is already recorded and is never re-synchronized) and invokes `ratified_host_address`: Suminar delivers the proposal exactly as authored, without re-display and without rewording. Because registration happens server-side at authoring time, ratification does not depend on the host's own synchronization bookkeeping.

Ratification is deliberately narrow: the proposal must be the event immediately preceding the assent, and the assent must contain no new substantive content. `Yes, and also ask about methodology` ratifies nothing; the changed assignment needs a fresh visible address. Any intervening event expires the proposal. A bare assent with no pending proposal, such as `Yes, please put it to the source agent` out of the blue, still cannot invoke an unnamed agent or supply a missing substantive assignment.

## Source-agent behavior

A source agent:

- represents one declared source or declared source bundle;
- refers to source claims in the third person rather than impersonating the author;
- responds naturally when a user socially says your paper or your book;
- separates source claims, exact quotations, other participants' statements, and its own interpretation;
- treats synchronized conversation as social context, never as documentary evidence for its source;
- admits source or evidence limitations without narrating hidden runtime administration;
- prefers natural conversational answers in short paragraphs and uses headings or lists only when they materially clarify the answer.

Ordinary substantive questions use bounded relevance retrieval. When that baseline evidence lacks the passage the representative needs — typically when it is engaging another participant's argument or defending a point from an earlier turn — it may retrieve further bounded passages itself through a private content-query lane, choosing its own search wording; query selection is the model's judgment, while execution, source isolation, per-invocation caps, and bounded excerpts remain mechanical. When the addressed question concerns whether a name, phrase, or reference appears in the source, a local representative chooses its own short literal terms — typically a full name plus the surname, or a title fragment — and runs an exact occurrence query across its complete private derivative through a private internal tool. It receives a small structured fact packet containing each term, total matches, PDF pages, and bounded matching context. Negative whole-source claims therefore rest on the exhaustive occurrence lane rather than being inferred from a few semantically retrieved passages, regardless of how the question was phrased: term selection is the model's judgment, while execution, source isolation, and bounded excerpts remain mechanical. One task-level instruction asks the representative to turn those facts into a natural answer; phrase-specific output rules are avoided unless an integrity failure demonstrates a real need.

At its discretion it may include a short direct quotation. Every quoted segment must occur verbatim in the private retrieved evidence and fit the current invocation constraints. A host may set a fresh `maxDirectQuoteWords` ceiling for the current invocation, use zero to request paraphrase only, or omit it. Previous quotations do not consume a cumulative budget, and agents apply administrative constraints silently. Validation degrades gracefully in exactly one case: when a final draft's only defect is an inline page citation that cannot be grounded in the evidence in hand, the citation is removed and the substantive answer admitted. Unverifiable quotations are never admitted.

## Exact voice and host conduct

The response envelope contains the source agent's canonical `authoredMessage`, hash, signature, source identity digest, citations, and message ID. Suminar builds a deterministic block locally from the verified identity and exact authored text. The host reproduces that block verbatim.

The block is another participant's visible turn, not a draft or private tool result. The host is a conversational partner, not the source agent's presenter, curator, custodian, or explainer. Transport creates no interpretive standing or duty; a user request for the host's analysis creates full standing. The operational rule is edge-shaped: at most one short sentence of the host's own before the first canonical turn, and — when no part of the user's turn was addressed to the host — nothing after the final one. No summaries, evaluations, offers to relay or re-query, or menus of possible next steps. The stance distinction matters more than any verb list: remarking that another ingested source takes a very different line is a participant's contribution; offering to pose the same question to that source's agent is operator speech. The host pursues its own follow-up by authoring a visible `@handle` proposal for the user to ratify, never by offering its transport services. It does not narrate ordinary truthfulness, copyright, validation, or retry behavior.

Each source agent retains exclusive custody of its private source artifacts and retrieval system. Suminar does not let the host pull surrounding passages, inspect cited pages, search the private derivative, or verify quotations behind the agent. Further inquiry into that source happens through another visible address to the source agent. The host remains free to contribute from its own knowledge or independently available research tools, provided it presents that work as its own contribution rather than implying access to the source agent's corpus.

## Local setup

```powershell
npm install
npm run build
npm test
npm run smoke:mcp
npm run cli -- doctor
```

The MCP entry point is:

```text
node <repository>/dist/src/claude-launcher.js
```

The launcher reads a current user-level `OPENAI_API_KEY` on Windows when a store-packaged desktop host has retained an older environment block. It never prints the key. Mistral is needed only for an explicit OCR retry; ordinary source-agent answers use the configured OpenAI model.

Configuration environment variables: `SUMINAR_DATA_DIR`, `SUMINAR_PORT`, `SUMINAR_PYTHON`, `SUMINAR_OPENAI_MODEL`, `SUMINAR_OPENAI_REASONING_EFFORT`, `SUMINAR_ALLOW_PRIVATE_ORIGINS`, `SUMINAR_MAX_OUTPUT_TOKENS`.

Useful CLI commands:

```powershell
npm run cli -- ingest C:\path\paper.pdf --handle author-2026
npm run cli -- agent-list
npm run cli -- conversation-start "@author-2026 What is the central claim?"
npm run cli -- conversation-sync <private-token> <cursor> host "A visible host contribution"
npm run cli -- invoke <private-token> <cursor> @author-2026
npm run cli -- remote-preview https://publisher.example/.well-known/agent-sum.json
```

The optional local dashboard at `http://127.0.0.1:4317` manages ingestion, representative metadata, OCR health, and remote origins. It is not a chat application and does not expose conversation transcripts.

`npm run eval:host-conduct` drives the built server with a scripted model host across fixed scenarios and grades the host's visible replies mechanically — verbatim canonical blocks, bounded preface, hard stop after the final block, no transport narration or service menus. It is a measurement for iterating on instruction wording, not a gate, and it never replaces a live Claude Desktop test.

## MCP tools

- `suminar_list_agents`
- `suminar_inspect_agent`
- `suminar_sync_conversation`
- `suminar_address_source_agents`
- `suminar_resume_seminar` (hosted deployments only: redeems a user-presented resume code to continue an existing seminar in a new host thread — seminars belong to the account, not to any chat platform)
- `suminar_read_record` (page through a seminar's canonical record verbatim — how a resuming host catches up on history beyond the recap)
- `suminar_read_message`
- `suminar_preview_remote_origin`

Normal user-facing results use human-readable handles and source identities. Conversation tokens, cursors, raw IDs, hashes, signatures, private origins, and retrieval artifacts remain protocol-internal. Because some MCP hosts do not make typed `structuredContent` values available to their model, the continuation token and cursor also appear in ordinary tool-result text under an explicit machine-use-only marker. The host must copy them exactly into the next tool call and must never reproduce them in its user-facing answer; an advanced user inspecting the expanded MCP trace may still see them.

## Federation

Local and HTTPS agents use the same logical `AgentRef`, invocation envelope, response envelope, signature validation, quotation validation, and canonical rendering contract — the `agent-sum/0.1` protocol. Remote agents retain custody of their sources. Normal operation requires HTTPS, blocks local and private destinations, limits redirects and response size, and detects material card changes. Private origins are available only under an explicit local-development setting.

There is no central registry and no scholarly trust score. A source agent may be added directly from a manifest URL after the user reviews its operator, origin, source identity, capabilities, quotation policy, context policy, and retention declaration.

## Deliberate omissions

Version 1.0 has no rooms, panels, chair routing, `@all`, autonomous agent-to-agent loops, proactive source-agent inference, Zulip adapter, PDF viewer, PDF download, Markdown export, public arbitrary source-search tool, or whole-work retrieval operation. A ratified host address is not an autonomous loop: the proposal is visible, delivery waits for the user's affirmative, and each agent still receives at most one response turn per human-initiated cycle. Private exact occurrence queries are an internal representative capability and return only bounded answers. Broader features can be reconsidered only after the simpler host-thread model demonstrates a concrete need.
