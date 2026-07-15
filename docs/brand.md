# Sum·inar — Brand Spec of Record

Locked 2026-07-14 (brand session 01, direction board reviewed by Dave).
Decisions: **Direction B ("Lapis")**; page-twin mark approved; serif reserved
for source speech; casing `Sum·inar` confirmed. This document is what the
suminar.ai site and account UI consume; change it here first.

## The idea

In manuscript culture, ultramarine — ground lapis lazuli — was the most
precious pigment, reserved for the passages that mattered most. Suminar's
entire product is the passage that matters, delivered intact. The palette is
the stone itself: deep lapis, ultramarine, the sky wash it thins to, and the
pyrite veins lapis actually carries as its gold.

Voice line: **"The passages that matter, intact."**

## Family grammar (sibling of Mem·Sum)

| Grammar rule | Mem·Sum | Sum·inar |
| --- | --- | --- |
| Interpunct atom, accent-colored | `Mem·Sum` | `Sum·inar` |
| Mark = drawn twin of the agents' chat emoji | 🥟 → crescent dumpling | 📄 → dog-eared page |
| Mark construction | filled glyph, −35° diagonal, 3 mask cuts (pleats) | filled glyph, −35° diagonal, 3 mask cuts (text lines) + fold notch |
| One-material palette | persimmon (ripeness range) | lapis lazuli (the stone's range) |
| Gold slot | `--accent-gold #f9c41f` | pyrite `#d9a527` |
| Register carried by | rounded face (Nunito) + warmth | reserved serif + ultramarine |

## Name treatment

- **Wordmark:** `Sum·inar` — single capital S, lowercase after the dot
  (one word marked at its seam, not a compound). Interpunct is U+00B7,
  set in `--accent` in brand contexts; inherits text color where accent
  would be noise (e.g., running footers).
- **Prose:** "Suminar" (no interpunct) in body text, docs, and anywhere the
  wordmark register isn't intended.
- **Code/identifiers:** `suminar` — unchanged (`suminar_*` tools,
  `SUMINAR_*` env, package name). The protocol layer stays `agent-sum`
  per AGENTS.md.
- Wordmark face: the grotesk (see Type), bold, tight tracking
  (`letter-spacing: -0.02em`).

## The mark

The drawn twin of 📄 — the emoji every source agent already signs its
canonical blocks with (it is load-bearing in `core/conversationService.ts`'s
block detection). Same construction as the Mem·Sum dumpling: a filled
single-color glyph on the family −35° diagonal, detailed only by mask cuts —
three rounded text-line strokes (the pleats' twin) plus the dog-ear fold
notch. Fill is `--accent`; never multi-color.

```svg
<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
  <defs><mask id="pagecuts">
    <rect fill="white" width="100" height="100"/>
    <g fill="none" stroke="black" stroke-linecap="round" stroke-width="5"
       transform="rotate(-35 50 50)">
      <path d="M61 14 L61 28 L75 28"/>
      <path d="M35 46 H58"/><path d="M35 58 H65"/><path d="M35 70 H59"/>
    </g>
  </mask></defs>
  <g transform="rotate(-35 50 50)">
    <path d="M31 14 L61 14 L75 28 L75 82 Q75 88 69 88 L31 88 Q25 88 25 82
             L25 20 Q25 14 31 14 Z"
          fill="var(--accent)" mask="url(#pagecuts)"/>
  </g>
</svg>
```

Small-size note: below ~20px the mask cuts close up; favicon may use the
upright untilted page with two cuts. Tune at site build.

## Palette

CSS custom properties, same architecture as Mem·Sum's `globals.css`
(`--accent`, `--accent-deep`, `--accent-gold`, `--accent-tint`,
`--accent-contrast`), light values on `:root`, dark under
`prefers-color-scheme` + `data-theme` overrides.

Light:

| Token | Hex | Name / use |
| --- | --- | --- |
| `--accent` | `#2b46c8` | ultramarine — citation bars, CTAs, the interpunct |
| `--accent-deep` | `#1a2a6e` | raw lapis — hovers, quiet links |
| `--accent-gold` | `#d9a527` | pyrite — emphasis, badges; never primary CTA |
| `--accent-tint` | `#e9eefb` | sky wash — canonical-block ground, chips |
| `--accent-contrast` | `#10142a` | midnight ink — text on paper |
| paper | `#f7f7f2` | cool paper ground (deliberately not warm cream) |

Dark:

| Token | Hex | Name / use |
| --- | --- | --- |
| `--accent` | `#5570e8` | brightened ultramarine |
| `--accent-deep` | `#8095ee` | lifted for hover-on-dark legibility |
| `--accent-gold` | `#e5b53a` | pyrite, brightened |
| `--accent-tint` | `#141a38` | night wash — canonical-block ground |
| `--accent-contrast` | `#e6e7ef` | paper-toned text |
| ground | `#0e1226` | night sky |

## Type

- **The reserved serif — source speech only.** Source-agent speech and
  direct quotations from sources are set in the serif text face; nothing
  else ever is. **Face of record: Source Serif 4** (OFL, self-hosted at
  site/fonts/ with its license). Stack:
  `'Source Serif 4', 'Palatino Linotype', Palatino, Georgia, serif`.
- **The grotesk — everyone else.** Host speech, UI, headings, wordmark.
  **Face of record: Instrument Sans** (OFL, self-hosted) — chosen over the
  General Sans candidate because OFL permits the files to live in this repo
  when it goes public; Fontshare's license does not. Stack:
  `'Instrument Sans', 'Segoe UI', system-ui, sans-serif`.
- **Utility mono** for hex/tokens/IDs: `Consolas, ui-monospace, monospace`.
- Running text ≤ ~65ch; uppercase labels 11px with `.08–.09em` tracking.

The rule is conduct made visible: in the product, you can tell who is
speaking without reading a name. The typography enforces the same etiquette
the conversation contract does.

## Brand behaviors

1. **The citation bar is the signature.** The accent-colored blockquote rail
   on every canonical block is the brand's most-seen pixel; the site reuses
   it wherever sourced speech appears.
2. **Accent discipline.** Ultramarine marks sourced speech or the path to it
   (blocks, CTAs toward the product, the interpunct). It is not a general
   decoration color.
3. **Pyrite is secondary.** Gold for emphasis and small honors; it never
   competes with ultramarine on a CTA.
4. **Serif = source.** See Type; no exceptions, including marketing pages.
5. **Both themes, one stone.** Dark mode is the night register of the same
   palette, not an inversion.

## Not chosen (for the record)

Direction A "Marginalia" (ink-states, vermilion checking hand) and
C "Reading Lamp" (banker's green, brass, oxblood) — board artifact retained
in session history. B won on concept-to-product fit and distance from both
Mem·Sum's warmth and template scholarly aesthetics.
