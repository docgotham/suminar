import type OpenAI from "openai";
import type { MetadataField, MetadataOrigin } from "../core/types.js";

// Identify a source's bibliographic metadata for the drop-and-go flow, most-
// trusted evidence first: the document's own front matter (gpt-5, grounded in
// the printed text), then an authoritative Crossref lookup if a DOI is found,
// then a narrowly-scoped web search for a still-missing date. Every field
// carries where it came from, and a field we cannot ground stays undefined —
// never a fabricated guess. The whole thing is best-effort: any step may fail
// and the caller still gets whatever earlier steps established.

export interface MetadataProposal {
  title?: string;
  authors?: string[];
  year?: number;
  publicationDate?: string;
  doi?: string;
  publication?: string;
  provenance: Partial<Record<MetadataField, MetadataOrigin>>;
  notes: string[];
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function cleanString(value: unknown, max = 500): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.replace(/\s+/g, " ").trim();
  return trimmed && trimmed.toLowerCase() !== "null" && trimmed.toLowerCase() !== "unknown" ? trimmed.slice(0, max) : undefined;
}

const TITLE_MINOR_WORDS = new Set(["a", "an", "the", "and", "but", "or", "nor", "of", "to", "in", "on", "at", "by", "for", "as", "from", "with", "vs"]);

