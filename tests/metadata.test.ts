import { describe, it, expect, vi, afterEach } from "vitest";
import { deriveMetadata } from "../src/suminar/metadata.js";
import type OpenAI from "openai";

// A stub OpenAI whose responses.create returns canned output_text in order:
// the first call is the front-matter extraction, the second (if any) the web
// date search.
function stubOpenAI(...outputs: string[]): OpenAI {
  let i = 0;
  return {
    responses: { create: async () => ({ output_text: outputs[i++] ?? "{}", status: "completed" }) },
  } as unknown as OpenAI;
}

describe("deriveMetadata", () => {
  afterEach(() => vi.restoreAllMocks());

  it("extracts from the document and rejects email/affiliation decoys as authors", async () => {
    const openai = stubOpenAI(JSON.stringify({
      title: "Some Empirical Paper", authors: ["Jane Doe", "jane@example.edu", "Department of Economics"],
      year: 2019, publicationDate: null, doi: null, publication: "A Journal",
    }));
    const p = await deriveMetadata({ frontMatter: "front matter text", openai, model: "gpt-5", allowWeb: false });
    expect(p.title).toBe("Some Empirical Paper");
    expect(p.authors).toEqual(["Jane Doe"]);
    expect(p.year).toBe(2019);
    expect(p.provenance).toMatchObject({ title: "document", authors: "document", year: "document" });
  });

  it("never fabricates: a document with nothing extractable yields empty fields, no provenance", async () => {
    const openai = stubOpenAI(JSON.stringify({ title: null, authors: null, year: null, publicationDate: null, doi: null, publication: null }));
    const p = await deriveMetadata({ frontMatter: "opaque scan", openai, model: "gpt-5", allowWeb: false });
    expect(p.title).toBeUndefined();
    expect(p.authors).toBeUndefined();
    expect(p.year).toBeUndefined();
    expect(Object.keys(p.provenance)).toHaveLength(0);
  });

  it("discards an implausible year rather than trusting it", async () => {
    const openai = stubOpenAI(JSON.stringify({ title: "T", authors: ["A B"], year: 99, doi: null }));
    const p = await deriveMetadata({ frontMatter: "x", openai, model: "gpt-5", allowWeb: false });
    expect(p.year).toBeUndefined();
  });

  it("refines authoritatively via Crossref when a DOI is present, overriding the document read", async () => {
    const openai = stubOpenAI(JSON.stringify({ title: "Rough Draft Title", authors: ["Someone Uncertain"], year: null, doi: "10.1000/abc.123", publication: null }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({
      message: {
        title: ["The Authoritative Title"],
        author: [{ given: "Alan", family: "Turing" }],
        issued: { "date-parts": [[1950, 10]] },
        "container-title": ["Mind"],
      },
    }), { status: 200 }));
    const p = await deriveMetadata({ frontMatter: "has a doi", openai, model: "gpt-5", allowWeb: false });
    expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("api.crossref.org/works/10.1000%2Fabc.123"), expect.anything());
    expect(p.title).toBe("The Authoritative Title");
    expect(p.authors).toEqual(["Alan Turing"]);
    expect(p.year).toBe(1950);
    expect(p.publicationDate).toBe("1950-10");
    expect(p.provenance.title).toBe("crossref");
    expect(p.provenance.year).toBe("crossref");
  });

  it("fills a missing date from a scoped web search, stamped web provenance", async () => {
    const openai = stubOpenAI(
      JSON.stringify({ title: "The Coddling of the American Mind", authors: ["Greg Lukianoff", "Jonathan Haidt"], year: null, doi: null, publication: "The Atlantic" }),
      JSON.stringify({ found: true, year: 2015, publicationDate: "2015-08-11" }),
    );
    const p = await deriveMetadata({ frontMatter: "dateless essay", openai, model: "gpt-5", allowWeb: true });
    expect(p.year).toBe(2015);
    expect(p.publicationDate).toBe("2015-08-11");
    expect(p.provenance.year).toBe("web");
    expect(p.provenance.publicationDate).toBe("web");
  });

  it("leaves the date blank and notes it when the web cannot confirm one", async () => {
    const openai = stubOpenAI(
      JSON.stringify({ title: "An Obscure Note", authors: ["Nobody Famous"], year: null, doi: null, publication: null }),
      JSON.stringify({ found: false, year: null, publicationDate: null }),
    );
    const p = await deriveMetadata({ frontMatter: "dateless", openai, model: "gpt-5", allowWeb: true });
    expect(p.year).toBeUndefined();
    expect(p.publicationDate).toBeUndefined();
    expect(p.notes.some((n) => /date/i.test(n))).toBe(true);
  });

  it("does not web-search when a year is already known (no gap to fill)", async () => {
    const openai = stubOpenAI(JSON.stringify({ title: "Dated Work", authors: ["A"], year: 2001, doi: null }));
    const spy = vi.spyOn(globalThis, "fetch");
    const p = await deriveMetadata({ frontMatter: "x", openai, model: "gpt-5", allowWeb: true });
    expect(p.year).toBe(2001);
    expect(p.provenance.year).toBe("document");
    // No DOI and a known year → neither Crossref nor web search should run.
    expect(spy).not.toHaveBeenCalled();
  });

  it("tolerates code-fenced JSON from the model", async () => {
    const openai = stubOpenAI("```json\n{\"title\": \"Fenced\", \"authors\": [\"X Y\"], \"year\": 2020}\n```");
    const p = await deriveMetadata({ frontMatter: "x", openai, model: "gpt-5", allowWeb: false });
    expect(p.title).toBe("Fenced");
    expect(p.year).toBe(2020);
  });
});
