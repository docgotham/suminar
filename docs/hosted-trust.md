# Hosted Suminar — public claims of record

These are the trust claims hosted Suminar makes to the people who use it.
They are written to be pinned: the structural-trust tests fail whenever the
code stops backing a sentence on this page, so the page cannot quietly drift
into marketing. The Phase 3 website copies its trust language from here.

## The product that can't misquote

A source agent may quote its source only when the quoted words match the
private source evidence character-for-character (after normalizing PDF line
wrapping, soft hyphens, and page furniture). A quotation that cannot be
verified is refused, never repaired; an inline page citation that is not
grounded in the evidence in hand is stripped rather than published. Visible
conversation text is never accepted as quotation evidence.

## Invite-only beta, with visible limits

Access is by invitation while we calibrate. Anyone can join the waitlist —
it stores a normalized email and a timestamp, nothing else, and answers
identically whether or not an address is already on it. Accounts can issue
invite codes; codes are stored only as SHA-256 hashes.

Per-account quotas are abuse guards, not rationing — a working scholar will
not reach them. They are enforced inside the database (BEFORE INSERT
triggers), so no application path can skip them:

| Quota | Value |
| --- | --- |
| Source-agent invocations per day | 200 |
| Source-agent invocations per 30 days | 2000 |
| Documents per account | 50 |
| Uploaded sources per account | 1 GiB (1073741824 bytes) |
| Single upload ceiling | 50 MiB (52428800 bytes) |
| Active invite codes per account | 10 |
| Waitlist size | 10000 |
| Active syndication codes per account | 10 |
| Active syndication grants per source agent | 25 |

Request-frequency limits guard the doors separately; they fail open (rate
limiting must never be the outage) while the quotas above fail closed.

## Content-blind operation

The operator surface reads aggregates and account metadata — emails, counts,
usage, invite status — and cannot read what you uploaded, asked, or were
told. This is enforced by construction: a test scans every database
migration that defines the operator overview and fails if one references a
content-bearing column.

There is no end-to-end encryption, deliberately: source agents must read
their derivatives server-side to answer at all. Where structure runs out,
honesty takes over: infrastructure-level access exists, and if operator
tooling ever touches an account's material, it must write an audit row the
account's owner can read. If we ever look, you see that we looked.

## Syndication moves permission, never custody

An owner can syndicate a source agent to another account with a code
(hash-at-rest, shown once). Redeeming it grants the recipient's
conversations the right to address the agent — the source and every
derivative stay in the owner's storage, and the recipient's account stores
nothing, so there is nothing for the recipient to export. Either side can
end a grant at any time, and a deleted or revoked source simply leaves the
recipient's roster. Syndicated invocations count against the recipient's
own quotas.

## Your material leaves with you

Every uploaded original and every derivative built from it (except signing
keys, which are agent custody) is exportable by its owner at any time, and
each export writes an owner-visible audit row before anything is released.
Deleting a document removes its rows and its stored objects.

## No client analytics

Hosted Suminar pages ship no analytics scripts.

## Verifiable deployment

`/version` names the exact commit the running server was built from, so
"the code is open" is a falsifiable claim about this server, not a vague one
about a repository.

## Connecting

The MCP endpoint is `https://suminar.ai/mcp`. OAuth discovery lives
at `/.well-known/oauth-protected-resource` and
`/.well-known/oauth-authorization-server`; clients register dynamically and
authorize with PKCE (S256). A connector token pasted at the consent form is
the pilot credential.
