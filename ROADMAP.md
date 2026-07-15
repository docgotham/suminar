# Roadmap

Direction, not promises. Items move when they are ready, and the trust page
never claims what the code does not do.

## Near term

- **Pilot growth**: invite-only accounts at [suminar.ai](https://suminar.ai),
  calibrating quotas and costs from real metering.
- **Host-conduct terrain fixes** (`docs/design-notes.md`): authoring-time
  whispers, fail-fast ratification errors, and the clarifying-question safe
  harbor — measured against the host-conduct eval harness before and after.
- **Mention vs. address register** for @handles (also in design-notes),
  grounded in the CRCH Zulip prototype conventions.
- **Lightweight metadata editing** (rename/retitle without a full
  re-extraction; today's rename rides the reprocess pipeline).
- **.docx in the local fallback** (hosted already processes Word documents).

## Middle distance

- **Richer generated layers per source** — key points, questions — always
  entering through the owner-approved supplied tier, never straight to
  display.
- **Publisher-operated remote agents**: the `agent-sum/0.1` federation
  envelope already speaks HTTPS; hosted v1 keeps remote agents off while the
  local kernel retains them.
- **Cross-instance syndication**: within-instance syndication shipped in
  0.13; sharing across instances needs the serialization and reconciliation
  scheme sketched in design-notes.

## Explicitly not planned

Rooms, panels, chair routing, autonomous agent-to-agent loops, scholarly
trust scores, and client analytics. The host thread is the room; the user's
affirmative is the loop gate; operators stay content-blind.
