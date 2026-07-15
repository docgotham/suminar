# Contributing

Suminar is an open kernel run by a very small operation. Contributions are
welcome, with expectations set honestly.

## Before you write code

Open an issue first and say what you want to change and why. The project has
strong conventions — a conduct contract for host chatbots, a framework/product
seam, naming and citation doctrine — and a change that fights them will not
land no matter how clean the diff. `AGENTS.md` is the repository contract
(read it completely; it binds human contributors as much as coding agents),
`README.md` describes the product model, and `docs/design-notes.md` records
agreed directions that are not yet implemented.

## The bar

- Run the verification sequence at the end of `AGENTS.md` before proposing
  anything: typecheck, tests, build, MCP smoke, doctor.
- Every behavioral claim the project makes publicly is pinned by a test
  (`docs/hosted-trust.md` is the claims page of record). If your change
  moves behavior, move the test and the page in the same commit — the suite
  is the contract.
- Never commit private source artifacts, runtime data, or secrets. The
  `data/` directory and `.env` are gitignored for a reason.
- Prose matters here: commit messages, comments, and docs are written in
  complete sentences that explain constraints, not narration of the diff.

## Scope guidance

Good first territory: extraction quality, annotation mining filters,
naming-derivation edge cases (surnames and titles are an endless frontier),
local-kernel ergonomics, and test coverage. Territory to discuss first:
anything touching the conduct contract, the address/proposal state machine,
quotation validation, or the hosted tenant wall.
