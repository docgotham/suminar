#!/usr/bin/env node
import { loadConfig } from "./suminar/config.js";
import { createSuminarConversationService } from "./suminar/service.js";
import { IngestionService } from "./suminar/ingestion.js";
import { LocalStore } from "./core/storage.js";

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function print(value: unknown): void { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); }

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new LocalStore(config.dataDir);
  const conversations = createSuminarConversationService(config, store);
  const ingestion = new IngestionService(config, store);
  const command = process.argv[2];
  switch (command) {
    case "ingest": {
      const pdf = process.argv[3];
      if (!pdf) throw new Error("Usage: suminar ingest <pdf> [--title ... --authors ... --year ... --embed]");
      const manifest = await ingestion.ingest(pdf, {
        title: option("title"), authors: option("authors"), year: option("year") ? Number(option("year")) : undefined,
        citation: option("citation"), edition: option("edition"), doiOrIsbn: option("doi-or-isbn"),
        handle: option("handle"), displayName: option("display-name"), embed: process.argv.includes("--embed"),
      });
      print({ agentId: manifest.agentId, card: manifest.card, cardDigest: manifest.cardDigest, extractionStatus: manifest.extractionStatus });
      break;
    }
    case "ocr-mistral": print(await ingestion.retryMistralOcr(process.argv[3]!)); break;
    case "agent-list": print((await conversations.listAgents()).map((agent) => ({
      handle: agent.handle,
      displayName: agent.displayName,
      transport: agent.transport,
      origin: agent.transport === "local" ? "local" : agent.origin,
      sourceIdentity: agent.cardSnapshot.sourceIdentity,
    }))); break;
    case "agent-update": print(ingestion.updateMetadata(process.argv[3]!, {
      title: option("title"), authors: option("authors")?.split(";").map((author) => author.trim()),
      year: option("year") ? Number(option("year")) : undefined, citation: option("citation"), edition: option("edition"),
      doiOrIsbn: option("doi-or-isbn"), handle: option("handle"), displayName: option("display-name"),
    })); break;
    case "remote-preview": print(await conversations.previewRemoteAgent(process.argv[3]!)); break;
    case "remote-add": print(await conversations.addRemoteAgent(process.argv[3]!, option("digest")!)); break;
    case "remote-remove": await conversations.removeRemoteAgent(process.argv[3]!); print({ removed: process.argv[3] }); break;
    case "remote-check": print(await conversations.checkRemoteAgents()); break;
    case "conversation-start": {
      const text = process.argv[3];
      if (!text) throw new Error("Usage: suminar conversation-start <exact-user-message>");
      print(await conversations.syncConversation({
        afterCursor: 0,
        events: [{
          speakerType: "user",
          authoredMessage: text,
          fidelity: "host_attested_exact",
          captureMethod: "trusted_local_adapter",
        }],
      }));
      break;
    }
    case "conversation-sync": {
      const conversationToken = process.argv[3];
      const afterCursor = Number(process.argv[4]);
      const speakerType = process.argv[5] as "user" | "host";
      const text = process.argv[6];
      if (!conversationToken || !Number.isInteger(afterCursor) || !["user", "host"].includes(speakerType) || !text) {
        throw new Error("Usage: suminar conversation-sync <token> <after-cursor> <user|host> <exact-message>");
      }
      print(await conversations.syncConversation({
        conversationToken,
        afterCursor,
        events: [{
          speakerType,
          authoredMessage: text,
          fidelity: "host_attested_exact",
          captureMethod: "trusted_local_adapter",
        }],
      }));
      break;
    }
    case "invoke": {
      const conversationToken = process.argv[3];
      const throughCursor = Number(process.argv[4]);
      const targetHandles = (process.argv[5] ?? "").split(",").filter(Boolean);
      const mode = option("mode") as "current_user" | "visible_host" | "ratified_host_address" | undefined;
      if (!conversationToken || !Number.isInteger(throughCursor) || !targetHandles.length) {
        throw new Error("Usage: suminar invoke <token> <cursor> <@handle[,handle]> [--mode current_user|visible_host|ratified_host_address] [--host-message <exact @handle message>] [--host-name <name>] [--max-quote-words N]");
      }
      print(await conversations.invokeAgents({
        conversationToken,
        throughCursor,
        targetHandles,
        ...(mode ? { addressMode: mode } : {}),
        ...(option("host-message") !== undefined ? { visibleHostMessage: option("host-message") } : {}),
        ...(option("host-name") !== undefined ? { visibleHostDisplayName: option("host-name") } : {}),
        ...(option("max-quote-words") !== undefined ? { maxDirectQuoteWords: Number(option("max-quote-words")) } : {}),
      }));
      break;
    }
    case "ask": {
      const handle = process.argv[3];
      const text = process.argv[4];
      if (!handle || !text) throw new Error("Usage: suminar ask <@handle> <exact-user-message> [--max-quote-words N]");
      const sync = await conversations.syncConversation({
        afterCursor: 0,
        events: [{
          speakerType: "user",
          authoredMessage: text,
          fidelity: "host_attested_exact",
          captureMethod: "trusted_local_adapter",
        }],
      });
      print(await conversations.invokeAgents({
        conversationToken: sync.conversationToken,
        throughCursor: sync.cursor,
        targetHandles: [handle],
        ...(option("max-quote-words") !== undefined ? { maxDirectQuoteWords: Number(option("max-quote-words")) } : {}),
      }));
      break;
    }
    case "read-message": print(await store.readAgentMessage(process.argv[3]!)); break;
    case "doctor": print({
      ok: true,
      dataDir: config.dataDir,
      localAgents: store.listLocalAgentManifests().length,
      remoteAgents: store.listRemoteAgentRefs().length,
      conversations: store.listConversationSessions().length,
      openAiConfigured: Boolean(process.env.OPENAI_API_KEY),
      mistralConfigured: Boolean(process.env.MISTRAL_API_KEY),
      privateOriginsAllowed: config.allowPrivateOrigins,
    }); break;
    default:
      throw new Error("Commands: ingest, ocr-mistral, agent-list, agent-update, remote-preview, remote-add, remote-remove, remote-check, conversation-start, conversation-sync, invoke, ask, read-message, doctor");
  }
}

main().catch((error) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
