import { describe, expect, it } from "vitest";
import { deriveDisplayName, handleCandidates, invertFirstAuthor, isCorporateAuthor, mainTitle, mlaAuthorsLabel, mlaCitationParts, mlaShortTitle, orgHandlePrefix, significantTitleWords, surnameOf } from "../src/suminar/naming.js";

// The MLA convention: scholars disambiguate one author's works with shortened
// titles, not dates — so derived handles are surname + short title, display
// names read like Works Cited short forms, and years appear only as a last
// resort. Same author, same year is a non-event.

describe("surname extraction", () => {
  it("takes the last name, keeps particles, skips suffixes", () => {
    expect(surnameOf("Thomas Sowell")).toBe("Sowell");
    expect(surnameOf("Glenn C. Loury")).toBe("Loury");
    expect(surnameOf("W.E.B. Du Bois")).toBe("Du Bois");
    expect(surnameOf("Martin Luther King Jr.")).toBe("King");
    expect(surnameOf("Jan van der Berg")).toBe("van der Berg");
    expect(surnameOf("Sowell")).toBe("Sowell");
    expect(surnameOf("  ")).toBe("");
  });

  it("reads Works Cited inversion: a comma puts the surname first", () => {
    expect(surnameOf("Sowell, Thomas")).toBe("Sowell");
    expect(surnameOf("Du Bois, W.E.B.")).toBe("Du Bois");
    expect(surnameOf("van der Berg, Jan")).toBe("van der Berg");
    expect(surnameOf("King, Martin Luther, Jr.")).toBe("King");
    // A comma followed only by a suffix is NOT an inversion.
    expect(surnameOf("Martin Luther King, Jr.")).toBe("King");
  });

  it("derives the same handle from either author order", () => {
    const natural = handleCandidates({ authors: ["Thomas Sowell"], title: "Basic Economics", year: 2004 })[0];
    const inverted = handleCandidates({ authors: ["Sowell, Thomas"], title: "Basic Economics", year: 2004 })[0];
    expect(natural).toBe("sowell-basic-economics");
    expect(inverted).toBe(natural);
  });
});

describe("shortened titles", () => {
  it("drops subtitles and stopwords, keeps substance", () => {
    expect(significantTitleWords("Affirmative Action Around the World: An Empirical Study"))
      .toEqual(["Affirmative", "Action", "Around", "World"]);
    expect(significantTitleWords("The Shape of the River")).toEqual(["Shape", "River"]);
    expect(significantTitleWords("Foreword to The Shape of the River")).toEqual(["Foreword", "Shape", "River"]);
  });

  it("keeps stopword-only titles rather than emptying them", () => {
    expect(significantTitleWords("Of the And")).toEqual(["Of", "the", "And"]);
  });

  it("treats a spaced dash as a subtitle boundary (browser save-as tails)", () => {
    expect(significantTitleWords("A Great Man, Warts and All – Commentary Magazine"))
      .toEqual(["Great", "Man", "Warts", "All"]);
    expect(significantTitleWords("Race and Economics - A Study")).toEqual(["Race", "Economics"]);
    // Unspaced hyphens are word-internal and survive.
    expect(significantTitleWords("The Semi-Detached House")).toEqual(["Semi-Detached", "House"]);
    expect(deriveDisplayName({ authors: ["Wilfred Reilly"], title: "A Great Man, Warts and All – Commentary Magazine", year: 2023 }))
      .toBe("Reilly, A Great Man, Warts and All (2023)");
  });
});

