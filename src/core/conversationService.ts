import { randomUUID } from "node:crypto";
import { digestJson, sha256 } from "./crypto.js";
import {
  FederationClient,
  GatewayAgentTransport,
  HttpsAgentTransport,
  materialAgentCardDigest,
  validateResponseEnvelope,
} from "./federation.js";
import type { ConversationStore } from "./storage.js";
import { PROTOCOL_VERSION } from "./types.js";
import type {
  AgentCard,
  AgentRef,
  AgentTransport,
  AddressedMessagePacket,
  ConversationEvent,
  ConversationInvocationResult,
  ConversationSession,
  ConversationSyncResult,
  ConversationTranscriptMessage,
  RecoveredCanonicalTurn,
  CopiedVisibleConversationEvent,
  DisplayedAgentMessage,
  InputFidelityPolicy,
  InvocationEnvelope,
  LocalAgentManifest,
  ResponseEnvelope,
  UserMessageCaptureMethod,
  UserMessageFidelity,
  UserMessagePacket,
} from "./types.js";

// How the framework invokes a locally hosted source agent. The product layer
// supplies the implementation (retrieval, prompting, validation).
export interface LocalAgentInvoker {
  invoke(manifest: LocalAgentManifest, envelope: InvocationEnvelope): Promise<ResponseEnvelope>;
}

export interface ConversationServiceOptions {
  localInvoker: LocalAgentInvoker;
  allowPrivateOrigins?: boolean;
  // A second generation attempt is only worth making while the whole call can
  // still land inside a typical host MCP client's patience (~45-60s observed).
  // After this many milliseconds, a failure surfaces instead of retrying.
  slowRetryCutoffMs?: number;
}

export interface SyncableConversationEvent extends CopiedVisibleConversationEvent {
  fidelity: UserMessageFidelity;
  captureMethod: UserMessageCaptureMethod;
  hostMessageId?: string;
}

export interface SyncConversationInput {
  conversationToken?: string;
  afterCursor: number;
  events: SyncableConversationEvent[];
  inputFidelityPolicy?: InputFidelityPolicy;
}

export interface InvokeConversationInput {
  conversationToken: string;
  throughCursor: number;
  targetHandles: string[];
  addressMode?: "current_user" | "visible_host" | "proposed_host_address" | "ratified_host_address";
  visibleHostMessage?: string;
  visibleHostDisplayName?: string;
  maxDirectQuoteWords?: number;
}

export class DirectAddressRequiredError extends Error {
  readonly code = "direct_address_required";
  readonly requiredDisclosure: string;

