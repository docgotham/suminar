# Suminar Spec (as built) — 1.0.0

The one-page map of what exists, with pointers to the documents of record.
Written at the hosted launch (2026-07). Where this page and the code
disagree, the code and its tests win; where marketing and this page
disagree, this page wins.

## The product model

One private document (PDF or, hosted, .docx) becomes one **source agent**: a
named conversational representative with exclusive custody of its source and
derivatives. Agents join the user's *existing* chat (Claude, ChatGPT, any
MCP host) as fellow participants — no rooms, no panels. The host chatbot is
one participant with administrative transport privileges it exercises
silently under a conduct contract. Two agents in one thread make a suminar.
`README.md` carries the full model; `AGENTS.md` is the repository contract.

## The conversation runtime (src/core — the Agent·Sum framework)

- One ordered event stream per host thread; per-agent delivery cursors; a
  newly invoked agent receives the complete synchronized conversation.
- Four visible address modes: `current_user`, `visible_host`,
  `proposed_host_address`, `ratified_host_address` (propose-and-ratify:
  server-side registration at authoring time, bare-affirmative delivery,
  narrow expiry). No invisible backchannel exists.
- Canonical source-agent responses are recorded server-side, rendered as
  deterministic blocks, and reproduced verbatim by the host.
- Fidelity is typed: `model_copied_unverified` vs `host_attested_exact`,
  never upgraded by assertion.

## The scholarly layer (src/suminar — the product)

- **Cannot misquote**: quotations must match private source evidence
  character-for-character; unverifiable quotations are refused, never
  repaired; ungroundable inline page citations are stripped (the single
  graceful degradation). Occurrence questions run an exhaustive exact lane
  over the whole derivative, so negative claims rest on search, not vibes.
- **MLA naming doctrine** (`src/suminar/naming.ts`): derived handles are
  surname + shortened title; titles disambiguate a same-author shelf, dates
  are the last resort; display names read as Works Cited short forms;
  per-owner handle uniqueness is an invariant with collision extension.
- **Annotated bibliography** (`src/suminar/annotation.ts`): every card
  carries an annotation in never-fabricate tiers — supplied (owner words,
  survives reprocessing) > mined (the source's own opening prose, behind
  front-matter filters and quality gates, structural page-skip for books) >
  composed (pure metadata restatement). Model-drafted annotations reach
  display only through owner approval into the supplied tier.

## The hosted service (src/hosted — suminar.ai)

`docs/hosted-architecture.md` is the blueprint with as-built census;
`docs/hosted-trust.md` is the public claims page of record, drift-pinned by
tests. Summary: Vercel functions + Supabase (service-role only; owner
scoping in the hosted layer is the tenant wall, RLS the second wall),
stateless POST-only MCP endpoint with OAuth/PKCE and connector tokens
(hash-at-rest, shown once), PyMuPDF/python-docx extraction function,
database-trigger quotas (fail closed) under fail-open frequency limits,
content-blind operator surface, owner-visible audit rows, self-serve
signup by invite code, and account pages for sources, tokens, invites, and
usage.

**Syndication (0.13)**: a source agent can be granted to another account by
a shown-once code. The grant moves permission, never custody — artifacts
stay in the grantor's storage, the recipient's roster gains the agent under
a locally-reconciled handle, export has nothing to release by construction,
either side revokes, and syndicated invocations meter against the
recipient's quotas.

## Federation

The `agent-sum/0.1` envelope: agent cards at
`/.well-known/agent-sum.json`, signature validation, HTTPS-only remote
agents with custody retained at the origin. Hosted v1 keeps remote agents
disabled; the local kernel retains them. No registry, no trust scores —
trust in a remote agent is trust in its recognizable operator.

## What is deliberately absent

Rooms, chair routing, `@all`, autonomous agent-to-agent loops, proactive
inference, whole-work retrieval, client analytics, end-to-end encryption
(agents must read their derivatives to answer; honesty covers what
structure cannot). `docs/design-notes.md` records agreed-but-unbuilt
directions with their rationale.
