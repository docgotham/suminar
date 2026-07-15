import OpenAI from "openai";
import type { ChunkRecord, RetrievedPassage } from "../core/types.js";
import type { EmbeddingRecord } from "./artifacts.js";

export interface RetrievalOptions {
  quotationSearch?: boolean;
}

export interface QuotationBoundaryCandidate {
  pages: number[];
  text: string;
}

export interface QuotationSnippetCandidate {
  pages: number[];
  text: string;
  wordCount: number;
  score: number;
}

export interface SourceOccurrenceMatch {
  term: string;
  page: number;
  location: string;
  excerpt: string;
  occurrencesInPassage: number;
}

export interface SourceOccurrenceResult {
  term: string;
  totalOccurrences: number;
  pages: number[];
  matches: SourceOccurrenceMatch[];
}

export interface WholeSourceOccurrenceSearch {
  searchedAllPassages: true;
  passageCount: number;
  results: SourceOccurrenceResult[];
  evidencePassages: RetrievedPassage[];
}

function countExactOccurrences(text: string, term: string): { count: number; firstIndex: number } {
  const haystack = normalizeQuotationText(text).toLocaleLowerCase();
  const needle = normalizeQuotationText(term).toLocaleLowerCase();
  if (!needle) return { count: 0, firstIndex: -1 };
  let count = 0;
  let firstIndex = -1;
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index < 0) break;
    const before = index > 0 ? haystack[index - 1]! : "";
    const after = index + needle.length < haystack.length ? haystack[index + needle.length]! : "";
    if (!/[\p{L}\p{N}]/u.test(before) && !/[\p{L}\p{N}]/u.test(after)) {
      count += 1;
      if (firstIndex < 0) firstIndex = index;
    }
    offset = index + Math.max(needle.length, 1);
  }
  return { count, firstIndex };
}

function occurrenceExcerpt(text: string, index: number, termLength: number): string {
  const normalized = normalizeQuotationText(text);
  if (index < 0) return normalized.slice(0, 360);
  const start = Math.max(0, index - 140);
  const end = Math.min(normalized.length, index + termLength + 220);
  return `${start > 0 ? "…" : ""}${normalized.slice(start, end).trim()}${end < normalized.length ? "…" : ""}`;
}

function occurrenceMatches(chunks: ChunkRecord[], term: string, limit = 4): { total: number; pages: number[]; matches: SourceOccurrenceMatch[]; passages: RetrievedPassage[] } {
  let total = 0;
  const pages = new Set<number>();
  const matches: SourceOccurrenceMatch[] = [];
  const passages: RetrievedPassage[] = [];
  for (const chunk of chunks) {
    const found = countExactOccurrences(chunk.text, term);
    if (!found.count) continue;
    total += found.count;
    pages.add(chunk.page);
    if (matches.length < limit) {
      matches.push({
        term,
        page: chunk.page,
        location: chunk.location,
        excerpt: occurrenceExcerpt(chunk.text, found.firstIndex, term.length),
        occurrencesInPassage: found.count,
      });
      passages.push({ ...chunk, text: chunk.text.slice(0, 2_000), score: 100, role: "match" });
    }
  }
  return { total, pages: [...pages].sort((a, b) => a - b), matches, passages };
}

export function searchWholeSourceOccurrences(chunks: ChunkRecord[], requestedTerms: string[], expectedAgentId: string): WholeSourceOccurrenceSearch {
  const foreignChunk = chunks.find((chunk) => chunk.agentId !== expectedAgentId);
  if (foreignChunk) throw new Error(`Cross-source evidence isolation failure: expected ${expectedAgentId}, found ${foreignChunk.agentId}`);
  const evidenceByChunk = new Map<string, RetrievedPassage>();
  const results = requestedTerms.map((term) => {
    const exact = occurrenceMatches(chunks, term);
    for (const passage of exact.passages) evidenceByChunk.set(passage.chunkId, passage);
    return {
      term,
      totalOccurrences: exact.total,
      pages: exact.pages,
      matches: exact.matches,
    };
  });
  return {
    searchedAllPassages: true,
    passageCount: chunks.length,
    results,
    evidencePassages: [...evidenceByChunk.values()].slice(0, 8),
  };
}

function terms(value: string): string[] {
  return [...new Set(value.toLowerCase().match(/[a-z0-9]{3,}/g) ?? [])]
    .filter((term) => !new Set(["the", "and", "for", "that", "this", "with", "from", "your", "paper", "source"]).has(term));
}