  constructor(readonly targetHandles: string[]) {
    const addressed = targetHandles.map((handle) => `@${handle.replace(/^@/, "")}`).join(targetHandles.length > 1 ? " and " : "");
    const requiredDisclosure = `A source-agent question must be a visible authored turn. Either begin the current user message with ${addressed} and a substantive question; or—when the user has asked the host to pose the question—have the host contribute and display a separate message beginning with ${addressed}; or—when the conversation's immediately preceding event is a host proposal beginning with ${addressed} and the current user message is a bare affirmative—deliver that already-visible proposal as a ratified host address. To put a follow-up on the table without delivering it, register the exact ${addressed} message as a proposed host address and display it; a bare user affirmative on the next turn then delivers it. Suminar does not permit invisible backchannel questions.`;
    super(requiredDisclosure);
    this.name = "DirectAddressRequiredError";
    this.requiredDisclosure = requiredDisclosure;
  }
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function directlyAddressed(userText: string, agents: AgentRef[]): boolean {
  for (const agent of agents) {
    const names = [agent.handle, ...agent.aliases];
    const found = names.some((name) => new RegExp(`(?<![A-Za-z0-9._-])@${escapeRegularExpression(name)}(?=$|[^A-Za-z0-9._-])`, "i").test(userText));
    if (!found) return false;
  }
  const withoutMentions = userText.replace(/(?<![A-Za-z0-9._-])@[a-z0-9][a-z0-9._-]*/gi, " ");
  const routingOnlyWords = new Set([
    "a", "again", "agent", "agents", "agentsum", "ahead", "ask", "connector", "directly", "do", "for", "forward", "suminar",
    "go", "her", "him", "host", "it", "me", "message", "no", "now", "please", "pose", "put", "question", "relay",
    "send", "source", "sum", "tell", "that", "the", "them", "this", "to", "use", "yes",
  ]);
  const substantiveWords = withoutMentions
    .normalize("NFKC")
    .toLocaleLowerCase()
    .match(/[\p{L}\p{N}]+/gu)
    ?.filter((word) => !routingOnlyWords.has(word)) ?? [];
  return substantiveWords.length > 0;
}

// A leading routing prefix addresses the tool, not the content: users
// naturally type "Suminar: @loury-foreword ..." and mean a direct address.
const routingPrefixPattern = /^@?(?:suminar|agent\s*·?\s*sum|agentsum)\s*[:,\-–—]\s*/i;

function leadingDirectAddress(userText: string, agents: AgentRef[]): boolean {
  let remaining = userText.trimStart().replace(routingPrefixPattern, "");
  const leadingHandles = new Set<string>();
  while (true) {
    const match = remaining.match(/^@([a-z0-9][a-z0-9._-]*)(?=$|[^A-Za-z0-9._-])/i);
    if (!match) break;
    leadingHandles.add(match[1]!.toLocaleLowerCase());
    remaining = remaining.slice(match[0].length).trimStart();
  }
  const everyTargetLeads = agents.every((agent) => [agent.handle, ...agent.aliases]
    .some((name) => leadingHandles.has(name.toLocaleLowerCase())));
  return everyTargetLeads && directlyAddressed(userText, agents);
}

const bareAssentWords = new Set([
  "absolutely", "affirmative", "again", "agent", "agents", "agentsum", "agreed", "ahead", "all", "alright", "ask", "suminar",
  "away", "by", "certainly", "confirm", "confirmed", "course", "definitely", "do", "fine", "for", "forward", "go",
  "good", "great", "her", "him", "it", "means", "message", "now", "of", "ok", "okay", "perfect", "please", "pose",
  "proceed", "put", "question", "relay", "send", "sounds", "source", "sum", "sure", "tell", "that", "the", "them",
  "to", "use", "yeah", "yep", "yes",
]);

export function isBareAssentRatification(userText: string): boolean {
  if (userText.length > 200 || /(?<![A-Za-z0-9._-])@[a-z0-9]/i.test(userText)) return false;
  const words = userText.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.length > 0 && words.every((word) => bareAssentWords.has(word));
}

const canonicalBlockEchoPattern = /(?:^|\n)\s*>\s*\*\*📄/u;
// Flag operator-voiced transport narration while leaving participant speech
// (let me put it this way) alone: ambiguous verbs need a nearby transport noun.
const transportNarrationPattern = new RegExp([
  String.raw`\brelay(?:ed|ing|s)?\b`,
  String.raw`\b(?:let me|i(?:'|’)ll|i will) (?:set|use|query|invoke)\b`,
  String.raw`\b(?:let me|i(?:'|’)ll|i will) (?:call|pose|put|send|forward|deliver)\b(?=[^.!?\n]{0,80}\b(?:agents?|sources?|question|@))`,
  // Shape rule: first-person intent aimed at Suminar or an agent/source in
  // the same sentence, whatever the verb — no more verb enumeration.
  String.raw`\b(?:i(?:'|’)ll|i will|let me|i(?:'|’)m going to|i am going to)\b[^.!?\n]{0,100}\b(?:suminar|agent\s*·?\s*sum|agentsum|the (?:[a-z'’-]+ ){0,3}(?:agents?|sources?))\b`,
  String.raw`\b(?:came|come)s? back\b`,
  String.raw`\bquerying\b`,
  String.raw`\binvoking\b`,
  String.raw`\bresponse (?:returned|received)\b`,
  String.raw`\bhere(?:'|’)s what (?:the|it)`,
].join("|"), "i");
// Coaching is the third form of the same instinct as menus and proposals:
// telling the user how to address an agent instead of proposing the address.
const coachingPattern = /\b(?:you (?:can|could|might|should|may)|if you (?:want|like|prefer|need|wish))\b[^.!?\n]{0,120}(?:@[a-z0-9]|\bagents?\b|\bhandle\b)/i;
// The offer stem must not match negated ability (I can't confirm that).
const offerStem = String.raw`(?:i can(?!not\b|(?:'|’)t\b)|i could(?!n(?:'|’)t\b)|would you like(?: me)?(?: to)?|want me to|shall i|happy to|let me know if)`;
const serviceMenuPattern = new RegExp(String.raw`\b${offerStem}\b[^.!?\n]{0,120}\b(?:ask|pose|push|probe|query|put|relay|invoke|follow(?:s|ing)?[- ]?up|contrast|compare)\b`, "i");

const visibleHandleProposalPattern = /(?:^|\n)\s*@[a-z0-9][a-z0-9._-]*/i;

export function hostConductNotices(hostMessages: string[]): string[] {
  const notices = new Set<string>();
  for (const message of hostMessages) {
    if (canonicalBlockEchoPattern.test(message)) {
      notices.add("The synchronized host turn appears to contain a canonical source-agent block. Suminar records those itself; synchronize only your separately authored words.");
    }
    // The menu/proposal boundary: a message carrying a concrete visible @handle
    // question is a ratifiable proposal — the sanctioned form — and its short
    // ratification cue is part of it. An offer or transport narration without a
    // proposal on the table is operator voice.
    if (visibleHandleProposalPattern.test(message)) continue;
    if (transportNarrationPattern.test(message)) {
      notices.add("The synchronized host turn narrates transport work (relaying, querying, results coming back). Perform transport silently and speak only as a participant in the shared conversation.");
    }
    if (serviceMenuPattern.test(message)) {
      notices.add("The synchronized host turn offers to manage further source-agent queries without putting a question on the table. Either say nothing, or author the @handle question itself as your own visible message the user can ratify.");
    }
    if (coachingPattern.test(message)) {
      notices.add("The synchronized host turn coaches the user on how to address a source agent. Author and register the @handle question yourself (proposed_host_address) so a bare affirmative can deliver it.");
    }
  }
  return [...notices];
}

export function createUserMessagePacket(
  text: string,
  fidelity: UserMessageFidelity,
  captureMethod: UserMessageCaptureMethod,
  hostMessageId?: string,
): UserMessagePacket {
  if (!text) throw new Error("User-message text must not be empty");
  return {
    text,
    fidelity,
    captureMethod,
    contentHash: sha256(text),
    ...(hostMessageId ? { hostMessageId } : {}),
  };
}

async function localAgentRef(store: ConversationStore, agentId: string): Promise<AgentRef> {
  const manifest = await store.getLocalAgentManifest(agentId);
  return {
    agentId,
    origin: manifest.card.origin,
    transport: "local",
    manifestDigestAtInvitation: manifest.cardDigest,
    localAgentId: agentId,
    handle: manifest.card.handle,
    aliases: [],
    displayName: manifest.card.displayName,
    cardSnapshot: manifest.card,
  };
}

function displayText(agent: AgentRef, authoredMessage: string): string {
  const body = authoredMessage.split(/\r?\n/).map((line) => line ? `> ${line}` : ">").join("\n");
  const origin = agent.transport === "local" ? "local" : new URL(agent.origin).host;
  return `> **\ud83d\udcc4 ${agent.displayName}** \u00b7 ${origin}\n>\n${body}`;
}

function eventMessageId(event: ConversationEvent): string {
  return event.canonicalMessageId ?? event.hostMessageId ?? event.eventId;
}

function transcriptEvent(event: ConversationEvent): ConversationTranscriptMessage {
  return {
    sequence: event.sequence,
    messageId: eventMessageId(event),
    speakerType: event.speakerType,
    ...(event.speakerAgentId ? { speakerAgentId: event.speakerAgentId } : {}),
    speakerDisplayName: event.speakerDisplayName,
    authoredMessage: event.authoredMessage,
    contentHash: event.contentHash,
    fidelity: event.fidelity,
  };
}

function sameCopiedEvent(stored: ConversationEvent, input: SyncableConversationEvent): boolean {
  return stored.speakerType === input.speakerType
    && stored.authoredMessage === input.authoredMessage
    && stored.speakerDisplayName === (input.speakerDisplayName?.trim() || (input.speakerType === "user" ? "User" : "Host"));
}

export class ConversationService {
  private readonly federation: FederationClient;
  private readonly localInvoker: LocalAgentInvoker;
  private readonly transports: Record<"https" | "gateway", AgentTransport>;
  private readonly invocationsInFlight = new Set<string>();
  private readonly slowRetryCutoffMs: number;

