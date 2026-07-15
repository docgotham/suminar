import { mainTitle } from "./naming.js";

// Annotated-bibliography lines, on the Omni-American Commons pattern: a
// three-tier fallback chain whose doctrine is never fabricate. The owner's
// supplied annotation wins; otherwise the line is mined from the source's own
// opening text behind boilerplate filters and quality gates; otherwise it is
// composed purely from known metadata. Model-generated text has no path to
// display without passing through the supplied (owner-reviewed) tier.

export type AnnotationSource = "supplied" | "mined" | "composed";

export interface AnnotationResult {
  text: string;
  source: AnnotationSource;
}

export interface AnnotationIdentity {
  title: string;
  authors: string[];
  year?: number;
  pageCount?: number;
}

const SUPPLIED_MAX = 500;
const MINED_MAX = 210;
const MINED_MIN = 80;

// Web-capture and reader-chrome junk that survives PDF extraction of saved
// articles (borrowed from the Commons blocklist, plus page markers).
const BOILERPLATE_TERMS = [
  "archive today",
  "archive org",
  "webpage capture",
  "saved from",
  "all snapshots",
  "webpage screenshot",
  "download zip",
  "report bug or abuse",
  "buy me a coffee",
  "donate",
  "login subscribe",
  "subscribe",
  "share this",
  "comments",
  "listen to this article",
  "advertisement",
  "cookie",
  "sign in",
  "newsletter",
];

function normalizeLine(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

// Book front matter that survives extraction: copyright-page legalese in any
// line length, and the typographic artifacts of title pages.
// No trailing word-boundary on the phrase group: "includes bibliograph"
// must match "bibliographical" (a \b there can never succeed mid-word — the
// live books proved it), and "copyright" may as well match "copyrighted".
const FRONT_MATTER_PATTERN = /\b(?:all rights reserved|copyright|no part of this (?:book|publication)|may not be reproduced|library of congress|isbn|printed in the (?:united states|u\.s\.a)|university press|(?:first|second|third|fourth) (?:edition|printing)|paperback printing|hardcover edition|published by|typeset in|catalog(?:ing|ue)[- ]in[- ]publication|includes bibliograph|set in [a-z]+ (?:type|typeface)|designed by)|british library|catalogue record|meets the (?:minimum )?(?:requirements|guidelines)|ansi\/niso|composed in [a-z]+|—\s*dc2\d|council on library resources|book longevity|\b[A-Z]{1,3}\d{2,4}(?:\.\d+)?\.[A-Z]\d+|\b[IVX]{1,4}\.\s+(?:Title|Series)\b|\[et al\.\]|\bp\. cm\.|[©∫]|\s:\s[^/]{3,100}\s\/\s|,\s*\d{4}[–—-]|\d{1,2}\.\s+\p{Lu}[^.]{2,80}—/iu;

// Letter-spaced display type ("L O N G - T E R M") extracts as a run of
// single-character tokens; prose never looks like that.
function isLetterSpacedLine(line: string): boolean {
  const tokens = line.split(/\s+/).filter(Boolean);
  if (tokens.length < 6) return false;
  const singles = tokens.filter((token) => token.length === 1).length;
  return singles / tokens.length > 0.4;
}

function isAllCapsDisplayLine(line: string): boolean {
  const letters = line.replace(/[^\p{L}]/gu, "");
  return letters.length >= 12 && line === line.toUpperCase() && /\p{L}/u.test(line);
}

function isBoilerplateLine(line: string, identity: AnnotationIdentity): boolean {
  const normalized = normalizeLine(line);
  if (!normalized || normalized.length < 20) return true;
  const title = normalizeLine(identity.title);
  if (title && (normalized === title || normalized === `${title}.`)) return true;
  for (const author of identity.authors) {
    const name = normalizeLine(author);
    if (name && (normalized === name || normalized === `by ${name}`)) return true;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/.test(line.trim())) return true;
  if (/^[a-z]+ \d{1,2}, \d{4}/.test(normalized)) return true;
  if (/^\[?(source pdf )?page \d+\]?$/.test(normalized)) return true;
  if (FRONT_MATTER_PATTERN.test(line)) return true;
  if (isLetterSpacedLine(line)) return true;
  if (isAllCapsDisplayLine(line)) return true;
  return BOILERPLATE_TERMS.some((term) => normalized === term || (normalized.length < 60 && normalized.includes(term)));
}

function capAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const boundary = cut.lastIndexOf(" ");
  return `${(boundary > max * 0.6 ? cut.slice(0, boundary) : cut).trimEnd()}…`;
}

