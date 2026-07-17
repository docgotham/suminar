import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createSuminarMcpServer } from "../src/suminar/mcp.js";
import type { ResumeSeminarResult } from "../src/suminar/mcp.js";
import { createSuminarConversationService } from "../src/suminar/service.js";
import { IngestionService } from "../src/suminar/ingestion.js";
import { LocalStore } from "../src/core/storage.js";
import type { AnswerGenerator } from "../src/suminar/localAgent.js";
import { cleanup, fixturesDir, generateFixtures, temporaryConfig } from "./helpers.js";

// The output schemas are validated by the MCP SDK at call time: a handler
// whose structuredContent does not match its declared outputSchema fails the
// call. So round-tripping every schema-bearing tool through a real client and
// asserting a non-error result with structuredContent proves the declared
// schema accepts the actual payload — the one thing tsc cannot check, since
// structuredContent is typed as Record<string, unknown>.

const config = temporaryConfig();
const store = new LocalStore(config.dataDir);
const answer = "Scholar and Researcher (2024) argue structured disagreement reveals assumptions (Scholar and Researcher, 2024, p. 1).";
const generator: AnswerGenerator = { async generate() { return answer; } };
const fakeResume: ResumeSeminarResult = {
  conversationToken: `conv_${"a".repeat(60)}`,
  cursor: 5,
  title: "Test seminar",
  agentHandles: ["scholar-2024"],
  totalEvents: 5,
  recap: [{ speakerType: "user", speakerDisplayName: null, text: "an earlier turn" }],
};

const service = createSuminarConversationService(config, store, { answerGenerator: generator });
const ingestion = new IngestionService(config, store);
const server = createSuminarMcpServer(service, { resumeSeminar: async () => fakeResume });
const client = new Client({ name: "output-schema-test", version: "0.0.0" });

function copied(speakerType: "user" | "host", authoredMessage: string) {
  return { speakerType, authoredMessage, fidelity: "model_copied_unverified" as const, captureMethod: "model_tool_argument" as const };
}

describe("tool output schemas accept the real payloads", () => {
  beforeAll(async () => {
    generateFixtures();
    await ingestion.ingest(path.join(fixturesDir, "clean.pdf"), { handle: "scholar-2024", year: 2024 });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    await client.listTools(); // caches outputSchemas so the client validates too
  });
  afterAll(async () => { await client.close(); cleanup(config); });

  it("list_agents validates against publicAgentOutputSchema with a real agent", async () => {
    const res = await client.callTool({ name: "suminar_list_agents", arguments: {} });
    expect(res.isError).toBeFalsy();
    const agents = (res.structuredContent as { agents?: unknown[] }).agents ?? [];
    expect(agents.length).toBeGreaterThan(0);
    expect((agents[0] as { handle?: string }).handle).toBeTruthy();
  });

  it("inspect_agent validates a single real agent", async () => {
    const res = await client.callTool({ name: "suminar_inspect_agent", arguments: { agentHandle: "@scholar-2024" } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { agent?: { handle?: string } }).agent?.handle).toBe("scholar-2024");
  });

  it("read_message validates the canonical envelope of a real source-agent turn", async () => {
    const sync = await service.syncConversation({ afterCursor: 0, events: [copied("user", "@scholar-2024 answer")] });
    const invoked = await service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["@scholar-2024"],
    });
    const messageId = invoked.messages[0]!.messageId;
    const res = await client.callTool({ name: "suminar_read_message", arguments: { messageId } });
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as { authoredMessage?: string; responseEnvelope?: { messageId?: string } };
    expect(structured.authoredMessage).toBe(answer);
    expect(structured.responseEnvelope?.messageId).toBe(messageId);
  });

  it("resume_seminar validates its continuation state", async () => {
    const res = await client.callTool({ name: "suminar_resume_seminar", arguments: { resumeCode: `smn_res_${"a".repeat(24)}` } });
    expect(res.isError).toBeFalsy();
    const structured = res.structuredContent as { seminarTitle?: string; priorTurns?: number; participants?: string[] };
    expect(structured.seminarTitle).toBe("Test seminar");
    expect(structured.priorTurns).toBe(5);
    expect(structured.participants).toEqual(["scholar-2024"]);
  });
});
