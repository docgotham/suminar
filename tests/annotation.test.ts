import { describe, expect, it } from "vitest";
import { buildAnnotationDraftPrompt, composeAnnotation, deriveAnnotation, mineAnnotation, mineFromChunks, sampleChunksForDraft } from "../src/suminar/annotation.js";

// The Commons-pattern annotation chain: supplied wins, the source's own
// opening text is mined behind boilerplate filters and quality gates, and
// the composed floor only restates known metadata. Never fabricate.

const REILLY = { title: "A Great Man, Warts and All – Commentary Magazine", authors: ["Wilfred Reilly"], year: 2023, pageCount: 5 };

const REILLY_MARKDOWN = `# A Great Man, Warts and All – Commentary Magazine
By Wilfred Reilly
Subscribe
7/14/2023
[Page 1]
Thomas Sowell has been, for half a century, among the most consistently interesting social scientists in America, and his biographers inherit a record of unusual range.
This review takes the measure of that record with a critic's eye and an admirer's patience.`;

describe("mining the source's own opening text", () => {
  it("skips headings, bylines, dates, page markers, and reader chrome", () => {
    const mined = mineAnnotation(REILLY_MARKDOWN, REILLY);
    expect(mined).toBeDefined();
    expect(mined!.startsWith("Thomas Sowell has been")).toBe(true);
    expect(mined!).not.toContain("Subscribe");
    expect(mined!).not.toContain("[Page 1]");
    expect(mined!.length).toBeLessThanOrEqual(210);
  });

  it("strips the extraction pipeline's HTML comment headers (production shape)", () => {
    const production = `<!-- agent: agent8772e85ddd60bd43e49459d9 -->\n<!-- extraction: clean -->\nPreferential policies tend to expand over time, beyond their original scope and stated beneficiaries, and the record across countries diverges from adoption rationales.`;
    const mined = mineAnnotation(production, REILLY);
    expect(mined).toBeDefined();
    expect(mined!.startsWith("Preferential policies tend to expand")).toBe(true);
    expect(mined!).not.toContain("<!--");
    expect(mined!).not.toContain("agent8772");
  });

  it("skips book front matter: letter-spaced title pages, all-caps display, copyright legalese", () => {
    const bookOpening = `THE SHAPE OF THE RIVER
L O N G - T E R M C O N S E Q U E N C E S O F C O N S I D E R I N G R A C E
W ith a F o re w o rd b y G le n n C . L o u ry
Copyright ∫ 2004 by Thomas Sowell. All rights reserved. This book may not be reproduced, in whole or in part, including illustrations, in any form.
Published by Yale University Press with assistance from the foundation.
The argument of this book is that preferential policies must be judged by their results rather than their hopes, and the results have been measured across five countries with unusual care.`;
    const mined = mineAnnotation(bookOpening, { title: "The Shape of the River", authors: ["William G. Bowen"], pageCount: 285 });
    expect(mined).toBeDefined();
    expect(mined!.startsWith("The argument of this book")).toBe(true);
    expect(mined!).not.toContain("Copyright");
    expect(mined!).not.toContain("L O N G");
  });

  it("skips contributor lists, publisher addresses, and printing histories", () => {
    const secondLayer = `William G. Bowen and Derek Bok James L. Shulman, Thomas I. Nygren, Stacy Berg Dale, and Lauren A. Meserve
Princeton, New Jersey 08540 Chichester, West Sussex Second printing, and first paperback printing,
The river metaphor belongs to Mark Twain, who understood that a pilot's knowledge of the water is renewed on every trip; this book asks what colleges learned on theirs, and answers with the largest body of evidence yet assembled.`;
    const mined = mineAnnotation(secondLayer, { title: "The Shape of the River", authors: ["William G. Bowen"], pageCount: 285 });
    expect(mined).toBeDefined();
    expect(mined!.startsWith("The river metaphor")).toBe(true);
    expect(mined!).not.toContain("Princeton, New Jersey");
    expect(mined!).not.toContain("paperback printing");
  });

  it("kills CIP lines that carry no other marker — the exact live escapes", () => {
    const isolated = `Sowell, Thomas, 1930– Includes bibliographical references and index. 1. Affirmative action programs—Cross-cultural studies. 2. Discrimination in employment—Cross-cultural studies.
Includes bibliographical references and index. 1. Universities and colleges— United States—Admission— Case studies.
Preferences and quotas have a history in many countries, and this book judges them by that history rather than by the hopes officially expressed for them at the outset.`;
    const mined = mineAnnotation(isolated, { title: "Affirmative Action Around the World", authors: ["Thomas Sowell"], pageCount: 252 });
    expect(mined).toBeDefined();
    expect(mined!.startsWith("Preferences and quotas")).toBe(true);
    expect(mined!).not.toContain("bibliographical");
    expect(mined!).not.toContain("Cross-cultural studies");
  });

  it("skips CIP catalog blocks and colophons (live book shapes, 2026-07-14)", () => {
    const cip = `Designed by James J. Johnson and set in Baskerville type by Keystone Typesetting, Inc. Sowell, Thomas, 1930– Affirmative action around the world : an empirical study / Thomas Sowell. Includes bibliographical references and index.
Derek Bok ; in collaboration with James L. Shulman . . . [et al.]. Includes bibliographical references and index. 1. Universities and colleges— United States—Admission— Case studies.
The argument of this book is that preferential policies must be judged by their measured results, and the evidence assembled here spans five countries and several decades of it.`;
    const mined = mineAnnotation(cip, { title: "Affirmative Action Around the World", authors: ["Thomas Sowell"], pageCount: 252 });
    expect(mined).toBeDefined();
    expect(mined!.startsWith("The argument of this book")).toBe(true);
    expect(mined!).not.toContain("Baskerville");
    expect(mined!).not.toContain("et al");
  });

  it("starts at a sentence boundary when the fragment opens mid-sentence", () => {
    const midSentence = `of Martin Luther King, the journalist promises to focus on the man and not the icon. King does, of course, go into great detail on the triumphs of the civil-rights movement and the costs they exacted.`;
    const mined = mineAnnotation(midSentence, REILLY);
    expect(mined).toBeDefined();
    expect(mined!.startsWith("King does, of course")).toBe(true);
  });

  it("ships nothing when the cleaned text is under the 80-character gate", () => {
    expect(mineAnnotation("Subscribe\n7/14/2023\nShort line here today.", REILLY)).toBeUndefined();
    expect(mineAnnotation("", REILLY)).toBeUndefined();
  });

  it("caps long prose at a word boundary with an ellipsis", () => {
    const long = `${"A serious sentence about the argument of the work, extended. ".repeat(10)}`;
    const mined = mineAnnotation(long, { title: "T", authors: [], pageCount: 9 });
    expect(mined!.length).toBeLessThanOrEqual(210);
    expect(mined!.endsWith("…")).toBe(true);
  });
});