function lexicalScore(text: string, queryTerms: string[]): number {
  const normalized = text.toLowerCase();
  return queryTerms.reduce((score, term) => {
    const hits = normalized.split(term).length - 1;
    return score + Math.min(hits, 5);
  }, 0);
}

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index]! * b[index]!;
    normA += a[index]! ** 2;
    normB += b[index]! ** 2;
  }
  return normA && normB ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0;
}

async function queryEmbedding(query: string, model: string): Promise<number[] | undefined> {
  if (!process.env.OPENAI_API_KEY) return undefined;
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const response = await client.embeddings.create({ model, input: query });
  return response.data[0]?.embedding;
}

export async function retrievePassages(
  chunks: ChunkRecord[],
  embeddings: EmbeddingRecord[],
  query: string,
  limit: number,
  expectedAgentId: string,
  options: RetrievalOptions = {},
): Promise<RetrievedPassage[]> {
  if (!chunks.length) return [];
  const foreignChunk = chunks.find((chunk) => chunk.agentId !== expectedAgentId);
  if (foreignChunk) {
    throw new Error(`Cross-source evidence isolation failure: expected ${expectedAgentId}, found ${foreignChunk.agentId}`);
  }
  const queryTerms = terms(query);
  const chunkIds = new Set(chunks.map((chunk) => chunk.chunkId));
  const foreignEmbedding = embeddings.find((row) => !chunkIds.has(row.chunkId));
  if (foreignEmbedding) {
    throw new Error(`Cross-source embedding isolation failure: unknown chunk ${foreignEmbedding.chunkId}`);
  }
  const embeddingByChunk = new Map(embeddings.map((row) => [row.chunkId, row.embedding]));
  const model = embeddings[0]?.model;
  let queryVector: number[] | undefined;
  if (model && embeddingByChunk.size) {
    try { queryVector = await queryEmbedding(query, model); } catch { queryVector = undefined; }
  }

  const scored = chunks.map((chunk) => {
    const lexical = lexicalScore(chunk.text, queryTerms);
    const vector = queryVector && embeddingByChunk.get(chunk.chunkId)
      ? Math.max(0, cosine(queryVector, embeddingByChunk.get(chunk.chunkId)!))
      : 0;
    return { chunk, score: lexical + vector * 10 };
  }).sort((a, b) => b.score - a.score || a.chunk.chunkIndex - b.chunk.chunkIndex);

  const byIndex = new Map(chunks.map((chunk) => [chunk.chunkIndex, chunk]));
  const selected = new Map<number, RetrievedPassage>();
  const seeds = scored.filter((row) => row.score > 0).slice(0, Math.max(1, Math.ceil(limit / 3)));
  if (!seeds.length) seeds.push(...scored.slice(0, 1));
  for (const seed of seeds) {
    for (const offset of [-1, 0, 1]) {
      if (selected.size >= limit) break;
      const chunk = byIndex.get(seed.chunk.chunkIndex + offset);
      if (!chunk || selected.has(chunk.chunkIndex)) continue;
      selected.set(chunk.chunkIndex, {
        ...chunk,
        text: chunk.text.slice(0, options.quotationSearch ? 2_000 : 900),
        score: seed.score,
        role: offset === 0 ? "match" : offset < 0 ? "context_before" : "context_after",
      });
    }
  }
  return [...selected.values()].sort((a, b) => a.chunkIndex - b.chunkIndex).slice(0, limit);
}

function isLikelyPageHeader(line: string): boolean {
  const compact = line.trim().replace(/\s+/g, " ");
  if (!compact || compact.length > 80) return false;
  const hasPageNumber = /(?:^|\s)(?:\d{1,4}|[ivxlcdm]{1,12})(?:\s|$)/i.test(compact);
  const hasUppercaseLabel = /\b[A-Z][A-Z\s]{2,}\b/.test(compact);
  return hasPageNumber && hasUppercaseLabel;
}

function withoutLeadingPageHeader(text: string): string {
  const lines = text.split(/\r?\n/);
  while (lines.length && !lines[0]!.trim()) lines.shift();
  if (lines.length && isLikelyPageHeader(lines[0]!)) lines.shift();
  return lines.join("\n");
}

