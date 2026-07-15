import express from "express";
import { randomUUID } from "node:crypto";
import { agentCardSchema, invocationEnvelopeSchema } from "./core/schemas.js";
import { digestJson, generateSigningKeyPair, sha256, signResponseEnvelope } from "./core/crypto.js";
import { PROTOCOL_VERSION } from "./core/types.js";
import type { AgentCard, InvocationEnvelope } from "./core/types.js";

export function createRemoteTestAgent(origin = "http://127.0.0.1:4321") {
  const keys = generateSigningKeyPair();
  const card: AgentCard = agentCardSchema.parse({
    protocolVersions: [PROTOCOL_VERSION],
    agentId: "agent_remote_federation_essay",
    agentVersion: "1.0.0",
    displayName: "Federated Source Agents Essay",
    handle: "federated-agents",
    origin,
    operator: { name: "Suminar federation fixture", website: origin },
    sourceIdentity: {
      title: "Situated Source Agents as Federated Conversational Origins",
      authors: ["Suminar Test Publisher"],
      edition: "1",
      year: 2026,
      citation: "Suminar Test Publisher. Situated Source Agents as Federated Conversational Origins. 2026.",
      pageCount: 1,
    },
    representativeCharter: {
      tone: "Direct and careful",
      verbosity: "brief",
      interpretiveLatitude: "strict",
      notes: "Represent the fixture essay in the third person and distinguish protocol facts from interpretation.",
    },
    capabilities: ["answer", "compare", "respond_to_message"],
    quotationPolicy: { maxQuoteChars: 300, maxTotalQuoteChars: 600, maxQuotes: 2 },
    contextPolicy: { acceptsConversationContext: true, maxContextMessages: 4 },
    memoryAndRetention: { storesInvocations: false, retentionSummary: "The fixture keeps only the latest invocation in process memory for conformance inspection." },
    endpoint: `${origin}/invoke`,
    publicKey: keys.publicKey,
  }) as AgentCard;
  let lastInvocation: InvocationEnvelope | undefined;
  const app = express();
  app.use(express.json({ limit: "128kb" }));
  app.get("/.well-known/agent-sum.json", (_request, response) => response.json(card));
  app.get("/debug/last-invocation", (_request, response) => response.json(lastInvocation ?? null));
  app.post("/invoke", (request, response) => {
    try {
      const invocation = invocationEnvelopeSchema.parse(request.body) as InvocationEnvelope;
      if (invocation.targetAgentId !== card.agentId) return response.status(404).json({ error: "Unknown target agent" });
      lastInvocation = invocation;
      const otherAgents = invocation.conversationUpdate.events.length
        ? ` It received ${invocation.conversationUpdate.events.length} previously unseen visible conversation event(s) and ${invocation.conversationContext.length} working-context message(s), which it treats as conversation rather than as documentary evidence.`
        : " It received no unseen conversation events.";
      const authoredMessage = `The fixture essay argues that a situated source agent should remain at its publisher's origin while participating in a host conversation through a bounded invocation contract.${otherAgents} This response is representative interpretation from the fixture source, not a platform certification of its accuracy.`;
      const unsigned = {
        protocolVersion: PROTOCOL_VERSION,
        messageId: randomUUID(),
        replyToInvocationId: invocation.invocationId,
        agentId: card.agentId,
        agentVersion: card.agentVersion,
        agentCardDigest: digestJson(card),
        authoredMessage,
        citations: [{ title: card.sourceIdentity.title, authors: card.sourceIdentity.authors, page: 1, location: "page 1" }],
        contentHash: sha256(authoredMessage),
      };
      response.json(signResponseEnvelope(unsigned, keys.privateKey));
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });
  return { app, card, getLastInvocation: () => lastInvocation };
}

if (process.argv[1]?.endsWith("remote-test-agent.ts") || process.argv[1]?.endsWith("remote-test-agent.js")) {
  const origin = process.env.SUMINAR_REMOTE_TEST_ORIGIN || "http://127.0.0.1:4321";
  const port = Number(new URL(origin).port || 4321);
  createRemoteTestAgent(origin).app.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Remote Suminar fixture: ${origin}/.well-known/agent-sum.json\n`);
  });
}