describe("page-aware mining", () => {
  const BOOK = { title: "Affirmative Action Around the World", authors: ["Thomas Sowell"], pageCount: 252 };

  it("skips a book's opening pages structurally", () => {
    const chunks = [
      { page: 1, text: "AFFIRMATIVE ACTION AROUND THE WORLD" },
      { page: 3, text: "A catalogue record for this book is available from the British Library. The paper in this book meets the guidelines for permanence." },
      { page: 4, text: "I. Title. HF5549.5.A34S685 2003 378.1 '61 '0973—dc21 This book has been composed in Baskerville." },
      { page: 9, text: "Preferences and quotas have a history in many countries, and this book judges them by that history rather than by the hopes officially expressed at the outset." },
    ];
    const mined = mineFromChunks(chunks.map((chunk) => ({ page: chunk.page, text: chunk.text })), { ...BOOK });
    expect(mined).toBeDefined();
    expect(mined!.startsWith("Preferences and quotas")).toBe(true);
  });

  it("retries from page one when the skip leaves nothing", () => {
    const chunks = [
      { page: 2, text: "All the prose this document owns lives on its second page, and it is enough for the miner's gate to accept it as a real annotation line." },
      { page: 31, text: "INDEX" },
    ];
    const mined = mineFromChunks(chunks, { title: "Odd Shape", authors: [], pageCount: 31 });
    expect(mined).toBeDefined();
    expect(mined!.startsWith("All the prose")).toBe(true);
  });

  it("a clipped tail retreats to the last complete sentence when one is long enough", () => {
    const mined = mineAnnotation(
      "The foreword weighs what selective institutions are for, and does so against the evidence.\nWhat a Harvard or a Princeton seeks to achieve is, in some measure, what America strives",
      { title: "Foreword", authors: [], pageCount: 12 },
    );
    expect(mined).toBe("The foreword weighs what selective institutions are for, and does so against the evidence.");
  });

  it("a clipped tail wears an honest ellipsis when retreat would gut the line", () => {
    const mined = mineAnnotation(
      "The foreword weighs its subject fairly.\nWhat a Harvard or a Princeton seeks to achieve is, in some measure, what America strives",
      { title: "Foreword", authors: [], pageCount: 12 },
    );
    expect(mined).toBeDefined();
    expect(mined!.endsWith("…")).toBe(true);
    expect(mined!).toContain("America strives");
  });

  it("short documents keep their lede", () => {
    const chunks = [
      { page: 1, text: "A five-page review opens with its argument on page one, and that opening argument is exactly what belongs in the annotation line for it." },
    ];
    const mined = mineFromChunks(chunks, { title: "A Short Review", authors: [], pageCount: 5 });
    expect(mined).toBeDefined();
    expect(mined!.startsWith("A five-page review")).toBe(true);
  });
});