  constructor(readonly store: ConversationStore, options: ConversationServiceOptions) {
    this.federation = new FederationClient(options.allowPrivateOrigins ?? false);
    this.localInvoker = options.localInvoker;
    this.slowRetryCutoffMs = options.slowRetryCutoffMs ?? 45_000;
    this.transports = {
      https: new HttpsAgentTransport(this.federation),
      gateway: new GatewayAgentTransport(),
    };
  }

  async listAgents(): Promise<AgentRef[]> {
    const manifests = await this.store.listLocalAgentManifests();
    const refs = [
      ...(await Promise.all(manifests.map((manifest) => localAgentRef(this.store, manifest.agentId)))),
      ...(await this.store.listRemoteAgentRefs()),
    ];
    return refs.sort((a, b) => a.handle.localeCompare(b.handle));
  }

  async resolveAgent(handle: string): Promise<AgentRef> {
    const normalized = handle.replace(/^@/, "").toLowerCase();
    const matches = (await this.listAgents()).filter((candidate) =>
      [candidate.handle, ...candidate.aliases].some((value) => value.toLowerCase() === normalized));
    if (!matches.length) throw new Error(`Unknown Suminar source-agent handle: ${handle}`);
    if (matches.length > 1) throw new Error(`Source-agent handle is ambiguous: ${handle}`);
    return matches[0]!;
  }

