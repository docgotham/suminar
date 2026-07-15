import http from "node:http";
import net from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { AnswerGenerator } from "../src/suminar/localAgent.js";
import { createSuminarConversationService } from "../src/suminar/service.js";
import { FederationClient, validateRemoteUrl } from "../src/core/federation.js";
import { IngestionService } from "../src/suminar/ingestion.js";
import { createRemoteTestAgent } from "../src/remote-test-agent.js";
import { LocalStore } from "../src/core/storage.js";
import { cleanup, fixturesDir, generateFixtures, temporaryConfig } from "./helpers.js";

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

const localAnswer = "Scholar and Researcher (2024) argue that structured disagreement reveals assumptions (Scholar and Researcher, 2024, p. 1).";
const generator: AnswerGenerator = { async generate() { return localAnswer; } };
const config = temporaryConfig({ allowPrivateOrigins: true });
const store = new LocalStore(config.dataDir);
const service = createSuminarConversationService(config, store, { answerGenerator: generator });
const ingestion = new IngestionService(config, store);
let server: http.Server;
let origin: string;
let fixture: ReturnType<typeof createRemoteTestAgent>;

describe("federated source agents in a host conversation", () => {
  beforeAll(async () => {
    generateFixtures();
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    fixture = createRemoteTestAgent(origin);
    fixture.app.get("/loop", (_request, response) => response.redirect("/loop"));
    fixture.app.get("/large", (_request, response) => response.json({ padding: "x".repeat(140_000) }));
    server = fixture.app.listen(port, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup(config);
  });

  it("lets a local and remote source agent share one host conversation without exposing source artifacts", async () => {
    await ingestion.ingest(path.join(fixturesDir, "clean.pdf"), { handle: "scholar-2024", year: 2024 });
    const preview = await service.previewRemoteAgent(`${origin}/.well-known/agent-sum.json`);
    expect(preview.firstContactWarning).toMatch(/not scholarly accuracy/i);
    await service.addRemoteAgent(preview.manifestUrl, preview.manifestDigest);
    const sync = await service.syncConversation({
      afterCursor: 0,
      events: [
        { speakerType: "user", authoredMessage: "Opening context", fidelity: "host_attested_exact", captureMethod: "trusted_local_adapter" },
        { speakerType: "host", authoredMessage: "Visible host thought", fidelity: "model_copied_unverified", captureMethod: "model_tool_argument" },
        { speakerType: "user", authoredMessage: "@scholar-2024 @federated-agents respond", fidelity: "host_attested_exact", captureMethod: "trusted_local_adapter" },
      ],
    });
    const result = await service.invokeAgents({
      conversationToken: sync.conversationToken,
      throughCursor: sync.cursor,
      targetHandles: ["scholar-2024", "federated-agents"],
      maxDirectQuoteWords: 25,
    });
    expect(result.messages.map((message) => message.handle)).toEqual(["scholar-2024", "federated-agents"]);
    expect(result.messages[1]?.agentId).toBe(fixture.card.agentId);
    expect(fixture.getLastInvocation()?.conversationUpdate.events.map((event) => event.speakerType)).toEqual(["user", "host", "user", "source_agent"]);
    expect(fixture.getLastInvocation()?.conversationUpdate.events.map((event) => event.authoredMessage)).toEqual([
      "Opening context", "Visible host thought", "@scholar-2024 @federated-agents respond", localAnswer,
    ]);
    expect(fixture.getLastInvocation()?.addressedMessage).toMatchObject({
      speakerType: "user",
      text: "@scholar-2024 @federated-agents respond",
      fidelity: "host_attested_exact",
    });
    expect(result.deliveries[0]).toMatchObject({ handle: "scholar-2024", fromSequence: 1, throughSequence: 3, deliveredEventCount: 3 });
    expect(result.deliveries[1]).toMatchObject({ handle: "federated-agents", fromSequence: 1, throughSequence: 4, deliveredEventCount: 4 });
    expect(fixture.getLastInvocation()?.responseConstraints.maxDirectQuoteWords).toBe(25);
    expect(JSON.stringify(fixture.getLastInvocation())).not.toMatch(/privateArtifacts|originalPdf|markdown|chunks|embeddings/);
  });

  it("blocks private origins normally and enforces redirect and response-size limits", async () => {
    await expect(validateRemoteUrl(`${origin}/.well-known/agent-sum.json`, false)).rejects.toThrow(/HTTPS|blocked/);
    const client = new FederationClient(true);
    await expect(client.previewAgentCard(`${origin}/loop`)).rejects.toThrow(/redirect policy/);
    await expect(client.previewAgentCard(`${origin}/large`)).rejects.toThrow(/size limit/);
  });

  it("requires re-preview when the manifest digest does not match", async () => {
    await service.removeRemoteAgent("federated-agents");
    await expect(service.addRemoteAgent(`${origin}/.well-known/agent-sum.json`, "0".repeat(64))).rejects.toThrow(/changed after preview/);
  });
});