// The source's own opening prose: markdown stripped of headings, quotes,
// links, and boilerplate, accumulated line by line until there is enough for
// a display line. Under 80 clean characters, nothing ships.
export function mineAnnotation(markdown: string, identity: AnnotationIdentity): string | undefined {
  if (!markdown.trim()) return undefined;
  // The extraction pipeline heads its markdown artifacts with HTML comment
  // metadata (<!-- agent: ... -->); comments are machine speech, never prose.
  const withoutComments = markdown.replace(/<!--[\s\S]*?-->/g, " ");
  const cleaned: string[] = [];
  let total = 0;
  for (const raw of withoutComments.split(/\r?\n+/)) {
    const line = raw
      .replace(/^#+\s*/, "")
      .replace(/^>\s*/, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/https?:\/\/\S+/g, "")
      .replace(/[*_`]+/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (isBoilerplateLine(line, identity)) continue;
    // Prose starts where sentences end: the first accepted line must close
    // with sentence punctuation, which contributor lists, addresses, and
    // printing histories never do.
    if (!cleaned.length && !/[.!?]["'”)\]]?$/.test(line)) continue;
    cleaned.push(line);
    total += line.length;
    if (total >= MINED_MAX + 60) break;
  }
  let candidate = cleaned.join(" ").replace(/\s+/g, " ").trim();
  // A fragment that opens mid-sentence (its lead-in was filtered) starts at
  // the next sentence boundary instead of reading like a torn page.
  if (/^[a-z]/.test(candidate)) {
    const boundary = candidate.search(/[.!?]\s+[A-Z"'“]/);
    candidate = boundary >= 0 ? candidate.slice(boundary + 1).trim() : "";
  }
  if (candidate.length < MINED_MIN) return undefined;
  // A candidate that runs out of text mid-clause either retreats to its last
  // complete sentence or wears an honest ellipsis.
  if (!/[.!?]["'”)\]]?$/.test(candidate)) {
    const lastSentence = candidate.replace(/[^.!?]*$/, "").trim();
    candidate = lastSentence.length >= MINED_MIN ? lastSentence : `${candidate}…`;
  }
  return capAtWordBoundary(candidate, MINED_MAX);
}

// A sentence that only restates what is known — incapable of lying.
export function composeAnnotation(identity: AnnotationIdentity): string {
  const kind = /\breview\b/i.test(identity.title)
    ? "Review essay"
    : identity.pageCount && identity.pageCount >= 60
      ? "Book-length source"
      : identity.pageCount
        ? "Article-length source"
        : "Source";
  const subject = mainTitle(identity.title);
  const year = identity.year ? ` (${identity.year})` : "";
  const topic = subject ? ` on ${subject}` : "";
  const pages = identity.pageCount ? ` ${identity.pageCount} pages.` : "";
  return `${kind}${year}${topic}.${pages}`.trim() || "Source.";
}

export interface AnnotationChunk {
  page: number;
  text: string;
}

// Front matter lives at the front — structurally, not just lexically. When
// page-numbered chunks are available, skip the opening pages wholesale
// (five for books, three for anything pamphlet-sized or larger) and mine
// what people actually wrote. If the skip leaves nothing minable, retry
// from page one so short clean documents keep their lede.
export function mineFromChunks(chunks: AnnotationChunk[], identity: AnnotationIdentity): string | undefined {
  const ordered = [...chunks].sort((a, b) => a.page - b.page);
  const maxPage = ordered.length ? ordered[ordered.length - 1]!.page : 0;
  const skipThrough = maxPage >= 30 ? 8 : maxPage >= 8 ? 3 : 0;
  const attempt = (minPage: number) => mineAnnotation(
    ordered.filter((chunk) => chunk.page > minPage).map((chunk) => chunk.text).join("\n"),
    identity,
  );
  return attempt(skipThrough) ?? (skipThrough > 0 ? attempt(0) : undefined);
}

// Draft sampling: the same structural page-skip the miner uses, so the model
// reads what the author wrote rather than what the publisher stamped, capped
// to a sane budget and page-labeled for orientation.
export function sampleChunksForDraft(chunks: AnnotationChunk[], maxChars = 12_000): string {
  const ordered = [...chunks].sort((a, b) => a.page - b.page);
  const maxPage = ordered.length ? ordered[ordered.length - 1]!.page : 0;
  const skipThrough = maxPage >= 30 ? 8 : maxPage >= 8 ? 3 : 0;
  const eligible = ordered.filter((chunk) => chunk.page > skipThrough);
  const pool = eligible.length ? eligible : ordered;
  const parts: string[] = [];
  let total = 0;
  for (const chunk of pool) {
    parts.push(`[p. ${chunk.page}] ${chunk.text}`);
    total += chunk.text.length;
    if (total >= maxChars) break;
  }
  return parts.join("\n\n");
}

// The drafting prompt: annotated-bibliography register, two sentences, no
// praise adjectives. The draft is returned unsaved — display requires the
// owner's approval through the supplied tier, so generated text never
// reaches a page without a human gate.
export function buildAnnotationDraftPrompt(identity: AnnotationIdentity, sample: string): { instructions: string; input: string } {
  const biblio = [identity.authors.join("; "), identity.title, identity.year ? String(identity.year) : ""].filter(Boolean).join(". ");
  return {
    instructions: "You draft annotations for an annotated bibliography. Write exactly two sentences in a scholarly register: present tense, no praise or blame adjectives, no hedging about excerpts or availability. State what the work argues or covers and how it proceeds, the way a careful librarian would. Output only the annotation text.",
    input: `Bibliographic identity: ${biblio}\n\nRepresentative text from the source:\n\n${sample}`,
  };
}

export interface DeriveAnnotationInput {
  supplied?: string;
  existing?: { text: string; source: AnnotationSource };
  markdown: string;
  chunks?: AnnotationChunk[];
  identity: AnnotationIdentity;
}

// Precedence: a supplied annotation wins outright; an existing supplied
// annotation survives reprocessing; mined and composed tiers re-derive
// (deterministically) from the current extraction and metadata.
export function deriveAnnotation(input: DeriveAnnotationInput): AnnotationResult {
  const supplied = input.supplied?.replace(/\s+/g, " ").trim();
  if (supplied) return { text: capAtWordBoundary(supplied, SUPPLIED_MAX), source: "supplied" };
  if (input.existing?.source === "supplied" && input.existing.text.trim()) {
    return { text: input.existing.text, source: "supplied" };
  }
  const mined = input.chunks?.length
    ? mineFromChunks(input.chunks, input.identity)
    : mineAnnotation(input.markdown, input.identity);
  if (mined) return { text: mined, source: "mined" };
  return { text: composeAnnotation(input.identity), source: "composed" };
}