  async previewRemoteAgent(manifestUrl: string) {
    return this.federation.previewAgentCard(manifestUrl);
  }

  async addRemoteAgent(manifestUrl: string, expectedManifestDigest: string): Promise<AgentRef> {
    const preview = await this.federation.previewAgentCard(manifestUrl);
    if (preview.manifestDigest !== expectedManifestDigest) {
      throw new Error("Agent card changed after preview; inspect it again before adding the source agent");
    }
    const conflicting = (await this.listAgents()).find((agent) =>
      agent.agentId === preview.card.agentId || agent.handle.toLowerCase() === preview.card.handle.toLowerCase());
    if (conflicting) throw new Error("A source agent with this identity or handle is already available");
    const ref: AgentRef = {
      agentId: preview.card.agentId,
      origin: preview.card.origin,
      transport: "https",
      manifestUrl: preview.manifestUrl,
      manifestDigestAtInvitation: preview.manifestDigest,
      handle: preview.card.handle,
      aliases: [],
      displayName: preview.card.displayName,
      cardSnapshot: preview.card,
    };
    await this.store.saveRemoteAgentRef(ref);
    return ref;
  }

  async removeRemoteAgent(handle: string): Promise<void> {
    const agent = await this.resolveAgent(handle);
    if (agent.transport === "local") throw new Error("Local source agents are removed through source management, not remote-origin removal");
    await this.store.removeRemoteAgentRef(agent.agentId);
  }

  async checkRemoteAgents(): Promise<Array<{ handle: string; status: "current" | "material_change" | "unavailable"; detail: string }>> {
    return Promise.all((await this.store.listRemoteAgentRefs()).map(async (agent) => {
      try {
        if (!agent.manifestUrl) throw new Error("Missing manifest URL");
        const preview = await this.federation.previewAgentCard(agent.manifestUrl);
        const changed = materialAgentCardDigest(preview.card) !== materialAgentCardDigest(agent.cardSnapshot);
        return {
          handle: agent.handle,
          status: changed ? "material_change" as const : "current" as const,
          detail: changed
            ? "Identity, source, permissions, retention, endpoint, or signing key changed; remove and add it again after review."
            : "Material origin facts are current.",
        };
      } catch (error) {
        return { handle: agent.handle, status: "unavailable" as const, detail: error instanceof Error ? error.message : String(error) };
      }
    }));
  }

