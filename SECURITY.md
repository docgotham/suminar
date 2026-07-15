# Security

Suminar holds people's private sources — often copyrighted works they are
entitled to read but not to redistribute — and the conversations those
sources join. Reports that protect either are welcome and taken seriously.

## Reporting

Email **docgotham@gmail.com** with "SECURITY" in the subject. Include what
you found, how to reproduce it, and what you believe the impact is. You will
get a human reply — this is a small operation, so response time is measured
in days, not hours. Please give us reasonable time to fix an issue before
disclosing it publicly.

Do not test against accounts or sources that are not yours: the hosted
service is real people's material. If you need a target, self-host the
kernel or use your own account — the pilot is enough to exercise every
surface.

## What counts

Especially interesting: anything that lets one account read another
account's sources, derivatives, or conversations (owner scoping in the
hosted layer is the tenant wall, with RLS behind it); anything that lets a
syndication grantee export or directly read a granted source (grants move
permission, never custody); a way to make a source agent emit a quotation
that does not occur verbatim in its private source (the product's central
claim is that it cannot misquote); authentication or token-handling flaws
(connector tokens, OAuth codes and tokens, invite and syndication codes are
all stored as hashes and shown once); and ways to make the operator surface
read content (it is designed and tested to be unable to).

## Scope notes

- Request-frequency limits are fail-open by design — their absence under
  counter outage is a known trade, not a finding. The volume quotas beneath
  them fail closed.
- There is deliberately no end-to-end encryption: source agents must read
  their derivatives server-side to answer at all. Infrastructure-level
  access exists and is stated plainly on the trust page; operator tooling
  that touches an account's material must write an audit row the owner can
  read.
- `/version` names the deployed commit so findings can be reported against
  the exact running code.
