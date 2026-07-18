import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { agentRefSchema, conversationSessionSchema } from "./schemas.js";
import { digestJson, sha256 } from "./crypto.js";
import type { AgentRef, ConversationEvent, ConversationSession, LocalAgentManifest, StoredCanonicalMessage } from "./types.js";

// The framework's persistence contract. LocalStore is the open-kernel
// single-tenant implementation; a hosted multi-tenant store implements the
// same interface.
export type MaybePromise<T> = T | Promise<T>;

// All methods may be synchronous (LocalStore) or asynchronous (hosted stores).
export interface ConversationStore {
  listLocalAgentManifests(): MaybePromise<LocalAgentManifest[]>;
  getLocalAgentManifest(agentId: string): MaybePromise<LocalAgentManifest>;
  listRemoteAgentRefs(): MaybePromise<AgentRef[]>;
  saveRemoteAgentRef(agent: AgentRef): MaybePromise<void>;
  removeRemoteAgentRef(agentId: string): MaybePromise<void>;
  createConversation(inputFidelityPolicy?: ConversationSession["inputFidelityPolicy"]): MaybePromise<ConversationSession>;
  getConversation(conversationToken: string): MaybePromise<ConversationSession>;
  saveConversation(conversation: ConversationSession): MaybePromise<void>;
  appendConversationEvent(
    conversationToken: string,
    input: Omit<ConversationEvent, "schemaVersion" | "eventId" | "createdAt" | "contentHash" | "conversationToken">,
  ): MaybePromise<ConversationEvent>;
  // B2-solo: the server assigns positions. The store appends the batch at the
  // current head — atomically with respect to every other appender — and
  // returns the events with their assigned sequences. Callers never compute
  // sequence numbers; the store is the single writer of the head.
  appendConversationEventsAtHead(
    conversationToken: string,
    inputs: Array<Omit<ConversationEvent, "schemaVersion" | "eventId" | "createdAt" | "contentHash" | "conversationToken" | "sequence">>,
  ): MaybePromise<ConversationEvent[]>;
  readConversationEvents(conversationToken: string): MaybePromise<ConversationEvent[]>;
  readAgentMessage(messageId: string): MaybePromise<StoredCanonicalMessage | undefined>;
}

export class LocalStore implements ConversationStore {
  constructor(readonly dataDir: string) {}

  get agentsDir(): string { return path.join(this.dataDir, "agents"); }
  get conversationsDir(): string { return path.join(this.dataDir, "conversations"); }
  get conversationEventsDir(): string { return path.join(this.dataDir, "conversation-events"); }
  get remoteAgentsDir(): string { return path.join(this.dataDir, "remote-agents"); }
  get privateDir(): string { return path.join(this.dataDir, "private"); }