describe("the composed floor", () => {
  it("restates only what is known, genre-typed", () => {
    expect(composeAnnotation(REILLY)).toBe("Article-length source (2023) on A Great Man, Warts and All. 5 pages.");
    expect(composeAnnotation({ title: "A Review of the Sowell Record", authors: [], year: 2023, pageCount: 5 }))
      .toBe("Review essay (2023) on A Review of the Sowell Record. 5 pages.");
    expect(composeAnnotation({ title: "Affirmative Action Around the World: An Empirical Study", authors: ["Thomas Sowell"], year: 2004, pageCount: 252 }))
      .toBe("Book-length source (2004) on Affirmative Action Around the World. 252 pages.");
    expect(composeAnnotation({ title: "Basic Economics", authors: [] })).toBe("Source on Basic Economics.");
  });
});

describe("draft sampling and prompt", () => {
  it("samples past a book's front matter and labels pages", () => {
    const sample = sampleChunksForDraft([
      { page: 2, text: "Copyright page noise that the model should never see." },
      { page: 12, text: "The book's real argument begins here in earnest." },
    ], 12_000);
    // maxPage 12 → skip through 3 → only the page-12 chunk survives.
    expect(sample).toContain("[p. 12]");
    expect(sample).not.toContain("Copyright page noise");
  });

  it("caps the sample budget", () => {
    const chunks = Array.from({ length: 50 }, (_, index) => ({ page: index + 10, text: "x".repeat(1_000) }));
    const sample = sampleChunksForDraft(chunks, 5_000);
    expect(sample.length).toBeLessThan(8_000);
  });

  it("builds a register-disciplined prompt around the identity", () => {
    const prompt = buildAnnotationDraftPrompt({ title: "Basic Economics", authors: ["Thomas Sowell"], year: 2004 }, "[p. 9] Text.");
    expect(prompt.instructions).toContain("two sentences");
    expect(prompt.instructions).toContain("no praise");
    expect(prompt.input).toContain("Thomas Sowell. Basic Economics. 2004");
    expect(prompt.input).toContain("[p. 9]");
  });
});

describe("the tier chain", () => {
  it("supplied wins outright", () => {
    const result = deriveAnnotation({ supplied: "  The owner's own words.  ", markdown: REILLY_MARKDOWN, identity: REILLY });
    expect(result).toEqual({ text: "The owner's own words.", source: "supplied" });
  });

  it("an existing supplied annotation survives reprocessing", () => {
    const result = deriveAnnotation({
      existing: { text: "Reviewed words from last time.", source: "supplied" },
      markdown: REILLY_MARKDOWN,
      identity: REILLY,
    });
    expect(result).toEqual({ text: "Reviewed words from last time.", source: "supplied" });
  });

  it("an existing mined annotation re-derives rather than fossilizing", () => {
    const result = deriveAnnotation({
      existing: { text: "Stale mined text.", source: "mined" },
      markdown: REILLY_MARKDOWN,
      identity: REILLY,
    });
    expect(result.source).toBe("mined");
    expect(result.text.startsWith("Thomas Sowell has been")).toBe(true);
  });

  it("falls to the composed floor when there is nothing to mine", () => {
    const result = deriveAnnotation({ markdown: "Subscribe\nDonate", identity: REILLY });
    expect(result.source).toBe("composed");
    expect(result.text).toContain("Article-length source (2023)");
  });
});
