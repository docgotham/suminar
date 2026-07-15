import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { IngestionService } from "../src/suminar/ingestion.js";
import {
  quotationAppearsInPassages,
  quotationBoundaryCandidates,
  quotationMatchingPages,
  quotationSnippetCandidates,
  retrievePassages,
  searchWholeSourceOccurrences,
} from "../src/suminar/retrieval.js";
import { readJsonlFile } from "../src/suminar/artifacts.js";
import type { EmbeddingRecord } from "../src/suminar/artifacts.js";
import type { ChunkRecord } from "../src/core/types.js";
import type { RetrievedPassage } from "../src/core/types.js";
import { LocalStore } from "../src/core/storage.js";
import { cleanup, fixturesDir, generateFixtures, temporaryConfig } from "./helpers.js";

const config = temporaryConfig();
const store = new LocalStore(config.dataDir);
const ingestion = new IngestionService(config, store);

describe("private PDF ingestion", () => {
  beforeAll(generateFixtures);
  afterAll(() => cleanup(config));

  it("preserves an immutable original and creates page-aware private derivatives", async () => {
    const manifest = await ingestion.ingest(path.join(fixturesDir, "clean.pdf"), { year: 2024, handle: "scholar-2024" });
    expect(manifest.extractionStatus).toBe("clean");
    expect(manifest.card.handle).toBe("scholar-2024");
    expect(manifest.card.capabilities).toContain("occurrence_search");
    expect(fs.existsSync(manifest.privateArtifacts.originalPdf)).toBe(true);
    expect(fs.readFileSync(manifest.privateArtifacts.markdown, "utf8")).toContain("<!-- page: 2 -->");
    expect(fs.readFileSync(manifest.privateArtifacts.chunks, "utf8")).toMatch(/"page":\s*2/);
    expect(JSON.stringify(manifest.card)).not.toContain(manifest.privateArtifacts.originalPdf);
    const duplicate = await ingestion.ingest(path.join(fixturesDir, "clean.pdf"), { year: 2024, handle: "scholar-2024" });
    expect(duplicate.agentId).toBe(manifest.agentId);
    await expect(retrievePassages(
      readJsonlFile<ChunkRecord>(manifest.privateArtifacts.chunks),
      manifest.privateArtifacts.embeddings ? readJsonlFile<EmbeddingRecord>(manifest.privateArtifacts.embeddings) : [],
      "structured disagreement",
      8,
      "agent_from_another_source",
    )).rejects.toThrow(/Cross-source evidence isolation failure/);
  });

  it("uses a complete private-source lane for positive and negative occurrence questions", async () => {
    const manifest = store.listLocalAgentManifests().find((candidate) => candidate.card.handle === "scholar-2024");
    expect(manifest).toBeDefined();
    const result = searchWholeSourceOccurrences(
      readJsonlFile<ChunkRecord>(manifest!.privateArtifacts.chunks),
      ["Dana Scholar", "Glenn Loury"],
      manifest!.agentId,
    );
    expect(result.searchedAllPassages).toBe(true);
    expect(result.results[0]?.totalOccurrences).toBeGreaterThan(0);
    expect(result.results[0]?.pages).toEqual([1, 2, 3]);
    expect(result.results[1]).toMatchObject({ term: "Glenn Loury", totalOccurrences: 0, pages: [] });
    expect(result.evidencePassages.every((passage) => passage.agentId === manifest!.agentId)).toBe(true);
  });

  it("flags image-only PDFs for explicit OCR and distinguishes revisions", async () => {
    const scanned = await ingestion.ingest(path.join(fixturesDir, "scanned.pdf"));
    const revised = await ingestion.ingest(path.join(fixturesDir, "revised.pdf"));
    expect(scanned.extractionStatus).toBe("needs_ocr");
    expect(revised.agentId).not.toBe(store.listLocalAgentManifests().find((item) => item.card.handle === "scholar-2024")?.agentId);
  });

  it("reconstructs a verifiable quotation across a PDF page header and chunk boundary", () => {
    const passages: RetrievedPassage[] = [
      {
        chunkId: "before",
        agentId: "agent_test",
        chunkIndex: 11,
        page: 7,
        location: "page 7",
        text: "As such, to take account of race while trying to mitigate the effects of this subordination, cannot plausibly be seen as the moral equivalent of the discrimination that",
        tokenEstimate: 30,
        score: 10,
        role: "match",
      },
      {
        chunkId: "after",
        agentId: "agent_test",
        chunkIndex: 12,
        page: 8,
        location: "page 8",
        text: "xxvi FOREWORD\nproduced the subjugation of blacks in the first place. To do so would be to mire oneself in a-historical formalism.",
        tokenEstimate: 24,
        score: 10,
        role: "context_after",
      },
    ];
    const quotation = "cannot plausibly be seen as the moral equivalent of the discrimination that produced the subjugation of blacks in the first place.";
    expect(quotationAppearsInPassages(quotation, passages)).toBe(true);
    expect(quotationMatchingPages(quotation, passages)).toEqual([7, 8]);
    expect(quotationBoundaryCandidates(passages)[0]?.text).toContain(quotation);
    expect(quotationBoundaryCandidates(passages)[0]?.text).not.toContain("xxvi FOREWORD");
    expect(quotationSnippetCandidates(passages, "Why is remedial policy not morally equivalent to discrimination?", 30)
      .some((candidate) => candidate.text === quotation && candidate.pages.join("-") === "7-8")).toBe(true);
  });

  it("rejects malformed PDFs without creating a public agent", async () => {
    await expect(ingestion.ingest(path.join(fixturesDir, "malformed.pdf"))).rejects.toThrow();
  });
});
