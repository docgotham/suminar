// MLA-style agent naming. Scholars disambiguate multiple works by one author
// with shortened titles, not dates — (Sowell, Affirmative Action 158) versus
// (Sowell, Basic Economics 42) — so derived handles are surname plus the
// title's first significant words, and years appear only as a last resort.
// Display names read like a Works Cited short form: "Sowell, Affirmative
// Action Around the World (2004)". Explicit user choices always win upstream;
// these functions only fill silence.

const NAME_SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv"]);
// Surname particles stay attached: Du Bois is "Du Bois", not "Bois".
const NAME_PARTICLES = new Set(["du", "de", "del", "della", "der", "den", "di", "da", "van", "von", "la", "le", "ter", "bin", "ibn", "al", "st.", "st"]);
const TITLE_STOPWORDS = new Set(["a", "an", "the", "of", "to", "in", "on", "for", "and", "or", "nor", "but", "with", "from", "at", "by", "as", "into", "onto", "upon"]);

export function slugifyName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
}

// The surname of one author string, in either order: "Thomas Sowell" and
// "Sowell, Thomas" both yield Sowell. A comma is the scholar's inversion
// signal (Works Cited muscle memory) — unless what follows it is only a
// generational suffix, so "Martin Luther King, Jr." still yields King.
export function surnameOf(author: string): string {
  const trimmed = author.trim();
  const commaIndex = trimmed.indexOf(",");
  if (commaIndex > 0) {
    const before = trimmed.slice(0, commaIndex).trim();
    const after = trimmed.slice(commaIndex + 1).trim();
    const firstAfter = after.split(/\s+/)[0]?.toLowerCase().replace(/[.,]/g, "") ?? "";
    if (after && !NAME_SUFFIXES.has(firstAfter)) return before;
    return naturalOrderSurname(before);
  }
  return naturalOrderSurname(trimmed);
}

// Natural reading order: last token, skipping generational suffixes, pulling
// particles back in. "W.E.B. Du Bois" → "Du Bois"; "King Jr." → "King".
function naturalOrderSurname(author: string): string {
  const tokens = author.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return "";
  let index = tokens.length - 1;
  while (index > 0 && NAME_SUFFIXES.has(tokens[index]!.toLowerCase().replace(/[.,]/g, ""))) index -= 1;
  let start = index;
  while (start > 0 && NAME_PARTICLES.has(tokens[start - 1]!.toLowerCase())) start -= 1;
  return tokens.slice(start, index + 1).join(" ").replace(/,$/, "");
}

// Works with no personal byline are cited by their corporate author — a
// research brief or report authored by an organization, common in policy and
// institutional literature. A corporate author is not inverted ("National
// Communication Association", never "Association, National"), and its handle
// comes from an acronym, not a surname.
const CORPORATE_KEYWORDS = /\b(?:association|institute|institution|foundation|centre|center|council|society|bureau|commission|committee|organi[sz]ation|ministry|agency|administration|corporation|corp|university|college|school|press|authority|coalition|consortium|federation|academy|observatory|forum|department|laboratory|initiative|alliance|network|fund|trust|board|office|service|union|league|group|company|inc|llc)\b/i;
const ORG_HANDLE_STOPWORDS = new Set(["of", "the", "and", "for", "in", "on", "a", "an"]);

export function isCorporateAuthor(name: string): boolean {
  return CORPORATE_KEYWORDS.test(name.trim());
}