  async syncConversation(input: SyncConversationInput): Promise<ConversationSyncResult> {
    if (!Number.isInteger(input.afterCursor) || input.afterCursor < 0) throw new Error("Conversation cursor must be a non-negative integer");
    if (input.events.length > 500) throw new Error("A single synchronization may contain at most 500 visible events");
    const conversation = input.conversationToken
      ? await this.store.getConversation(input.conversationToken)
      : await this.store.createConversation(input.inputFidelityPolicy ?? "best_effort");
    if (this.invocationsInFlight.has(conversation.conversationToken)) {
      throw new Error("A source-agent invocation is still in progress for this host conversation; synchronize after it completes");
    }
    if (!input.conversationToken && input.afterCursor !== 0) {
      throw new Error("A new Suminar conversation must begin at cursor 0");
    }
    if (input.afterCursor > conversation.lastSequence) {
      throw new Error(`Conversation synchronization has a gap: server cursor is ${conversation.lastSequence}, host supplied ${input.afterCursor}`);
    }
    if (conversation.inputFidelityPolicy === "strict"
        && input.events.some((event) => event.speakerType === "user" && event.fidelity !== "host_attested_exact")) {
      throw new Error("This conversation requires host-attested exact user messages");
    }
    const stored = await this.store.readConversationEvents(conversation.conversationToken);
    let acceptedEvents = 0;
    let replayedEvents = 0;
    const acceptedHostMessages: string[] = [];
    let consecutiveUserEvents = false;
    for (let index = 0; index < input.events.length; index += 1) {
      const eventInput = input.events[index]!;
      if (!eventInput.authoredMessage.trim()) throw new Error("Visible conversation events must not be empty");
      const sequence = input.afterCursor + index + 1;
      const existing = stored[sequence - 1];
      if (existing) {
        if (!sameCopiedEvent(existing, eventInput)) {
          throw new Error(`Conversation history conflict at sequence ${sequence}; previously synchronized visible speech cannot be rewritten`);
        }
        replayedEvents += 1;
        continue;
      }
      if (sequence !== conversation.lastSequence + 1) {
        throw new Error(`Conversation synchronization has an unresolved gap before sequence ${sequence}`);
      }
      const appended = await this.store.appendConversationEvent(conversation.conversationToken, {
        sequence,
        speakerType: eventInput.speakerType,
        speakerDisplayName: eventInput.speakerDisplayName?.trim() || (eventInput.speakerType === "user" ? "User" : "Host"),
        authoredMessage: eventInput.authoredMessage,
        fidelity: eventInput.fidelity,
        captureMethod: eventInput.captureMethod,
        ...(eventInput.hostMessageId ? { hostMessageId: eventInput.hostMessageId } : {}),
      });
      if (appended.speakerType === "user" && stored.at(-1)?.speakerType === "user") consecutiveUserEvents = true;
      stored.push(appended);
      conversation.lastSequence = sequence;
      acceptedEvents += 1;
      if (appended.speakerType === "host") acceptedHostMessages.push(appended.authoredMessage);
    }
    conversation.updatedAt = new Date().toISOString();
    await this.store.saveConversation(conversation);
    const conductNotices = hostConductNotices(acceptedHostMessages);
    if (consecutiveUserEvents) {
      conductNotices.push("Two consecutive user turns were synchronized with no host contribution between them. If you spoke between them, synchronize that visible host message too—but never canonical source-agent blocks or tool-recorded host addresses.");
    }
    // Resupply the most recent canonical turns for the host's display check.
    // The server cannot know whether a prior response reached the host (a
    // client can time out after the answer was composed and stored), so the
    // host — the only party that can see the visible conversation — decides:
    // skip blocks already shown, display any that are missing.
    const recentCanonicalTurns = stored
      .filter((event) => event.fidelity === "canonical_source_agent" || event.fidelity === "canonical_host_address")
      .slice(-3)
      .map((event) => this.recoveredCanonicalTurn(conversation, event));
    return {
      conversationToken: conversation.conversationToken,
      previousCursor: input.afterCursor,
      cursor: conversation.lastSequence,
      acceptedEvents,
      replayedEvents,
      ...(conductNotices.length ? { hostConductNotices: conductNotices } : {}),
      ...(recentCanonicalTurns.length ? { recentCanonicalTurns } : {}),
    };
  }

  private recoveredCanonicalTurn(conversation: ConversationSession, event: ConversationEvent): RecoveredCanonicalTurn {
    const agent = event.speakerAgentId
      ? conversation.agents.find((state) => state.agent.agentId === event.speakerAgentId)?.agent
      : undefined;
    return {
      sequence: event.sequence,
      speakerType: event.speakerType,
      speakerDisplayName: event.speakerDisplayName,
      authoredMessage: event.authoredMessage,
      displayText: event.fidelity === "canonical_source_agent" && agent
        ? displayText(agent, event.authoredMessage)
        : event.authoredMessage,
    };
  }