  ensureLayout(): void {
    for (const dir of [
      this.dataDir,
      this.agentsDir,
      this.conversationsDir,
      this.conversationEventsDir,
      this.remoteAgentsDir,
      this.privateDir,
    ]) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  private readJson<T>(file: string): T {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  }

  private writeJsonAtomic(file: string, value: unknown): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, file);
  }

  listLocalAgentManifests(): LocalAgentManifest[] {
    this.ensureLayout();
    return fs.readdirSync(this.agentsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => this.normalizeLocalManifest(this.readJson<LocalAgentManifest>(path.join(this.agentsDir, name))));
  }

  getLocalAgentManifest(agentId: string): LocalAgentManifest {
    const file = path.join(this.agentsDir, `${agentId}.json`);
    if (!fs.existsSync(file)) throw new Error(`Unknown local agent: ${agentId}`);
    return this.normalizeLocalManifest(this.readJson<LocalAgentManifest>(file));
  }

  saveLocalAgentManifest(manifest: LocalAgentManifest): void {
    this.writeJsonAtomic(path.join(this.agentsDir, `${manifest.agentId}.json`), manifest);
  }

  private normalizeLocalManifest(manifest: LocalAgentManifest): LocalAgentManifest {
    const contextPolicy = manifest.card.contextPolicy as LocalAgentManifest["card"]["contextPolicy"] & { acceptsRoomContext?: boolean };
    let changed = false;
    if (contextPolicy.acceptsConversationContext === undefined) {
      contextPolicy.acceptsConversationContext = contextPolicy.acceptsRoomContext ?? true;
      delete contextPolicy.acceptsRoomContext;
      changed = true;
    }
    if (manifest.card.memoryAndRetention.retentionSummary === "Messages are retained only in the local room's append-only ledger.") {
      manifest.card.memoryAndRetention.retentionSummary = "Messages are retained only in conversation-scoped local event streams and agent delivery cursors.";
      changed = true;
    }
    if (!manifest.card.capabilities.includes("occurrence_search")) {
      manifest.card.capabilities.push("occurrence_search");
      changed = true;
    }
    if (manifest.card.capabilities.includes("occurrence_search") && manifest.card.agentVersion === "1.0.0") {
      manifest.card.agentVersion = "1.1.0";
      changed = true;
    }
    if (changed) {
      manifest.cardDigest = digestJson(manifest.card);
      manifest.updatedAt = new Date().toISOString();
      this.saveLocalAgentManifest(manifest);
    }
    return manifest;
  }

  listRemoteAgentRefs(): AgentRef[] {
    this.ensureLayout();
    return fs.readdirSync(this.remoteAgentsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => agentRefSchema.parse(this.readJson<unknown>(path.join(this.remoteAgentsDir, name))) as AgentRef);
  }

  saveRemoteAgentRef(agent: AgentRef): void {
    agentRefSchema.parse(agent);
    this.writeJsonAtomic(path.join(this.remoteAgentsDir, `${agent.agentId}.json`), agent);
  }

  removeRemoteAgentRef(agentId: string): void {
    const file = path.join(this.remoteAgentsDir, `${agentId}.json`);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  listConversationSessions(): ConversationSession[] {
    this.ensureLayout();
    return fs.readdirSync(this.conversationsDir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => conversationSessionSchema.parse(this.readJson<unknown>(path.join(this.conversationsDir, name))) as ConversationSession);
  }

  createConversation(inputFidelityPolicy: ConversationSession["inputFidelityPolicy"] = "best_effort"): ConversationSession {
    const now = new Date().toISOString();
    const conversation: ConversationSession = {
      schemaVersion: 1,
      conversationToken: `conv_${randomUUID()}_${randomUUID().replaceAll("-", "")}`,
      inputFidelityPolicy,
      lastSequence: 0,
      agents: [],
      createdAt: now,
      updatedAt: now,
    };
    this.saveConversation(conversation);
    return conversation;
  }

  getConversation(conversationToken: string): ConversationSession {
    if (!/^conv_[a-f0-9_-]{60,}$/i.test(conversationToken)) throw new Error("Invalid conversation token");
    const file = path.join(this.conversationsDir, `${conversationToken}.json`);
    if (!fs.existsSync(file)) throw new Error("Unknown or expired Suminar conversation token");
    return conversationSessionSchema.parse(this.readJson<unknown>(file)) as ConversationSession;
  }

  saveConversation(conversation: ConversationSession): void {
    conversationSessionSchema.parse(conversation);
    const file = path.join(this.conversationsDir, `${conversation.conversationToken}.json`);
    // The head is monotonic: a session object is a snapshot, and appends may
    // have advanced the stored head since it was read (the MCP SDK serves
    // requests concurrently even in one process). Writing a stale cursor
    // back would make the next append reuse sequences — the same regression
    // the hosted store prevents by never writing last_sequence here.
    if (fs.existsSync(file)) {
      const current = conversationSessionSchema.parse(this.readJson<unknown>(file)) as ConversationSession;
      if (current.lastSequence > conversation.lastSequence) {
        conversation = { ...conversation, lastSequence: current.lastSequence };
      }
    }
    this.writeJsonAtomic(file, conversation);
  }

  appendConversationEvent(
    conversationToken: string,
    input: Omit<ConversationEvent, "schemaVersion" | "eventId" | "createdAt" | "contentHash" | "conversationToken">,
  ): ConversationEvent {
    this.ensureLayout();
    const event: ConversationEvent = {
      schemaVersion: 1,
      conversationToken,
      eventId: randomUUID(),
      createdAt: new Date().toISOString(),
      contentHash: sha256(input.authoredMessage),
      ...input,
    };
    fs.appendFileSync(path.join(this.conversationEventsDir, `${conversationToken}.jsonl`), `${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  // Single-process, so "atomic" is simply sequential: read the head, assign,
  // append, bump. The conversation file's lastSequence is updated here so the
  // store — not the caller — owns the head, matching the hosted RPC.
  appendConversationEventsAtHead(
    conversationToken: string,
    inputs: Array<Omit<ConversationEvent, "schemaVersion" | "eventId" | "createdAt" | "contentHash" | "conversationToken" | "sequence">>,
  ): ConversationEvent[] {
    if (!inputs.length) return [];
    const conversation = this.getConversation(conversationToken);
    let head = conversation.lastSequence;
    const appended = inputs.map((input) => this.appendConversationEvent(conversationToken, { ...input, sequence: ++head }));
    conversation.lastSequence = head;
    conversation.updatedAt = new Date().toISOString();
    this.saveConversation(conversation);
    return appended;
  }

  readConversationEvents(conversationToken: string): ConversationEvent[] {
    const file = path.join(this.conversationEventsDir, `${conversationToken}.jsonl`);
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as ConversationEvent);
  }

  refreshLocalAgentReferences(manifest: LocalAgentManifest): void {
    for (const conversation of this.listConversationSessions()) {
      const state = conversation.agents.find((candidate) => candidate.agent.agentId === manifest.agentId && candidate.agent.transport === "local");
      if (!state) continue;
      state.agent.handle = manifest.card.handle;
      state.agent.displayName = manifest.card.displayName;
      state.agent.cardSnapshot = manifest.card;
      state.agent.manifestDigestAtInvitation = manifest.cardDigest;
      state.updatedAt = manifest.updatedAt;
      conversation.updatedAt = manifest.updatedAt;
      this.saveConversation(conversation);
    }
  }

  readAgentMessage(messageId: string): StoredCanonicalMessage | undefined {
    this.ensureLayout();
    for (const name of fs.readdirSync(this.conversationEventsDir).filter((entry) => entry.endsWith(".jsonl"))) {
      const conversationToken = name.slice(0, -6);
      const found = this.readConversationEvents(conversationToken)
        .find((event) => event.canonicalMessageId === messageId && event.speakerType === "source_agent");
      if (found) {
        return {
          recordId: found.eventId,
          createdAt: found.createdAt,
          ...(found.speakerAgentId ? { speakerAgentId: found.speakerAgentId } : {}),
          body: found.authoredMessage,
          bodyHash: found.contentHash,
          messageId: found.canonicalMessageId!,
          invocationId: found.invocationId,
          maxDirectQuoteWords: found.maxDirectQuoteWords,
          responseEnvelope: found.responseEnvelope!,
        };
      }
    }
    // Read-only compatibility for canonical messages created by pre-0.6 builds.
    const legacyLedgers = path.join(this.dataDir, "ledgers");
    if (fs.existsSync(legacyLedgers)) for (const name of fs.readdirSync(legacyLedgers).filter((entry) => entry.endsWith(".jsonl"))) {
      const lines = fs.readFileSync(path.join(legacyLedgers, name), "utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const record = JSON.parse(line) as Record<string, unknown>;
        if (record.messageId === messageId && record.speakerType === "agent" && record.responseEnvelope) {
          return {
            recordId: String(record.recordId),
            createdAt: String(record.createdAt),
            ...(record.speakerAgentId ? { speakerAgentId: String(record.speakerAgentId) } : {}),
            body: String(record.body),
            bodyHash: String(record.bodyHash),
            messageId,
            ...(record.invocationId ? { invocationId: String(record.invocationId) } : {}),
            ...(typeof record.maxDirectQuoteWords === "number" ? { maxDirectQuoteWords: record.maxDirectQuoteWords } : {}),
            responseEnvelope: record.responseEnvelope as StoredCanonicalMessage["responseEnvelope"],
          };
        }
      }
    }
    return undefined;
  }
}