describe("handle candidates", () => {
  it("leads with surname + two significant title words (the five-Sowell shelf)", () => {
    expect(handleCandidates({ authors: ["Thomas Sowell"], title: "Affirmative Action Around the World: An Empirical Study", year: 2004 })[0])
      .toBe("sowell-affirmative-action");
    expect(handleCandidates({ authors: ["Thomas Sowell"], title: "Basic Economics", year: 2004 })[0])
      .toBe("sowell-basic-economics");
    expect(handleCandidates({ authors: ["Thomas Sowell"], title: "The Vision of the Anointed", year: 1995 })[0])
      .toBe("sowell-vision-anointed");
    expect(handleCandidates({ authors: ["W.E.B. Du Bois"], title: "The Souls of Black Folk", year: 1903 })[0])
      .toBe("du-bois-souls-black");
  });

  it("extends by title words before reaching for the year", () => {
    const candidates = handleCandidates({ authors: ["Thomas Sowell"], title: "Affirmative Action Around the World: An Empirical Study", year: 2004 });
    expect(candidates[1]).toBe("sowell-affirmative-action-around");
    expect(candidates[2]).toBe("sowell-affirmative-action-around-world");
    expect(candidates[3]).toBe("sowell-affirmative-action-around-world-2004");
  });

  it("degrades gracefully without authors, and never to nothing", () => {
    // A space-less filename slug is split on its hyphens into real words.
    const slug = handleCandidates({ authors: [], title: "shape-river-foreword" });
    expect(slug[0]).toBe("shape-river");
    expect(slug).toContain("shape-river-foreword");
    const empty = handleCandidates({ authors: [], title: "" });
    expect(empty[0]).toBe("source");
    expect(empty[1]).toBe("source-2");
  });

  it("terminates and stays bounded on a metadata-less filename-slug upload", () => {
    // The exact shape that hung ingestion to the 300s function kill: no
    // authors + a long hyphen-slug title that truncates to slugifyName's
    // 100-char cap. handleCandidates must return quickly, bounded, distinct.
    const identity = {
      authors: [],
      title: "the-college-campus-and-the-culture-war-the-development-of-party-polarization-on-higher-education-1980-2025",
      year: 2026,
    };
    const start = Date.now();
    const candidates = handleCandidates(identity);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(12);
    expect(new Set(candidates).size).toBe(candidates.length);
    expect(candidates.every((c) => c.length > 0 && c.length <= 100)).toBe(true);
    expect(candidates[0]).toBe("college-campus");
  });

  it("always terminates even on a single over-long title token with no separators", () => {
    // Defense in depth: a pathological one-word title (no spaces, no hyphens)
    // still yields a bounded list rather than spinning the disambiguation loop.
    const candidates = handleCandidates({ authors: [], title: "a".repeat(400), year: 2026 });
    expect(candidates.length).toBeGreaterThan(0);
    expect(candidates.length).toBeLessThanOrEqual(12);
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe("MLA citation parts", () => {
  it("inverts the first author for the entry head", () => {
    expect(invertFirstAuthor("Thomas Sowell")).toBe("Sowell, Thomas");
    expect(invertFirstAuthor("W.E.B. Du Bois")).toBe("Du Bois, W.E.B.");
    expect(invertFirstAuthor("Sowell, Thomas")).toBe("Sowell, Thomas");
    expect(invertFirstAuthor("Sowell")).toBe("Sowell");
  });

  it("labels one, two, and many authors MLA-style", () => {
    expect(mlaAuthorsLabel(["Thomas Sowell"])).toBe("Sowell, Thomas.");
    expect(mlaAuthorsLabel(["W.E.B. Du Bois"])).toBe("Du Bois, W.E.B.");
    expect(mlaAuthorsLabel(["William G. Bowen", "Derek Bok"])).toBe("Bowen, William G., and Derek Bok.");
    expect(mlaAuthorsLabel(["A One", "B Two", "C Three"])).toBe("One, A, et al.");
    expect(mlaAuthorsLabel([])).toBeUndefined();
  });

  it("keeps the full title in the formal record and passes the year through", () => {
    const parts = mlaCitationParts({ authors: ["Thomas Sowell"], title: "Affirmative Action Around the World: An Empirical Study", year: 2004 });
    expect(parts).toEqual({
      authorsLabel: "Sowell, Thomas.",
      title: "Affirmative Action Around the World: An Empirical Study",
      shortTitle: "Affirmative Action",
      year: 2004,
    });
    expect(mlaCitationParts({ authors: [], title: "Basic Economics" })).toEqual({ title: "Basic Economics" });
  });
});

describe("display names", () => {
  it("reads like a Works Cited short form", () => {
    expect(deriveDisplayName({ authors: ["Thomas Sowell"], title: "Affirmative Action Around the World: An Empirical Study", year: 2004 }))
      .toBe("Sowell, Affirmative Action Around the World (2004)");
    expect(deriveDisplayName({ authors: ["W.E.B. Du Bois"], title: "The Souls of Black Folk", year: 1903 }))
      .toBe("Du Bois, The Souls of Black Folk (1903)");
    expect(deriveDisplayName({ authors: [], title: "Basic Economics", year: 2004 })).toBe("Basic Economics (2004)");
    expect(deriveDisplayName({ authors: ["Thomas Sowell"], title: "Basic Economics" })).toBe("Sowell, Basic Economics");
    expect(deriveDisplayName({ authors: [], title: "" })).toBe("Untitled source");
  });

  it("caps very long main titles at a word boundary", () => {
    const long = deriveDisplayName({ authors: ["Someone Longwinded"], title: "A ".repeat(10) + "Genuinely Interminable Meandering Extended Discourse Upon Matters Various" });
    expect(long.length).toBeLessThan(90);
    expect(long.endsWith(")")).toBe(false);
  });
});

describe("sentence-boundary titles", () => {
  // The live case: an authorless two-sentence essay title whose display name
  // truncated mid-clause at "…Academic Hiring Is" (2026-07-16).
  const essay = "The Evidence for Political Bias in Academic Hiring Is Circumstantial. It Is Also Persuasive.";

  it("cuts the main title at the first sentence, like a subtitle", () => {
    expect(mainTitle(essay)).toBe("The Evidence for Political Bias in Academic Hiring Is Circumstantial");
    expect(deriveDisplayName({ authors: [], title: essay }))
      .toBe("The Evidence for Political Bias in Academic Hiring Is Circumstantial");
    expect(deriveDisplayName({ authors: [], title: essay, year: 2025 }))
      .toBe("The Evidence for Political Bias in Academic Hiring Is Circumstantial (2025)");
  });

  it("keeps a ? or ! as part of the first sentence", () => {
    expect(mainTitle("Who Governs? Democracy and Power in an American City")).toBe("Who Governs?");
  });

  it("does not mistake abbreviations or initials for sentence ends", () => {
    expect(mainTitle("Mr. Smith Goes to Washington")).toBe("Mr. Smith Goes to Washington");
    expect(mainTitle("U.S. Policy After the War")).toBe("U.S. Policy After the War");
    expect(mainTitle("Vol. 2 of the Collected Works")).toBe("Vol. 2 of the Collected Works");
  });

  it("derives the MLA parenthetical short title", () => {
    expect(mlaShortTitle(essay)).toBe("The Evidence for Political Bias");
    expect(mlaShortTitle("Silence in the Classroom: The 2024 FIRE Faculty Survey Report")).toBe("Silence in the Classroom");
    // A weak trailing word steps back: never end a short title on "Around".
    expect(mlaShortTitle("Affirmative Action Around the World: An Empirical Study")).toBe("Affirmative Action");
    expect(mlaShortTitle("Political Party Affiliation Among Academic Faculty")).toBe("Political Party Affiliation");
    // Already short — unchanged, and mlaCitationParts omits a redundant copy.
    expect(mlaShortTitle("The Souls of Black Folk")).toBe("The Souls of Black Folk");
    expect(mlaCitationParts({ authors: [], title: "The Souls of Black Folk" }).shortTitle).toBeUndefined();
    expect(mlaCitationParts({ authors: [], title: essay }).shortTitle).toBe("The Evidence for Political Bias");
  });
});

describe("corporate authors", () => {
  it("detects organizations and leaves personal names alone", () => {
    expect(isCorporateAuthor("National Communication Association")).toBe(true);
    expect(isCorporateAuthor("RAND Corporation")).toBe(true);
    expect(isCorporateAuthor("Brookings Institution")).toBe(true);
    expect(isCorporateAuthor("Thomas Sowell")).toBe(false);
    expect(isCorporateAuthor("W.E.B. Du Bois")).toBe(false);
  });

  it("builds a handle prefix from an acronym, or a single word", () => {
    expect(orgHandlePrefix("National Communication Association")).toBe("nca");
    expect(orgHandlePrefix("Pew Research Center")).toBe("prc");
    expect(orgHandlePrefix("Brookings")).toBe("brookings");
  });

  it("names a corporate-authored work by the org, uninverted, with an acronym handle", () => {
    const identity = { authors: ["National Communication Association"], title: "Political Party Affiliation Among Academic Faculty", year: 2017 };
    expect(handleCandidates(identity)[0]).toBe("nca-political-party");
    expect(deriveDisplayName(identity).startsWith("National Communication Association, Political Party Affiliation")).toBe(true);
    expect(invertFirstAuthor("National Communication Association")).toBe("National Communication Association");
    expect(mlaCitationParts(identity).authorsLabel).toBe("National Communication Association.");
    // a personal author is still inverted
    expect(invertFirstAuthor("Thomas Sowell")).toBe("Sowell, Thomas");
  });
});
