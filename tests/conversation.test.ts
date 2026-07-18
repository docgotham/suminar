import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isBareAssentRatification } from "../src/core/conversationService.js";
import { createSuminarConversationService } from "../src/suminar/service.js";
import { occurrenceEvidencePacket } from "../src/suminar/localAgent.js";
import type { AnswerGenerator } from "../src/suminar/localAgent.js";
import { IngestionService } from "../src/suminar/ingestion.js";
import { LocalStore } from "../src/core/storage.js";
import type { InvocationEnvelope, RetrievedPassage } from "../src/core/types.js";
import type { WholeSourceOccurrenceSearch } from "../src/suminar/retrieval.js";
import { cleanup, fixturesDir, generateFixtures, temporaryConfig } from "./helpers.js";

const config = temporaryConfig();
const store = new LocalStore(config.dataDir);
const seen: InvocationEnvelope[] = [];
const answer = "Scholar and Researcher (2024) argue that structured disagreement reveals assumptions (Scholar and Researcher, 2024, p. 1).";
const generator: AnswerGenerator = {
  async generate(_manifest, envelope) {
    seen.push(envelope);
    return answer;
  },
};
const service = createSuminarConversationService(config, store, { answerGenerator: generator });
const ingestion = new IngestionService(config, store);

function copied(speakerType: "user" | "host", authoredMessage: string) {
  return { speakerType, authoredMessage, fidelity: "model_copied_unverified" as const, captureMethod: "model_tool_argument" as const };
}