  private currentRemoteCard(agent: AgentRef): Promise<AgentCard> {
    if (!agent.manifestUrl) return Promise.reject(new Error("Remote agent has no manifest URL"));
    return this.federation.previewAgentCard(agent.manifestUrl).then((preview) => {
      if (materialAgentCardDigest(preview.card) !== materialAgentCardDigest(agent.cardSnapshot)) {
        throw new Error(`Remote source agent ${agent.displayName} materially changed; remove and add it again after review`);
      }
      return preview.card;
    });
  }

  private workingContext(events: ConversationEvent[], card: AgentCard): ConversationTranscriptMessage[] {
    if (!card.contextPolicy.acceptsConversationContext) return [];
    const limit = Math.min(20, card.contextPolicy.maxContextMessages);
    return events.slice(-limit).map(transcriptEvent);
  }

  private latestUserPacket(events: ConversationEvent[]): UserMessagePacket {
    const event = events.findLast((candidate) => candidate.speakerType === "user");
    if (!event || !["host_attested_exact", "model_copied_unverified"].includes(event.fidelity)) {
      throw new Error("The synchronized conversation has no current user message");
    }
    const fidelity = event.fidelity as UserMessageFidelity;
    const captureMethod = event.captureMethod === "host_raw_turn" || event.captureMethod === "trusted_local_adapter"
      ? event.captureMethod
      : "model_tool_argument";
    return createUserMessagePacket(
      event.authoredMessage,
      fidelity,
      captureMethod,
      event.hostMessageId,
    );
  }