// A handle prefix for a corporate author: its acronym when that reads well
// (2–5 significant initials — "National Communication Association" → "nca"),
// otherwise its first significant word ("Brookings" → "brookings").
export function orgHandlePrefix(name: string): string {
  const words = name.trim().split(/\s+/)
    .map((word) => word.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  const significant = words.filter((word) => !ORG_HANDLE_STOPWORDS.has(word.toLowerCase()));
  if (significant.length >= 2 && significant.length <= 5) {
    return significant.map((word) => word[0]!).join("").toLowerCase();
  }
  return slugifyName(significant[0] ?? name);
}

// A title's main segment ends at the first colon or semicolon — or at a
// spaced dash, which is both a subtitle style and the tail every
// browser-saved PDF carries ("A Great Man, Warts and All – Commentary
// Magazine"). Unspaced hyphens stay: they're inside real words.
const SUBTITLE_BOUNDARY = /[:;]|\s[-–—]\s/;

// The title's main segment as words, punctuation stripped per word. Real
// titles separate words with spaces; a file dragged in with no typed metadata
// arrives as a hyphen-slug with no spaces ("the-college-campus-…"), where the
// hyphens ARE the separators. Split on hyphens only in that no-space case, so
// naming operates on real words rather than one long token.
function mainTitleWords(title: string): string[] {
  const main = title.split(SUBTITLE_BOUNDARY)[0] ?? "";
  const wordSplit = /\s/.test(main) ? /\s+/ : /[\s-]+/;
  return main
    .split(wordSplit)
    .map((word) => word.replace(/[^\p{L}\p{N}''-]+/gu, ""))
    .filter(Boolean);
}

// Significant words for handle building: stopwords out, unless the title is
// nothing but stopwords (in which case keep what exists rather than nothing).
export function significantTitleWords(title: string): string[] {
  const words = mainTitleWords(title);
  const significant = words.filter((word) => !TITLE_STOPWORDS.has(word.toLowerCase()));
  return significant.length ? significant : words;
}

export interface NamingIdentity {
  authors: string[];
  title: string;
  year?: number;
}

// Ordered handle candidates, most-MLA first: surname + two significant title
// words, then progressively more words, then the year, then a numeral — each
// step taken only when everything shorter is already claimed by a sibling
// agent. Deterministic, so reprocessing the same source lands the same place.
export function handleCandidates(identity: NamingIdentity, maxCandidates = 12): string[] {
  const surname = identity.authors[0]
    ? (isCorporateAuthor(identity.authors[0]) ? orgHandlePrefix(identity.authors[0]) : surnameOf(identity.authors[0]))
    : "";
  const words = significantTitleWords(identity.title);
  const prefix = surname ? [surname] : [];
  const candidates: string[] = [];
  const push = (parts: string[]): boolean => {
    const slug = slugifyName(parts.join(" "));
    if (slug && !candidates.includes(slug)) {
      candidates.push(slug);
      return true;
    }
    return false;
  };

  const startCount = Math.min(2, words.length) || 0;
  for (let count = startCount; count <= words.length && candidates.length < maxCandidates; count += 1) {
    push([...prefix, ...words.slice(0, count)]);
  }
  if (!candidates.length && prefix.length) push(prefix);
  if (identity.year) {
    const base = candidates[candidates.length - 1] ?? (prefix.length ? slugifyName(prefix.join(" ")) : "");
    if (base) push([base, String(identity.year)]);
  }
  if (!candidates.length) candidates.push("source");
  // Numeric disambiguation. slugifyName truncates to 100 chars, so a base
  // already at that length would swallow every "-N" suffix and produce the
  // same slug forever — an over-length title once spun this loop to the 300s
  // function kill. Cap the base to leave room for the suffix, and stop the
  // instant a push fails to add a new slug, so the loop can never spin.
  const numberedBase = candidates[candidates.length - 1]!.slice(0, 90).replace(/-+$/, "");
  for (let n = 2; candidates.length < maxCandidates; n += 1) {
    if (!push([numberedBase, String(n)])) break;
  }
  return candidates;
}

// The title's main segment as a string (subtitle and save-as tails dropped).
export function mainTitle(title: string): string {
  return (title.split(SUBTITLE_BOUNDARY)[0] ?? "").trim();
}

// "Thomas Sowell" → "Sowell, Thomas" for the head of a Works Cited entry.
// Already-inverted input passes through; a mononym stays itself.
export function invertFirstAuthor(author: string): string {
  const trimmed = author.trim();
  if (isCorporateAuthor(trimmed)) return trimmed; // corporate authors are never inverted
  const surname = surnameOf(trimmed);
  if (!surname) return trimmed;
  if (trimmed.toLowerCase().startsWith(`${surname.toLowerCase()},`)) return trimmed;
  const given = trimmed.replace(surname, "").replace(/\s+/g, " ").replace(/^[,\s]+|[,\s]+$/g, "");
  return given ? `${surname}, ${given}` : surname;
}

function dotTerminate(value: string): string {
  return /[.!?]$/.test(value) ? value : `${value}.`;
}

// The author head of an MLA entry: one author inverted; two authors as
// "Surname, Given, and Given Surname."; three or more as "Surname, Given,
// et al."
export function mlaAuthorsLabel(authors: string[]): string | undefined {
  const named = authors.map((author) => author.trim()).filter(Boolean);
  if (!named.length) return undefined;
  if (named.length === 1) return dotTerminate(invertFirstAuthor(named[0]!));
  if (named.length === 2) return dotTerminate(`${invertFirstAuthor(named[0]!)}, and ${named[1]}`);
  return dotTerminate(`${invertFirstAuthor(named[0]!)}, et al`);
}

export interface MlaCitationParts {
  authorsLabel?: string;
  title: string;
  year?: number;
}

// The derivable portion of an MLA entry: author head, full title (the formal
// record keeps its subtitle), year. Container, publisher, and medium are not
// collected — MLA tolerates citing what you have, and a verbatim
// sourceIdentity.citation supersedes this derivation entirely.
export function mlaCitationParts(identity: NamingIdentity): MlaCitationParts {
  const authorsLabel = mlaAuthorsLabel(identity.authors);
  return {
    ...(authorsLabel ? { authorsLabel } : {}),
    title: identity.title.trim() || "Untitled source",
    ...(identity.year ? { year: identity.year } : {}),
  };
}

// Works Cited short form for the block header: "Surname, Main Title (Year)".
// The main title keeps its article and its prepositions — display has room
// for grace that slugs do not — but the subtitle stays dropped and the whole
// thing is capped at a word boundary.
export function deriveDisplayName(identity: NamingIdentity, maxTitleLength = 60): string {
  const surname = identity.authors[0]
    ? (isCorporateAuthor(identity.authors[0]) ? identity.authors[0].trim() : surnameOf(identity.authors[0]))
    : "";
  let title = (identity.title.split(SUBTITLE_BOUNDARY)[0] ?? "").trim();
  if (title.length > maxTitleLength) {
    const cut = title.slice(0, maxTitleLength);
    title = (cut.slice(0, cut.lastIndexOf(" ")) || cut).trim();
  }
  const parts = [surname ? `${surname}, ${title}` : title];
  if (identity.year) parts.push(`(${identity.year})`);
  return parts.join(" ").trim() || "Untitled source";
}