describe("roomless host-conversation event stream", () => {
  beforeAll(async () => {
    generateFixtures();
    await ingestion.ingest(path.join(fixturesDir, "clean.pdf"), { handle: "scholar-2024", year: 2024 });
    await ingestion.ingest(path.join(fixturesDir, "revised.pdf"), { handle: "revised-scholar", year: 2025 });
  });
  afterAll(() => cleanup(config));

  it("assigns positions at the head: replays absorb, stale cursors deliver missed turns, ahead-of-record fails fast", async () => {
    const first = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "Opening question"), copied("host", "Opening response")],
    });
    expect(first.cursor).toBe(2);
    // A retried batch in the unacknowledged region is a replay, not a duplicate.
    const replay = await service.syncConversation({
      conversationToken: first.conversationToken,
      afterCursor: 0,
      events: [copied("user", "Opening question"), copied("host", "Opening response")],
    });
    expect(replay).toMatchObject({ cursor: 2, acceptedEvents: 0, replayedEvents: 2 });
    // Claiming to have seen more than the record holds is host confusion.
    await expect(service.syncConversation({
      conversationToken: first.conversationToken,
      afterCursor: 3,
      events: [copied("user", "Skipped")],
    })).rejects.toThrow(/runs ahead of the record/);
    // B2-solo: new speech from a stale cursor is a new utterance appended at
    // the head — never a rewrite conflict — and the turns the host missed
    // come back as catch-up delivery.
    const stale = await service.syncConversation({
      conversationToken: first.conversationToken,
      afterCursor: 0,
      events: [copied("user", "A later thought from a parked thread")],
    });
    expect(stale).toMatchObject({ cursor: 3, acceptedEvents: 1, replayedEvents: 0 });
    expect(stale.missedTurns?.map((turn) => turn.sequence)).toEqual([1, 2]);
    expect(stale.missedTurns?.[0]?.displayText).toContain("Opening question");
  });

  it("delivers other threads' turns, absorbs interleaved retries, and lets hostMessageId defeat content coincidence", async () => {
    // Thread A starts the seminar.
    const a1 = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "From thread A"), copied("host", "Thread A response")],
    });
    // Thread B, freshly resumed and blind — appends at head, receives A's turns.
    const b1 = await service.syncConversation({
      conversationToken: a1.conversationToken,
      afterCursor: 0,
      events: [copied("user", "From thread B")],
    });
    expect(b1.cursor).toBe(3);
    expect(b1.missedTurns?.map((turn) => turn.sequence)).toEqual([1, 2]);
    // Thread B retries after a lost response while nothing else advanced:
    // pure replay, no growth.
    const b1retry = await service.syncConversation({
      conversationToken: a1.conversationToken,
      afterCursor: 0,
      events: [copied("user", "From thread B")],
    });
    expect(b1retry).toMatchObject({ cursor: 3, acceptedEvents: 0, replayedEvents: 1 });
    // Thread A returns from its parked state: its new turn lands at the
    // head and B's turn is delivered back to it.
    const a2 = await service.syncConversation({
      conversationToken: a1.conversationToken,
      afterCursor: 2,
      events: [copied("host", "Thread A follow-up")],
    });
    expect(a2).toMatchObject({ cursor: 4, acceptedEvents: 1 });
    expect(a2.missedTurns?.map((turn) => turn.sequence)).toEqual([3]);
    // Identical content is NOT a replay when hostMessageIds differ.
    const firstYes = await service.syncConversation({
      conversationToken: a1.conversationToken,
      afterCursor: 4,
      events: [{ ...copied("user", "yes"), hostMessageId: "msg-1" }],
    });
    expect(firstYes).toMatchObject({ cursor: 5, acceptedEvents: 1, replayedEvents: 0 });
    const secondYes = await service.syncConversation({
      conversationToken: a1.conversationToken,
      afterCursor: 4,
      events: [{ ...copied("user", "yes"), hostMessageId: "msg-2" }],
    });
    expect(secondYes).toMatchObject({ cursor: 6, acceptedEvents: 1, replayedEvents: 0 });
  });

  it("never swallows a genuinely new turn that repeats earlier wording (review finding: the lost ratification)", async () => {
    // Record: question, answer, an old "yes", then a host proposal.
    const seeded = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@a Q1"), copied("host", "noted"), copied("user", "yes"), copied("host", "@a a proposal?")],
    });
    expect(seeded.cursor).toBe(4);
    // A parked thread (acked through 1) submits the user's NEW ratifying
    // "yes". Under the old anywhere-in-region rule this matched the stale
    // seq-3 "yes" and was silently lost; tail-only matching appends it.
    const ratify = await service.syncConversation({
      conversationToken: seeded.conversationToken,
      afterCursor: 1,
      events: [copied("user", "yes")],
    });
    expect(ratify).toMatchObject({ cursor: 5, acceptedEvents: 1, replayedEvents: 0 });
    // And the identical stale "yes" is not echoed back for re-display.
    expect(ratify.missedTurns?.map((turn) => turn.sequence)).toEqual([2, 4]);
  });

  it("does not absorb an identically worded turn authored under a different display name (cross-host)", async () => {
    const seeded = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "start"), { ...copied("host", "Let us continue."), speakerDisplayName: "ChatGPT" }],
    });
    const claude = await service.syncConversation({
      conversationToken: seeded.conversationToken,
      afterCursor: 1,
      events: [{ ...copied("host", "Let us continue."), speakerDisplayName: "Claude" }],
    });
    expect(claude).toMatchObject({ cursor: 3, acceptedEvents: 1, replayedEvents: 0 });
  });

  it("a retry that raced a foreign append duplicates visibly rather than self-echoing (accepted trade-off)", async () => {
    const seeded = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "context"), copied("user", "Q")],
    });
    expect(seeded.cursor).toBe(2);
    // A foreign thread appends before the first thread's retry arrives.
    await service.syncConversation({
      conversationToken: seeded.conversationToken,
      afterCursor: 2,
      events: [copied("user", "foreign turn")],
    });
    // The first thread never saw its ack for "Q" and retries it with growth.
    const retry = await service.syncConversation({
      conversationToken: seeded.conversationToken,
      afterCursor: 1,
      events: [copied("user", "Q"), copied("user", "R")],
    });
    // "Q" duplicates at the head (visible, recoverable — never silent loss),
    // and the missed delivery carries only the foreign turn: the thread's
    // own just-submitted wording is never echoed back at it.
    expect(retry).toMatchObject({ cursor: 5, acceptedEvents: 2, replayedEvents: 0 });
    expect(retry.missedTurns?.map((turn) => turn.sequence)).toEqual([3]);
    expect(retry.missedTurns?.[0]?.displayText).toContain("foreign turn");
  });

  it("replaces oversized missed turns with mechanical placeholders instead of truncated verbatim", async () => {
    const big = "D".repeat(3_000);
    const start = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", big), copied("host", "Noted.")],
    });
    const behind = await service.syncConversation({
      conversationToken: start.conversationToken,
      afterCursor: 0,
      events: [copied("user", "What did I miss?")],
    });
    const oversized = behind.missedTurns?.find((turn) => turn.sequence === 1);
    expect(oversized?.omittedForLength).toBe(true);
    expect(oversized?.displayText).toContain("too long for delivery");
    expect(oversized?.displayText).not.toContain("DDDD");
    const normal = behind.missedTurns?.find((turn) => turn.sequence === 2);
    expect(normal?.displayText).toContain("Noted.");
  });

  it("pages the canonical record verbatim through readRecord", async () => {
    const seeded = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "First"), copied("host", "Second"), copied("user", "Third")],
    });
    const pageOne = await service.readRecord({ conversationToken: seeded.conversationToken, maxTurns: 2 });
    expect(pageOne.totalEvents).toBe(3);
    expect(pageOne.turns.map((turn) => turn.text)).toEqual(["First", "Second"]);
    expect(pageOne.done).toBe(false);
    const pageTwo = await service.readRecord({
      conversationToken: seeded.conversationToken,
      afterCursor: pageOne.nextCursor,
      maxTurns: 2,
    });
    expect(pageTwo.turns.map((turn) => turn.text)).toEqual(["Third"]);
    expect(pageTwo.done).toBe(true);
  });

  it("gives a newly invoked agent full catch-up and an existing agent only unseen events", async () => {
    const sync1 = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "Context one"), copied("host", "Context two"), copied("user", "@scholar-2024 answer")],
    });
    const first = await service.invokeAgents({
      conversationToken: sync1.conversationToken,
      throughCursor: sync1.cursor,
      targetHandles: ["@scholar-2024"],
    });
    expect(first.deliveries[0]).toMatchObject({ fromSequence: 1, throughSequence: 3, deliveredEventCount: 3 });
    expect(seen.at(-1)?.conversationUpdate.events.map((event) => event.authoredMessage)).toEqual([
      "Context one", "Context two", "@scholar-2024 answer",
    ]);
    expect(store.readConversationEvents(sync1.conversationToken).at(-1)).toMatchObject({
      speakerType: "source_agent",
      authoredMessage: answer,
      fidelity: "canonical_source_agent",
    });
    expect(store.readAgentMessage(first.messages[0]!.messageId)?.body).toBe(first.messages[0]!.authoredMessage);

    const sync2 = await service.syncConversation({
      conversationToken: sync1.conversationToken,
      afterCursor: first.throughCursor,
      events: [copied("host", "A separate visible host contribution"), copied("user", "@scholar-2024 continue")],
    });
    const second = await service.invokeAgents({
      conversationToken: sync1.conversationToken,
      throughCursor: sync2.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(second.deliveries[0]).toMatchObject({
      fromSequence: first.throughCursor + 1,
      throughSequence: sync2.cursor,
      deliveredEventCount: 2,
    });
    expect(seen.at(-1)?.conversationUpdate.events.map((event) => event.authoredMessage)).toEqual([
      "A separate visible host contribution", "@scholar-2024 continue",
    ]);

    const sync3 = await service.syncConversation({
      conversationToken: sync1.conversationToken,
      afterCursor: second.throughCursor,
      events: [copied("user", "@revised-scholar catch up and answer")],
    });
    const fresh = await service.invokeAgents({
      conversationToken: sync1.conversationToken,
      throughCursor: sync3.cursor,
      targetHandles: ["revised-scholar"],
    });
    expect(fresh.deliveries[0]?.fromSequence).toBe(1);
    expect(fresh.deliveries[0]?.deliveredEventCount).toBe(sync3.cursor);
  });

  it("lets later agents in one human cycle see earlier canonical source-agent turns", async () => {
    const sync = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 @revised-scholar Compare the two sources")],
    });
    const result = await service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024", "revised-scholar"],
    });
    expect(result.messages).toHaveLength(2);
    expect(result.deliveries[1]?.deliveredEventCount).toBe(2);
    expect(seen.at(-1)?.conversationUpdate.events.at(-1)).toMatchObject({ speakerType: "source_agent", authoredMessage: answer });
  });

  it("returns already admitted canonical messages when a later agent fails", async () => {
    const mixed: AnswerGenerator = {
      async generate(manifest) {
        return manifest.card.handle === "scholar-2024"
          ? answer
          : "Scholar and Researcher (2025) claim that \"invented text\" (Scholar and Researcher, 2025, p. 1).";
      },
    };
    const partial = createSuminarConversationService(config, store, { answerGenerator: mixed });
    const sync = await partial.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 @revised-scholar Compare the two sources with exact wording")],
    });
    const result = await partial.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024", "revised-scholar"],
    });
    expect(result.messages.map((message) => message.handle)).toEqual(["scholar-2024"]);
    expect(result.failures[0]).toMatchObject({ handle: "revised-scholar" });
    expect(store.readConversationEvents(sync.conversationToken).at(-1)?.authoredMessage).toBe(answer);
  });

  it("delivers complete unseen history while bounding the model working context", async () => {
    const events = Array.from({ length: 15 }, (_, index) => copied(
      index === 14 || index % 2 === 0 ? "user" : "host",
      index === 14 ? "@scholar-2024 Answer visible event 15" : `Visible event ${index + 1}`,
    ));
    const sync = await service.syncConversation({ afterCursor: 0, events });
    const invoked = await service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(invoked.deliveries[0]).toMatchObject({ fromSequence: 1, throughSequence: 15, deliveredEventCount: 15 });
    expect(seen.at(-1)?.conversationUpdate.events).toHaveLength(15);
    expect(seen.at(-1)?.conversationContext).toHaveLength(12);
    expect(seen.at(-1)?.conversationContext[0]?.authoredMessage).toBe("Visible event 4");
  });

  it("isolates conversational memory and cursors across host-thread tokens", async () => {
    const first = await service.syncConversation({ afterCursor: 0, events: [copied("user", "@scholar-2024 Private to first thread")] });
    await service.invokeAgents({ conversationToken: first.conversationToken, throughCursor: first.cursor, targetHandles: ["scholar-2024"] });
    const second = await service.syncConversation({ afterCursor: 0, events: [copied("user", "@scholar-2024 Fresh second thread")] });
    const invoked = await service.invokeAgents({ conversationToken: second.conversationToken, throughCursor: second.cursor, targetHandles: ["scholar-2024"] });
    expect(second.conversationToken).not.toBe(first.conversationToken);
    expect(invoked.deliveries[0]).toMatchObject({ fromSequence: 1, throughSequence: 1, deliveredEventCount: 1 });
    expect(seen.at(-1)?.conversationUpdate.events.map((event) => event.authoredMessage)).toEqual(["@scholar-2024 Fresh second thread"]);
  });

  it("keeps direct user addresses and visible host-authored addresses distinct", async () => {
    const delegated = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "Use Suminar. Ask @scholar-2024 whether the source cites Dana Scholar.")],
    });
    await expect(service.invokeAgents({
      conversationToken: delegated.conversationToken,
      throughCursor: delegated.cursor,
      targetHandles: ["scholar-2024"],
    })).rejects.toMatchObject({ code: "direct_address_required" });
    const hostQuestion = "@scholar-2024 Does the source cite Dana Scholar?";
    const delegatedResult = await service.invokeAgents({
      conversationToken: delegated.conversationToken,
      throughCursor: delegated.cursor,
      targetHandles: ["scholar-2024"],
      addressMode: "visible_host",
      visibleHostMessage: hostQuestion,
      visibleHostDisplayName: "Claude",
    });
    expect(delegatedResult.messages).toHaveLength(1);
    expect(delegatedResult.visibleHostAddress).toMatchObject({
      speakerDisplayName: "Claude",
      authoredMessage: hostQuestion,
      displayText: hostQuestion,
    });
    expect(seen.at(-1)?.userMessage.text).toBe("Use Suminar. Ask @scholar-2024 whether the source cites Dana Scholar.");
    expect(seen.at(-1)?.addressedMessage).toMatchObject({
      speakerType: "host",
      text: hostQuestion,
      fidelity: "canonical_host_address",
    });
    expect(seen.at(-1)?.conversationUpdate.events.map((event) => event.speakerType)).toEqual(["user", "host"]);
    expect(store.readConversationEvents(delegated.conversationToken).map((event) => event.speakerType)).toEqual(["user", "host", "source_agent"]);

    const direct = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 Does the source cite Dana Scholar?")],
    });
    const directResult = await service.invokeAgents({
      conversationToken: direct.conversationToken,
      throughCursor: direct.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(directResult.visibleHostAddress).toBeUndefined();
    expect(seen.at(-1)?.addressedMessage).toMatchObject({ speakerType: "user", text: "@scholar-2024 Does the source cite Dana Scholar?" });
  });

  it("requires every selected handle to be in the leading address cluster", async () => {
    const sync = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 Compare this with @revised-scholar")],
    });
    await expect(service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024", "revised-scholar"],
    })).rejects.toMatchObject({ code: "direct_address_required" });
  });

  it("lets the representative run exhaustive occurrence searches through its private lane, regardless of question phrasing", async () => {
    let occurrence: WholeSourceOccurrenceSearch | undefined;
    let chosenTerms: string[] = [];
    const occurrenceGenerator: AnswerGenerator = {
      async generate(_manifest, _envelope, _passages, _correction, searchOccurrences) {
        occurrence = searchOccurrences(chosenTerms);
        return answer;
      },
    };
    const occurrenceService = createSuminarConversationService(config, store, { answerGenerator: occurrenceGenerator });

    chosenTerms = ["Dana Scholar", "Scholar"];
    const sync = await occurrenceService.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 Does the source cite or reference Dana Scholar anywhere — for instance in its opening pages?")],
    });
    const delivered = await occurrenceService.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(delivered.messages).toHaveLength(1);
    expect(occurrence?.searchedAllPassages).toBe(true);
    expect(occurrence?.results[0]).toMatchObject({ term: "Dana Scholar" });
    expect(occurrence?.results[0]?.totalOccurrences).toBeGreaterThan(0);

    chosenTerms = ["Glenn Loury", "Loury"];
    const absentSync = await occurrenceService.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 Does the source cite Glenn Loury?")],
    });
    await occurrenceService.invokeAgents({
      conversationToken: absentSync.conversationToken,
      throughCursor: absentSync.cursor,
      targetHandles: ["scholar-2024"],
    });
    const packet = occurrenceEvidencePacket(occurrence!);
    expect(packet.scope).toBe("complete_source");
    expect(packet.queries.map((query) => ({ text: query.text, totalMatches: query.totalMatches }))).toEqual([
      { text: "Glenn Loury", totalMatches: 0 },
      { text: "Loury", totalMatches: 0 },
    ]);
    expect(JSON.stringify(packet)).not.toMatch(/SOURCE PDF PAGE|searchable text|chunks|index/i);
  });

  it("lets the representative retrieve additional passages by content and cite them", async () => {
    let searched: RetrievedPassage[] = [];
    const searchingGenerator: AnswerGenerator = {
      async generate(_manifest, _envelope, _passages, _correction, _searchOccurrences, searchPassages) {
        searched = await searchPassages("structured disagreement assumptions");
        return `Scholar and Researcher (2024) argue that structured disagreement reveals assumptions (Scholar and Researcher, 2024, p. ${searched[0]!.page}).`;
      },
    };
    const searching = createSuminarConversationService(config, store, { answerGenerator: searchingGenerator });
    const sync = await searching.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 respond to the other agent's view of disagreement.")],
    });
    const result = await searching.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(result.messages).toHaveLength(1);
    expect(searched.length).toBeGreaterThan(0);
    expect(searched.every((passage) => passage.agentId === searched[0]!.agentId)).toBe(true);
  });

  it("mechanically bounds representative passage searches", async () => {
    const tooShort: AnswerGenerator = {
      async generate(_manifest, _envelope, _passages, _correction, _searchOccurrences, searchPassages) {
        await searchPassages("ab");
        return answer;
      },
    };
    const shortService = createSuminarConversationService(config, store, { answerGenerator: tooShort });
    const shortSync = await shortService.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 What does the source argue?")],
    });
    const shortResult = await shortService.invokeAgents({
      conversationToken: shortSync.conversationToken,
      throughCursor: shortSync.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(shortResult.messages).toHaveLength(0);
    expect(shortResult.failures[0]?.detail).toMatch(/content query of 3 to 400/);

    const greedy: AnswerGenerator = {
      async generate(_manifest, _envelope, _passages, _correction, _searchOccurrences, searchPassages) {
        for (let index = 0; index < 5; index += 1) await searchPassages(`structured disagreement ${index}`);
        return answer;
      },
    };
    const greedyService = createSuminarConversationService(config, store, { answerGenerator: greedy });
    const greedySync = await greedyService.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 What does the source argue?")],
    });
    const greedyResult = await greedyService.invokeAgents({
      conversationToken: greedySync.conversationToken,
      throughCursor: greedySync.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(greedyResult.messages).toHaveLength(0);
    expect(greedyResult.failures[0]?.detail).toMatch(/limited to four queries/);
  });

  it("admits a final draft by stripping only an unverifiable inline citation, and never when other defects remain", async () => {
    const misCiting: AnswerGenerator = {
      async generate() {
        return "Scholar and Researcher (2024) argue that structured disagreement reveals assumptions (Scholar and Researcher, 2024, p. 99).";
      },
    };
    const degraded = createSuminarConversationService(config, store, { answerGenerator: misCiting });
    const sync = await degraded.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 What does the source argue about disagreement?")],
    });
    const result = await degraded.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.authoredMessage).toBe("Scholar and Researcher (2024) argue that structured disagreement reveals assumptions.");
    expect(store.readConversationEvents(sync.conversationToken).at(-1)?.authoredMessage).not.toMatch(/p\. 99/);

    const doublyFlawed: AnswerGenerator = {
      async generate() {
        return "In my paper, structured disagreement reveals assumptions (Scholar and Researcher, 2024, p. 99).";
      },
    };
    const refused = createSuminarConversationService(config, store, { answerGenerator: doublyFlawed });
    const refusedSync = await refused.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 What does the source argue about disagreement?")],
    });
    const refusedResult = await refused.invokeAgents({
      conversationToken: refusedSync.conversationToken,
      throughCursor: refusedSync.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(refusedResult.messages).toHaveLength(0);
    expect(refusedResult.failures[0]?.detail).toMatch(/third person/);
  });

  it("mechanically rejects empty or degenerate occurrence terms", async () => {
    const degenerate: AnswerGenerator = {
      async generate(_manifest, _envelope, _passages, _correction, searchOccurrences) {
        searchOccurrences(["x", " "]);
        return answer;
      },
    };
    const guarded = createSuminarConversationService(config, store, { answerGenerator: degenerate });
    const sync = await guarded.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 Does the source cite X?")],
    });
    const result = await guarded.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(result.messages).toHaveLength(0);
    expect(result.failures[0]?.detail).toMatch(/one to four short literal terms/);
  });

  it("requires attested user events in strict conversations", async () => {
    await expect(service.syncConversation({
      afterCursor: 0,
      inputFidelityPolicy: "strict",
      events: [copied("user", "Unverified")],
    })).rejects.toThrow(/host-attested/);
    const strict = await service.syncConversation({
      afterCursor: 0,
      inputFidelityPolicy: "strict",
      events: [{ speakerType: "user", authoredMessage: "Exact", fidelity: "host_attested_exact", captureMethod: "host_raw_turn" }],
    });
    expect(strict.cursor).toBe(1);
  });

  it("rejects fabricated source quotations before canonical admission", async () => {
    const fabricated: AnswerGenerator = {
      async generate() {
        return "Scholar and Researcher (2024) argue that \"this wording was never in the source\" (Scholar and Researcher, 2024, p. 1).";
      },
    };
    const guarded = createSuminarConversationService(config, store, { answerGenerator: fabricated });
    const sync = await guarded.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 give me an exact quotation")],
    });
    const rejected = await guarded.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
      maxDirectQuoteWords: 30,
    });
    expect(rejected.messages).toHaveLength(0);
    expect(rejected.failures[0]?.detail).toMatch(/not present verbatim/);
    expect(store.readConversationEvents(sync.conversationToken)).toHaveLength(1);
  });

  it("delivers a host follow-up proposal after the user's bare affirmative ratification", async () => {
    const sync = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 What is the central claim?")],
    });
    const first = await service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
    });
    const proposal = "@scholar-2024 How does the source support that claim empirically?";
    const ratifySync = await service.syncConversation({
      conversationToken: sync.conversationToken,
      afterCursor: first.throughCursor,
      events: [copied("host", proposal), copied("user", "Yes, go ahead.")],
    });
    const ratified = await service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: ratifySync.cursor,
      targetHandles: ["scholar-2024"],
      addressMode: "ratified_host_address",
    });
    expect(ratified.messages).toHaveLength(1);
    expect(ratified.visibleHostAddress).toBeUndefined();
    expect(ratified.ratifiedHostAddress).toMatchObject({ authoredMessage: proposal });
    expect(ratified.deliveries[0]?.deliveredEventCount).toBe(2);
    expect(seen.at(-1)?.addressedMessage).toMatchObject({
      speakerType: "host",
      text: proposal,
      fidelity: "model_copied_unverified",
    });
    expect(seen.at(-1)?.userMessage.text).toBe("Yes, go ahead.");
  });

  it("refuses ratification without a bare affirmative or a pending immediately-preceding host proposal", async () => {
    const ratify = (conversationToken: string, throughCursor: number) => service.invokeAgents({
      conversationToken,
      throughCursor,
      targetHandles: ["scholar-2024"],
      addressMode: "ratified_host_address",
    });
    const substantive = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "@scholar-2024 Does the source discuss structured disagreement?"),
        copied("user", "Yes, and also ask about methodology."),
      ],
    });
    await expect(ratify(substantive.conversationToken, substantive.cursor)).rejects.toMatchObject({ code: "direct_address_required" });

    const negated = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "@scholar-2024 Does the source discuss structured disagreement?"),
        copied("user", "No, don't."),
      ],
    });
    await expect(ratify(negated.conversationToken, negated.cursor)).rejects.toMatchObject({ code: "direct_address_required" });

    const separated = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "@scholar-2024 Does the source discuss structured disagreement?"),
        copied("host", "Separate host commentary in between."),
        copied("user", "Yes, go ahead."),
      ],
    });
    await expect(ratify(separated.conversationToken, separated.cursor)).rejects.toMatchObject({ code: "direct_address_required" });

    const noProposal = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "I wonder whether the source discusses structured disagreement."),
        copied("user", "Yes, go ahead."),
      ],
    });
    await expect(ratify(noProposal.conversationToken, noProposal.cursor)).rejects.toMatchObject({ code: "direct_address_required" });
  });

  it("registers a host proposal server-side and delivers it on the user's next bare affirmative", async () => {
    const sync = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "Can you ask it for me?")],
    });
    const proposal = "@scholar-2024 Does the source cite or reference Dana Scholar anywhere?";
    const proposed = await service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
      addressMode: "proposed_host_address",
      visibleHostMessage: proposal,
      visibleHostDisplayName: "Claude",
    });
    expect(proposed.messages).toHaveLength(0);
    expect(proposed.proposedHostAddress).toMatchObject({ authoredMessage: proposal, speakerDisplayName: "Claude" });
    expect(store.readConversationEvents(sync.conversationToken).at(-1)).toMatchObject({
      speakerType: "host",
      authoredMessage: proposal,
      fidelity: "canonical_host_address",
    });
    const assent = await service.syncConversation({
      conversationToken: sync.conversationToken,
      afterCursor: proposed.throughCursor,
      events: [copied("user", "yep")],
    });
    const delivered = await service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: assent.cursor,
      targetHandles: ["scholar-2024"],
      addressMode: "ratified_host_address",
    });
    expect(delivered.messages).toHaveLength(1);
    expect(delivered.ratifiedHostAddress).toMatchObject({ authoredMessage: proposal });
    expect(seen.at(-1)?.addressedMessage).toMatchObject({
      speakerType: "host",
      text: proposal,
      fidelity: "canonical_host_address",
    });
    expect(seen.at(-1)?.userMessage.text).toBe("yep");
  });

  it("rejects proposal registration without an exact leading @handle message and expires displaced proposals", async () => {
    const sync = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "Can you ask it for me?")],
    });
    await expect(service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
      addressMode: "proposed_host_address",
      visibleHostMessage: "I will ask @scholar-2024 about the sources",
    })).rejects.toMatchObject({ code: "direct_address_required" });
    await expect(service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
      addressMode: "proposed_host_address",
    })).rejects.toMatchObject({ code: "direct_address_required" });

    const proposed = await service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
      addressMode: "proposed_host_address",
      visibleHostMessage: "@scholar-2024 Does the source discuss structured disagreement?",
    });
    const displaced = await service.syncConversation({
      conversationToken: sync.conversationToken,
      afterCursor: proposed.throughCursor,
      events: [copied("host", "Some separate host commentary."), copied("user", "yep")],
    });
    await expect(service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: displaced.cursor,
      targetHandles: ["scholar-2024"],
      addressMode: "ratified_host_address",
    })).rejects.toMatchObject({ code: "direct_address_required" });
  });

  it("whispers when consecutive user turns suggest a missing host contribution", async () => {
    const sync = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "Was the book earlier or later?"), copied("user", "Can you ask it for me?")],
    });
    expect(sync.hostConductNotices?.some((notice) => /consecutive user turns/i.test(notice))).toBe(true);
  });

  it("rejects a reworded visibleHostMessage in ratified mode", async () => {
    const sync = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "@scholar-2024 Does the source discuss structured disagreement?"),
        copied("user", "Yes, go ahead."),
      ],
    });
    await expect(service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
      addressMode: "ratified_host_address",
      visibleHostMessage: "@scholar-2024 A reworded question",
    })).rejects.toThrow(/already-visible proposal/);
  });

  it("returns private host-conduct notices for narration, service menus, and echoed canonical blocks", async () => {
    const narration = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "I'll relay your question to the Foreword agent. Let me set this up."),
        copied("user", "@scholar-2024 What is the central claim?"),
      ],
    });
    expect(narration.hostConductNotices?.some((notice) => /transport/i.test(notice))).toBe(true);

    const menu = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "The Foreword makes a prudential case. I can push it on a follow-up, or pose the same question to the other agents for contrast."),
        copied("user", "Okay."),
      ],
    });
    expect(menu.hostConductNotices?.some((notice) => /offers to manage/i.test(notice))).toBe(true);

    const echo = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "> **📄 Scholar** · local\n>\n> Echoed block"),
        copied("user", "Continue."),
      ],
    });
    expect(echo.hostConductNotices?.some((notice) => /canonical source-agent block/i.test(notice))).toBe(true);

    const pose = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "Let me pose your question to it."),
        copied("user", "@scholar-2024 Continue."),
      ],
    });
    expect(pose.hostConductNotices?.some((notice) => /transport/i.test(notice))).toBe(true);

    const putToSource = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "Let me put that to the source."),
        copied("user", "Okay."),
      ],
    });
    expect(putToSource.hostConductNotices?.some((notice) => /transport/i.test(notice))).toBe(true);

    const participantVoice = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "Let me put it this way: the claim is prudential, not moral."),
        copied("user", "Go on."),
      ],
    });
    expect(participantVoice.hostConductNotices).toBeUndefined();

    const negatedAbility = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "I can't verify that myself; only the representative can ask its own source."),
        copied("user", "Understood."),
      ],
    });
    expect(negatedAbility.hostConductNotices).toBeUndefined();

    const routeNarration = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "I'll route this through Suminar to the Loury Foreword source."),
        copied("user", "Okay, do."),
      ],
    });
    expect(routeNarration.hostConductNotices?.some((notice) => /transport/i.test(notice))).toBe(true);

    const coaching = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "If you want a definitive answer, ask @scholar-2024 whether the source cites Dana Scholar."),
        copied("user", "Fine."),
      ],
    });
    expect(coaching.hostConductNotices?.some((notice) => /coaches the user/i.test(notice))).toBe(true);

    const participantSuggestion = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "You could read the Foreword's argument as prudential rather than moral."),
        copied("user", "Go on."),
      ],
    });
    expect(participantSuggestion.hostConductNotices).toBeUndefined();

    const proposalWithCue = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "@scholar-2024 Does the source cite or reference Glenn Loury anywhere?\n\nWant me to ask them? Say the word and I'll send it."),
        copied("user", "go"),
      ],
    });
    expect(proposalWithCue.hostConductNotices).toBeUndefined();

    const menuWithoutProposal = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "Want me to ask the other agents for contrast?"),
        copied("user", "Hm."),
      ],
    });
    expect(menuWithoutProposal.hostConductNotices?.some((notice) => /without putting a question on the table/i.test(notice))).toBe(true);

    const clean = await service.syncConversation({
      afterCursor: 0,
      events: [
        copied("host", "The Foreword grounds its argument in institutional legitimacy."),
        copied("user", "Interesting."),
      ],
    });
    expect(clean.hostConductNotices).toBeUndefined();
  });

  it("retries a transient generation failure once and surfaces a failure only when both attempts fail", async () => {
    let flakyCalls = 0;
    const flaky: AnswerGenerator = {
      async generate() {
        flakyCalls += 1;
        if (flakyCalls === 1) throw new Error("transient upstream failure");
        return answer;
      },
    };
    const flakyService = createSuminarConversationService(config, store, { answerGenerator: flaky });
    const sync = await flakyService.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 answer despite one transient failure")],
    });
    const recovered = await flakyService.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(flakyCalls).toBe(2);
    expect(recovered.failures).toEqual([]);
    expect(recovered.messages[0]?.authoredMessage).toBe(answer);
    expect(store.readConversationEvents(sync.conversationToken).at(-1)).toMatchObject({
      speakerType: "source_agent",
      fidelity: "canonical_source_agent",
    });

    let brokenCalls = 0;
    const broken: AnswerGenerator = {
      async generate() {
        brokenCalls += 1;
        throw new Error("persistent failure");
      },
    };
    const brokenService = createSuminarConversationService(config, store, { answerGenerator: broken });
    const sync2 = await brokenService.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 this address keeps failing")],
    });
    const failed = await brokenService.invokeAgents({
      conversationToken: sync2.conversationToken,
      throughCursor: sync2.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(brokenCalls).toBe(2);
    expect(failed.messages).toEqual([]);
    expect(failed.failures[0]).toMatchObject({ handle: "scholar-2024" });
    expect(store.readConversationEvents(sync2.conversationToken).at(-1)?.speakerType).toBe("user");
  });

  it("does not retry once the slow-retry cutoff has passed", async () => {
    let calls = 0;
    const flaky: AnswerGenerator = {
      async generate() {
        calls += 1;
        if (calls === 1) throw new Error("slow transient failure");
        return answer;
      },
    };
    // Cutoff below any real elapsed time: the first failure must surface
    // instead of retrying, because a retry would outlive a host client budget.
    const service = createSuminarConversationService(config, store, { answerGenerator: flaky, slowRetryCutoffMs: -1 });
    const sync = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 no retry after the cutoff")],
    });
    const failed = await service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(calls).toBe(1);
    expect(failed.messages).toEqual([]);
    expect(failed.failures[0]).toMatchObject({ handle: "scholar-2024" });
  });

  it("treats a leading routing prefix as part of the address, not the content", async () => {
    const sync = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "Suminar: @scholar-2024 what does the source argue about disagreement?")],
    });
    const result = await service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(result.failures).toEqual([]);
    expect(result.messages[0]?.authoredMessage).toBe(answer);
  });

  it("resupplies recent canonical turns on synchronization for the host's display check", async () => {
    const sync = await service.syncConversation({
      afterCursor: 0,
      events: [copied("user", "@scholar-2024 say something recoverable")],
    });
    const invoked = await service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024"],
    });
    expect(invoked.messages[0]?.authoredMessage).toBe(answer);
    // The host's next sync — whatever cursor it survived with — carries the
    // canonical turn back under the conditional display contract.
    const followUp = await service.syncConversation({
      conversationToken: sync.conversationToken,
      afterCursor: invoked.throughCursor,
      events: [copied("user", "a later user turn")],
    });
    expect(followUp.recentCanonicalTurns?.length).toBe(1);
    expect(followUp.recentCanonicalTurns?.[0]).toMatchObject({
      sequence: invoked.throughCursor,
      speakerType: "source_agent",
      authoredMessage: answer,
    });
    expect(followUp.recentCanonicalTurns?.[0]?.displayText).toContain("> **📄");
    expect(followUp.recentCanonicalTurns?.[0]?.displayText).toContain(answer);
  });

});

describe("bare assent ratification wording", () => {
  it("accepts short affirmatives and rejects negations, additions, and @addresses", async () => {
    expect(isBareAssentRatification("Yes")).toBe(true);
    expect(isBareAssentRatification("Yes, go ahead.")).toBe(true);
    expect(isBareAssentRatification("Sure, ask it.")).toBe(true);
    expect(isBareAssentRatification("Yes, put it to the source agent.")).toBe(true);
    expect(isBareAssentRatification("Go for it")).toBe(true);
    expect(isBareAssentRatification("Sounds good, proceed.")).toBe(true);
    expect(isBareAssentRatification("No")).toBe(false);
    expect(isBareAssentRatification("Not now")).toBe(false);
    expect(isBareAssentRatification("Wait, hold on")).toBe(false);
    expect(isBareAssentRatification("Yes, but keep it shorter")).toBe(false);
    expect(isBareAssentRatification("Yes, and ask about methodology too")).toBe(false);
    expect(isBareAssentRatification("@scholar-2024 yes")).toBe(false);
    expect(isBareAssentRatification("What did it say?")).toBe(false);
  });
});