  async invokeAgents(input: InvokeConversationInput): Promise<ConversationInvocationResult> {
    if (!input.targetHandles.length || input.targetHandles.length > 3) throw new Error("Invoke one to three source agents per human-initiated cycle");
    if (new Set(input.targetHandles.map((handle) => handle.replace(/^@/, "").toLowerCase())).size !== input.targetHandles.length) {
      throw new Error("A source agent may receive at most one turn per human-initiated cycle");
    }
    if (input.maxDirectQuoteWords !== undefined
        && (!Number.isInteger(input.maxDirectQuoteWords) || input.maxDirectQuoteWords < 0 || input.maxDirectQuoteWords > 500)) {
      throw new Error("Host quotation ceiling must be an integer from 0 to 500 words");
    }
    const conversation = await this.store.getConversation(input.conversationToken);
    if (this.invocationsInFlight.has(conversation.conversationToken)) {
      throw new Error("A source-agent invocation is already in progress for this host conversation");
    }
    if (input.throughCursor !== conversation.lastSequence) {
      throw new Error(`Invoke against the latest acknowledged conversation cursor ${conversation.lastSequence}`);
    }
    const initialEvents = await this.store.readConversationEvents(conversation.conversationToken);
    if (initialEvents.at(-1)?.speakerType !== "user") {
      throw new Error("Synchronize the current complete user turn immediately before invoking a source agent");
    }
    let events = initialEvents;
    const userMessage = this.latestUserPacket(events);
    const agents = await Promise.all(input.targetHandles.map((handle) => this.resolveAgent(handle)));
    const addressMode = input.addressMode ?? "current_user";
    if (addressMode === "current_user" && !leadingDirectAddress(userMessage.text, agents)) {
      throw new DirectAddressRequiredError(agents.map((agent) => agent.handle));
    }
    if (addressMode === "visible_host") {
      if (!directlyAddressed(userMessage.text, agents)
          || !input.visibleHostMessage
          || !leadingDirectAddress(input.visibleHostMessage, agents)) {
        throw new DirectAddressRequiredError(agents.map((agent) => agent.handle));
      }
    }
    if (addressMode === "proposed_host_address") {
      if (!input.visibleHostMessage || !leadingDirectAddress(input.visibleHostMessage, agents)) {
        throw new DirectAddressRequiredError(agents.map((agent) => agent.handle));
      }
      this.invocationsInFlight.add(conversation.conversationToken);
      try {
        const speakerDisplayName = input.visibleHostDisplayName?.trim() || "Host";
        const sequence = conversation.lastSequence + 1;
        await this.store.appendConversationEvent(conversation.conversationToken, {
          sequence,
          speakerType: "host",
          speakerDisplayName,
          authoredMessage: input.visibleHostMessage,
          fidelity: "canonical_host_address",
          captureMethod: "host_authored_tool_message",
        });
        conversation.lastSequence = sequence;
        conversation.updatedAt = new Date().toISOString();
        await this.store.saveConversation(conversation);
        return {
          invocationId: randomUUID(),
          conversationToken: conversation.conversationToken,
          throughCursor: sequence,
          selectedAgentIds: agents.map((agent) => agent.agentId),
          userMessageFidelity: userMessage.fidelity,
          proposedHostAddress: {
            sequence,
            speakerDisplayName,
            authoredMessage: input.visibleHostMessage,
            displayText: input.visibleHostMessage,
          },
          deliveries: [],
          failures: [],
          messages: [],
        };
      } finally {
        this.invocationsInFlight.delete(conversation.conversationToken);
      }
    }
    const cycleId = randomUUID();
    const messages: DisplayedAgentMessage[] = [];
    const deliveries: ConversationInvocationResult["deliveries"] = [];
    const failures: ConversationInvocationResult["failures"] = [];
    let addressedMessage: AddressedMessagePacket = {
      speakerType: "user",
      text: userMessage.text,
      fidelity: userMessage.fidelity,
      captureMethod: userMessage.captureMethod,
      contentHash: userMessage.contentHash,
      ...(userMessage.hostMessageId ? { hostMessageId: userMessage.hostMessageId } : {}),
    };
    let visibleHostAddress: ConversationInvocationResult["visibleHostAddress"];
    let ratifiedHostAddress: ConversationInvocationResult["ratifiedHostAddress"];
    if (addressMode === "ratified_host_address") {
      if (input.visibleHostMessage !== undefined) {
        throw new Error("ratified_host_address delivers the host's already-visible proposal exactly as authored; do not supply visibleHostMessage");
      }
      const proposal = events.at(-2);
      if (!proposal
          || proposal.speakerType !== "host"
          || proposal.fidelity === "canonical_source_agent"
          || !leadingDirectAddress(proposal.authoredMessage, agents)
          || !isBareAssentRatification(userMessage.text)) {
        throw new DirectAddressRequiredError(agents.map((agent) => agent.handle));
      }
      addressedMessage = {
        speakerType: "host",
        text: proposal.authoredMessage,
        fidelity: proposal.fidelity,
        captureMethod: proposal.captureMethod ?? "model_tool_argument",
        contentHash: proposal.contentHash,
        ...(proposal.hostMessageId ? { hostMessageId: proposal.hostMessageId } : {}),
      };
      ratifiedHostAddress = {
        sequence: proposal.sequence,
        speakerDisplayName: proposal.speakerDisplayName,
        authoredMessage: proposal.authoredMessage,
      };
    }
    this.invocationsInFlight.add(conversation.conversationToken);
    try {
      if (addressMode === "visible_host") {
        const authoredMessage = input.visibleHostMessage!;
        const hostSequence = conversation.lastSequence + 1;
        const speakerDisplayName = input.visibleHostDisplayName?.trim() || "Host";
        const hostEvent = await this.store.appendConversationEvent(conversation.conversationToken, {
          sequence: hostSequence,
          speakerType: "host",
          speakerDisplayName,
          authoredMessage,
          fidelity: "canonical_host_address",
          captureMethod: "host_authored_tool_message",
        });
        conversation.lastSequence = hostSequence;
        conversation.updatedAt = new Date().toISOString();
        await this.store.saveConversation(conversation);
        visibleHostAddress = {
          sequence: hostSequence,
          speakerDisplayName,
          authoredMessage,
          contentHash: hostEvent.contentHash,
          displayText: authoredMessage,
        };
        addressedMessage = {
          speakerType: "host",
          text: authoredMessage,
          fidelity: "canonical_host_address",
          captureMethod: "host_authored_tool_message",
          contentHash: hostEvent.contentHash,
        };
        events = await this.store.readConversationEvents(conversation.conversationToken);
      }
      for (const agent of agents) {
        try {
      const now = new Date().toISOString();
      let state = conversation.agents.find((candidate) => candidate.agent.agentId === agent.agentId);
      if (!state) {
        state = {
          agent,
          joinedAtSequence: conversation.lastSequence,
          lastDeliveredSequence: 0,
          createdAt: now,
          updatedAt: now,
        };
        conversation.agents.push(state);
      } else if (agent.transport === "local") {
        state.agent = agent;
      }
      const updateEvents = events.filter((event) => event.sequence > state!.lastDeliveredSequence);
      const fromSequence = state.lastDeliveredSequence + 1;
      const throughSequence = conversation.lastSequence;
      let card = agent.cardSnapshot;
      if (agent.transport === "https") card = await this.currentRemoteCard(agent);
      const envelope: InvocationEnvelope = {
        protocolVersion: PROTOCOL_VERSION,
        invocationId: randomUUID(),
        targetAgentId: agent.agentId,
        userMessage,
        addressedMessage,
        conversationUpdate: {
          conversationToken: conversation.conversationToken,
          fromSequence,
          throughSequence,
          events: updateEvents.map(transcriptEvent),
        },
        conversationContext: this.workingContext(events, card),
        responseConstraints: {
          maxAuthoredMessageChars: 12_000,
          maxQuoteChars: Math.min(600, card.quotationPolicy.maxQuoteChars),
          maxTotalQuoteChars: Math.min(1200, card.quotationPolicy.maxTotalQuoteChars),
          maxQuotes: Math.min(3, card.quotationPolicy.maxQuotes),
          ...(input.maxDirectQuoteWords !== undefined ? { maxDirectQuoteWords: input.maxDirectQuoteWords } : {}),
          locale: "en-US",
        },
      };
      let response;
      // Generation and validation are stochastic: a draft can fail
      // quotation verification, or the upstream model call can fail
      // transiently. One clean re-attempt before the failure surfaces —
      // retry-then-refuse, never refuse-first (and never repair) — but only
      // while the whole call can still land inside a host client's patience;
      // after the cutoff a retry would outlive every observed client budget.
      const acquisitionStart = Date.now();
      for (let attempt = 1; ; attempt += 1) {
        try {
          if (agent.transport === "local") {
            const manifest = await this.store.getLocalAgentManifest(agent.localAgentId ?? agent.agentId);
            card = manifest.card;
            response = await this.localInvoker.invoke(manifest, envelope);
            validateResponseEnvelope(response, card, envelope);
          } else {
            response = await this.transports[agent.transport].invoke(agent, card, envelope);
          }
          if (response.agentCardDigest !== digestJson(card) || response.contentHash !== sha256(response.authoredMessage)) {
            throw new Error("Canonical response failed final integrity checks");
          }
          break;
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          console.error(`[suminar] invocation attempt ${attempt} failed for @${agent.handle} (invocation ${envelope.invocationId}): ${detail}`);
          if (attempt >= 2 || Date.now() - acquisitionStart > this.slowRetryCutoffMs) throw error;
        }
      }
      const responseSequence = conversation.lastSequence + 1;
      await this.store.appendConversationEvent(conversation.conversationToken, {
        sequence: responseSequence,
        speakerType: "source_agent",
        speakerDisplayName: agent.displayName,
        speakerAgentId: agent.agentId,
        authoredMessage: response.authoredMessage,
        fidelity: "canonical_source_agent",
        canonicalMessageId: response.messageId,
        invocationId: envelope.invocationId,
        ...(envelope.responseConstraints.maxDirectQuoteWords !== undefined
          ? { maxDirectQuoteWords: envelope.responseConstraints.maxDirectQuoteWords }
          : {}),
        responseEnvelope: response,
      });
      conversation.lastSequence = responseSequence;
      conversation.updatedAt = new Date().toISOString();
      state.lastDeliveredSequence = responseSequence;
      state.updatedAt = conversation.updatedAt;
      await this.store.saveConversation(conversation);
      deliveries.push({
        agentId: agent.agentId,
        handle: agent.handle,
        fromSequence,
        throughSequence,
        deliveredEventCount: updateEvents.length,
      });
      messages.push({
        ...response,
        displayText: displayText(agent, response.authoredMessage),
        displayName: agent.displayName,
        handle: agent.handle,
        origin: agent.origin,
      });
          events = await this.store.readConversationEvents(conversation.conversationToken);
        } catch (error) {
          failures.push({ handle: agent.handle, detail: error instanceof Error ? error.message : String(error) });
        }
      }
      return {
        invocationId: cycleId,
        conversationToken: conversation.conversationToken,
        throughCursor: conversation.lastSequence,
        selectedAgentIds: agents.map((agent) => agent.agentId),
        userMessageFidelity: userMessage.fidelity,
        ...(visibleHostAddress ? { visibleHostAddress } : {}),
        ...(ratifiedHostAddress ? { ratifiedHostAddress } : {}),
        deliveries,
        failures,
        messages,
      };
    } finally {
      this.invocationsInFlight.delete(conversation.conversationToken);
    }
  }
}