export function normalizeQuotationText(value: string): string {
  return value.normalize("NFC")
    .replace(/\u00ad\s*/g, "")
    .replace(/-\s*\r?\n\s*(?=[a-z])/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function continuousGroups(passages: RetrievedPassage[]): Array<{ pages: number[]; text: string }> {
  const sorted = [...passages].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const groups: Array<{ lastChunkIndex: number; lastPage: number; pages: number[]; text: string }> = [];
  for (const passage of sorted) {
    const previous = groups.at(-1);
    if (!previous || passage.chunkIndex !== previous.lastChunkIndex + 1) {
      groups.push({
        lastChunkIndex: passage.chunkIndex,
        lastPage: passage.page,
        pages: [passage.page],
        text: passage.text,
      });
      continue;
    }
    const crossedPage = passage.page !== previous.lastPage;
    previous.text += `\n${crossedPage ? withoutLeadingPageHeader(passage.text) : passage.text}`;
    previous.lastChunkIndex = passage.chunkIndex;
    previous.lastPage = passage.page;
    if (!previous.pages.includes(passage.page)) previous.pages.push(passage.page);
  }
  return groups.map(({ pages, text }) => ({ pages, text: normalizeQuotationText(text) }));
}

export function quotationAppearsInPassages(quotation: string, passages: RetrievedPassage[]): boolean {
  return quotationMatchingPages(quotation, passages) !== undefined;
}

export function quotationMatchingPages(quotation: string, passages: RetrievedPassage[]): number[] | undefined {
  const normalizedQuotation = normalizeQuotationText(quotation);
  const sorted = [...passages].sort((a, b) => a.chunkIndex - b.chunkIndex);
  for (const passage of sorted) {
    if (normalizeQuotationText(passage.text).includes(normalizedQuotation)) return [passage.page];
  }
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const before = sorted[index]!;
    const after = sorted[index + 1]!;
    if (after.chunkIndex !== before.chunkIndex + 1) continue;
    const afterText = after.page === before.page ? after.text : withoutLeadingPageHeader(after.text);
    const joined = normalizeQuotationText(`${before.text}\n${afterText}`);
    if (joined.includes(normalizedQuotation)) return [...new Set([before.page, after.page])];
  }
  const group = continuousGroups(passages).find((candidate) => candidate.text.includes(normalizedQuotation));
  return group?.pages;
}

export function quotationBoundaryCandidates(passages: RetrievedPassage[]): QuotationBoundaryCandidate[] {
  const sorted = [...passages].sort((a, b) => a.chunkIndex - b.chunkIndex);
  const candidates: QuotationBoundaryCandidate[] = [];
  for (let index = 0; index < sorted.length - 1; index += 1) {
    const before = sorted[index]!;
    const after = sorted[index + 1]!;
    if (after.chunkIndex !== before.chunkIndex + 1 || after.page === before.page) continue;
    const beforeText = normalizeQuotationText(before.text);
    const afterText = normalizeQuotationText(withoutLeadingPageHeader(after.text));
    candidates.push({
      pages: [before.page, after.page],
      text: `${beforeText.slice(-700)} ${afterText.slice(0, 700)}`.trim(),
    });
  }
  return candidates;
}

function quotationQueryRoots(value: string): string[] {
  return terms(value).map((term) => term
    .replace(/(?:ingly|edly|ing|ed|ly|es|s)$/i, "")
    .slice(0, 10))
    .filter((term) => term.length >= 4);
}

export function quotationSnippetCandidates(
  passages: RetrievedPassage[],
  query: string,
  maxWords: number,
  limit = 8,
): QuotationSnippetCandidate[] {
  if (maxWords < 5) return [];
  const roots = quotationQueryRoots(query);
  const seen = new Set<string>();
  const candidates: QuotationSnippetCandidate[] = [];
  for (const group of continuousGroups(passages)) {
    const sentences = group.text.split(/(?<=[.!?])\s+(?=[A-Z“])/u);
    for (const sentence of sentences) {
      const variants = [sentence.trim()];
      for (const match of sentence.matchAll(/[,;:]\s+/g)) {
        variants.push(sentence.slice(match.index + match[0].length).trim());
      }
      for (const variant of variants) {
        const text = variant.trim();
        const wordCount = text.match(/\S+/gu)?.length ?? 0;
        if (wordCount < 5 || wordCount > maxWords || seen.has(text) || /[“”"]/.test(text)) continue;
        const normalized = text.toLowerCase();
        const score = roots.reduce((total, root) => total + (normalized.includes(root) ? 1 : 0), 0);
        if (!score) continue;
        const pages = quotationMatchingPages(text, passages) ?? group.pages;
        seen.add(text);
        candidates.push({ pages, text, wordCount, score });
      }
    }
  }
  return candidates
    .sort((a, b) => b.score - a.score || b.wordCount - a.wordCount || a.text.localeCompare(b.text))
    .slice(0, limit);
}