// Front matter often prints a title in ALL CAPS; title-case it for display.
// Only touches genuinely all-caps titles — a title with any lowercase letter
// is left exactly as the source wrote it.
export function normalizeTitleCase(title: string): string {
  if (/\p{Ll}/u.test(title)) return title;
  const words = title.toLowerCase().split(/\s+/).filter(Boolean);
  return words
    .map((word, index) => {
      const bare = word.replace(/[^\p{L}\p{N}]/gu, "");
      if (index !== 0 && index !== words.length - 1 && TITLE_MINOR_WORDS.has(bare)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function cleanAuthors(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const authors = value
    .map((entry) => cleanString(entry, 200))
    .filter((entry): entry is string => Boolean(entry))
    // Guard against the front-matter junk that isn't a person's name.
    .filter((entry) => !/@|https?:|\bemail\b|corresponding author|department|university|©/i.test(entry));
  return authors.length ? authors.slice(0, 100) : undefined;
}

function cleanYear(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isInteger(n) && n >= 1000 && n <= 3000 ? n : undefined;
}

const EXTRACTION_INSTRUCTIONS = [
  "You extract bibliographic metadata from the opening pages of a source document for a citation.",
  "Use ONLY what is printed in the provided text. Do not infer from outside knowledge, and do not guess. If a field is not present in the text, return null for it.",
  "authors are the individual people who wrote the work, in natural reading order — exclude 'Corresponding author', emails, affiliations, departments, editors, and translators; null if the work has no personal byline.",
  "corporateAuthor is the organization credited as the author when NO individual person is bylined (e.g. a research brief, report, or white paper authored by an association, institute, or agency). Null if there are personal authors, or if no organization is credited as author (do not put a mere publisher here).",
  "Return ONLY a JSON object with these keys and no prose:",
  '{"title": string|null, "authors": string[]|null, "corporateAuthor": string|null, "year": integer|null, "publicationDate": string|null, "doi": string|null, "publication": string|null}',
  "publicationDate is the full date exactly as printed if one appears (e.g. \"March 15, 2026\"); otherwise null. publication is the journal, magazine, or publisher name if printed.",
].join(" ");

async function extractFromDocument(frontMatter: string, openai: OpenAI, model: string): Promise<MetadataProposal> {
  const proposal: MetadataProposal = { provenance: {}, notes: [] };
  const response = await openai.responses.create({
    model,
    instructions: EXTRACTION_INSTRUCTIONS,
    input: `OPENING PAGES:\n\n${frontMatter.slice(0, 12_000)}`,
    max_output_tokens: 700,
    store: false,
    ...(/^gpt-5(?:-|$)/i.test(model) ? { reasoning: { effort: "low" as const }, text: { verbosity: "low" as const } } : {}),
  }, { timeout: 60_000 });
  const parsed = parseJsonLoose(response.output_text ?? "");
  if (!parsed) {
    proposal.notes.push("Could not read metadata from the document's opening pages.");
    return proposal;
  }
  const rawTitle = cleanString(parsed.title);
  const title = rawTitle ? normalizeTitleCase(rawTitle) : undefined;
  const authors = cleanAuthors(parsed.authors);
  // No personal byline? Fall back to the credited organization (MLA corporate
  // author). Not run through cleanAuthors — that filter rejects org words like
  // "Association"/"University" that are exactly what belongs here.
  const corporateAuthor = !authors ? cleanString(parsed.corporateAuthor, 200) : undefined;
  const year = cleanYear(parsed.year);
  const publicationDate = cleanString(parsed.publicationDate, 100);
  const doi = cleanString(parsed.doi, 200)?.replace(/^https?:\/\/(?:dx\.)?doi\.org\//i, "");
  const publication = cleanString(parsed.publication, 300);
  if (title) { proposal.title = title; proposal.provenance.title = "document"; }
  if (authors) { proposal.authors = authors; proposal.provenance.authors = "document"; }
  else if (corporateAuthor && /\p{L}/u.test(corporateAuthor) && !/@|https?:/i.test(corporateAuthor)) {
    proposal.authors = [corporateAuthor];
    proposal.provenance.authors = "document";
  }
  if (year) { proposal.year = year; proposal.provenance.year = "document"; }
  if (publicationDate) { proposal.publicationDate = publicationDate; proposal.provenance.publicationDate = "document"; }
  if (doi && /10\.\d{4,9}\/\S+/.test(doi)) proposal.doi = doi.match(/10\.\d{4,9}\/\S+/)![0].replace(/[).,;]+$/, "");
  if (publication) proposal.publication = publication;
  return proposal;
}

interface CrossrefWork {
  title?: string[];
  author?: Array<{ given?: string; family?: string; name?: string }>;
  issued?: { "date-parts"?: number[][] };
  published?: { "date-parts"?: number[][] };
  "published-print"?: { "date-parts"?: number[][] };
  "published-online"?: { "date-parts"?: number[][] };
  "container-title"?: string[];
}

function formatDateParts(parts?: number[]): { year?: number; date?: string } {
  if (!parts?.length) return {};
  const [y, m, d] = parts;
  const year = cleanYear(y);
  if (!year) return {};
  if (m && d) return { year, date: `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` };
  if (m) return { year, date: `${year}-${String(m).padStart(2, "0")}` };
  return { year, date: String(year) };
}

// Authoritative structured metadata for a DOI. Free, no key; polite UA per
// Crossref etiquette. Overrides the document read when it succeeds.
async function crossrefLookup(doi: string): Promise<MetadataProposal | null> {
  try {
    const res = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      headers: { "User-Agent": "Suminar/1.0 (https://suminar.ai; mailto:docgotham@gmail.com)" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const work = ((await res.json()) as { message?: CrossrefWork }).message;
    if (!work) return null;
    const proposal: MetadataProposal = { provenance: {}, notes: [], doi };
    const title = cleanString(work.title?.[0]);
    if (title) { proposal.title = title; proposal.provenance.title = "crossref"; }
    const authors = work.author
      ?.map((a) => cleanString(a.name ?? [a.given, a.family].filter(Boolean).join(" "), 200))
      .filter((a): a is string => Boolean(a));
    if (authors?.length) { proposal.authors = authors; proposal.provenance.authors = "crossref"; }
    const dp = (work.issued ?? work["published-print"] ?? work.published ?? work["published-online"])?.["date-parts"]?.[0];
    const { year, date } = formatDateParts(dp);
    if (year) { proposal.year = year; proposal.provenance.year = "crossref"; }
    if (date && date !== String(year)) { proposal.publicationDate = date; proposal.provenance.publicationDate = "crossref"; }
    const publication = cleanString(work["container-title"]?.[0], 300);
    if (publication) proposal.publication = publication;
    return proposal;
  } catch {
    return null;
  }
}

// Narrowly-scoped date detective for the dateless case (a digital magazine PDF
// with no printed date). It is anchored on the title and author we already
// have, so it resolves a specific gap rather than establishing identity from
// scratch — and if it cannot confirm a date, the field stays empty.
async function webPublicationDate(
  title: string,
  authors: string[] | undefined,
  publication: string | undefined,
  openai: OpenAI,
  model: string,
): Promise<{ year?: number; publicationDate?: string } | null> {
  const who = authors?.length ? ` by ${authors.slice(0, 3).join(", ")}` : "";
  const where = publication ? ` in ${publication}` : "";
  const isGpt5 = /^gpt-5(?:-|$)/i.test(model);
  try {
    const response = await openai.responses.create({
      model,
      tools: [{ type: "web_search" }],
      instructions: [
        "You find the ORIGINAL publication date of one specific known work using web search.",
        "The work's title and author are given; do not identify a different work. Search for that exact work, and report the date it was first published.",
        "If you cannot find a confident date for this specific work, say so. Never guess.",
        'After searching, return ONLY a JSON object as your final message: {"found": boolean, "year": integer|null, "publicationDate": string|null}. publicationDate is ISO (YYYY-MM-DD) when the full date is known, otherwise the most precise form available (e.g. "2015-09").',
      ].join(" "),
      input: `Find the original publication date of the work titled "${title}"${who}${where}.`,
      // Web search + reasoning both draw on the output budget; give the final
      // JSON room, and cap reasoning so it does not consume the whole budget.
      max_output_tokens: 4_000,
      store: false,
      ...(isGpt5 ? { reasoning: { effort: "low" as const }, text: { verbosity: "low" as const } } : {}),
    }, { timeout: 90_000 });
    const parsed = parseJsonLoose(response.output_text ?? "");
    if (!parsed) {
      console.error(`[suminar] webdate: no parseable JSON (status=${response.status}, text=${JSON.stringify((response.output_text ?? "").slice(0, 200))})`);
      return null;
    }
    if (parsed.found !== true) return null;
    const year = cleanYear(parsed.year);
    const publicationDate = cleanString(parsed.publicationDate, 100);
    return year || publicationDate ? { ...(year ? { year } : {}), ...(publicationDate ? { publicationDate } : {}) } : null;
  } catch (error) {
    console.error(`[suminar] webdate search failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

export async function deriveMetadata(opts: {
  frontMatter: string;
  openai: OpenAI;
  model: string;
  allowWeb?: boolean;
}): Promise<MetadataProposal> {
  const proposal = await extractFromDocument(opts.frontMatter, opts.openai, opts.model);

  if (proposal.doi) {
    const crossref = await crossrefLookup(proposal.doi);
    if (crossref) {
      // Crossref is authoritative; it overrides the document read field-by-field.
      if (crossref.title !== undefined) { proposal.title = crossref.title; proposal.provenance.title = "crossref"; }
      if (crossref.authors !== undefined) { proposal.authors = crossref.authors; proposal.provenance.authors = "crossref"; }
      if (crossref.year !== undefined) { proposal.year = crossref.year; proposal.provenance.year = "crossref"; }
      if (crossref.publicationDate !== undefined) { proposal.publicationDate = crossref.publicationDate; proposal.provenance.publicationDate = "crossref"; }
      if (crossref.publication) proposal.publication = crossref.publication;
    } else {
      proposal.notes.push("A DOI was found but Crossref did not return a record.");
    }
  }

  // Web search only for a genuinely missing date, and only with a title to
  // anchor on. A DOI'd paper already has its date from Crossref.
  if (opts.allowWeb && proposal.title && !proposal.publicationDate && !proposal.year) {
    const web = await webPublicationDate(proposal.title, proposal.authors, proposal.publication, opts.openai, opts.model);
    if (web?.year) { proposal.year = web.year; proposal.provenance.year = "web"; }
    if (web?.publicationDate) { proposal.publicationDate = web.publicationDate; proposal.provenance.publicationDate = "web"; }
    if (!web) proposal.notes.push("The publication date could not be determined; please add it.");
  }
  return proposal;
}
