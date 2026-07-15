export const PROTOCOL_VERSION = "agent-sum/0.1" as const;

export type TransportKind = "local" | "https" | "gateway";
export type InputFidelityPolicy = "best_effort" | "strict";
export type UserMessageFidelity = "host_attested_exact" | "model_copied_unverified";
export type UserMessageCaptureMethod = "host_raw_turn" | "trusted_local_adapter" | "model_tool_argument";
export type AddressedMessageFidelity = UserMessageFidelity | "canonical_host_address";
export type AddressedMessageCaptureMethod = UserMessageCaptureMethod | "host_authored_tool_message";
export type ConversationSpeakerType = "user" | "host" | "source_agent";
export type ConversationEventFidelity = AddressedMessageFidelity | "canonical_source_agent";

export interface UserMessagePacket {
  text: string;
  fidelity: UserMessageFidelity;
  captureMethod: UserMessageCaptureMethod;
  contentHash: string;
  hostMessageId?: string;
}

export interface AddressedMessagePacket {
  speakerType: "user" | "host";
  text: string;
  fidelity: AddressedMessageFidelity;
  captureMethod: AddressedMessageCaptureMethod;
  contentHash: string;
  hostMessageId?: string;
}

export interface SourceIdentity {
  title: string;
  authors: string[];
  edition?: string;
  doiOrIsbn?: string;
  year?: number;
  citation?: string;
  pageCount?: number;
  // Annotated-bibliography line with its provenance tier: supplied by the
  // owner, mined from the source's own opening text, or composed from
  // metadata. Never model-generated without review.
  annotation?: string;
  annotationSource?: "supplied" | "mined" | "composed";
}

export interface RepresentativeCharter {
  tone?: string;
  verbosity?: "brief" | "moderate" | "detailed";
  interpretiveLatitude?: "strict" | "moderate" | "expansive";
  notes?: string;
}

export interface AgentCard {
  protocolVersions: string[];
  agentId: string;
  agentVersion: string;
  displayName: string;
  handle: string;
  origin: string;
  operator: Record<string, unknown>;
  sourceIdentity: SourceIdentity;
  representativeCharter: RepresentativeCharter;
  capabilities: Array<"answer" | "quote" | "compare" | "respond_to_message" | "occurrence_search">;
  quotationPolicy: {
    maxQuoteChars: number;
    maxTotalQuoteChars: number;
    maxQuotes: number;
  };
  contextPolicy: {
    acceptsConversationContext: boolean;
    maxContextMessages: number;
  };
  memoryAndRetention: {
    storesInvocations: boolean;
    retentionSummary: string;
  };
  endpoint: string;
  publicKey: string;
}

export interface AgentRef {
  agentId: string;
  origin: string;
  transport: TransportKind;
  manifestUrl?: string;
  manifestDigestAtInvitation: string;
  localAgentId?: string;
  handle: string;
  aliases: string[];
  displayName: string;
  cardSnapshot: AgentCard;
}

export interface ConversationAgentState {
  agent: AgentRef;
  joinedAtSequence: number;
  lastDeliveredSequence: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConversationSession {
  schemaVersion: 1;
  conversationToken: string;
  inputFidelityPolicy: InputFidelityPolicy;
  lastSequence: number;
  agents: ConversationAgentState[];
  createdAt: string;
  updatedAt: string;
}

export interface CopiedVisibleConversationEvent {
  speakerType: "user" | "host";
  authoredMessage: string;
  speakerDisplayName?: string;
}

export interface ConversationEvent {
  schemaVersion: 1;
  conversationToken: string;
  sequence: number;
  eventId: string;
  createdAt: string;
  speakerType: ConversationSpeakerType;
  speakerDisplayName: string;
  speakerAgentId?: string;
  authoredMessage: string;
  contentHash: string;
  fidelity: ConversationEventFidelity;
  captureMethod?: AddressedMessageCaptureMethod;
  hostMessageId?: string;
  canonicalMessageId?: string;
  invocationId?: string;
  maxDirectQuoteWords?: number;
  responseEnvelope?: ResponseEnvelope;
}

export interface ConversationTranscriptMessage {
  sequence: number;
  messageId: string;
  speakerType: ConversationSpeakerType;
  speakerAgentId?: string;
  speakerDisplayName: string;
  authoredMessage: string;
  contentHash: string;
  fidelity: ConversationEventFidelity;
}

export interface ConversationUpdate {
  conversationToken: string;
  fromSequence: number;
  throughSequence: number;
  events: ConversationTranscriptMessage[];
}

export interface ResponseConstraints {
  maxAuthoredMessageChars: number;
  maxQuoteChars: number;
  maxTotalQuoteChars: number;
  maxQuotes: number;
  maxDirectQuoteWords?: number;
  locale: string;
}

export interface InvocationEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  invocationId: string;
  targetAgentId: string;
  userMessage: UserMessagePacket;
  addressedMessage?: AddressedMessagePacket;
  conversationUpdate: ConversationUpdate;
  conversationContext: ConversationTranscriptMessage[];
  responseConstraints: ResponseConstraints;
}

export interface Citation {
  title: string;
  authors: string[];
  page?: number;
  location?: string;
  quotedText?: string;
}

export interface ResponseEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  messageId: string;
  replyToInvocationId: string;
  agentId: string;
  agentVersion: string;
  agentCardDigest: string;
  authoredMessage: string;
  citations: Citation[];
  contentHash: string;
  signature: string;
}

export interface DisplayedAgentMessage extends ResponseEnvelope {
  displayText: string;
  displayName: string;
  handle: string;
  origin: string;
}

// A canonical turn resupplied for the host's display check. The server can
// never know whether a prior response actually reached the host (a client
// can time out after the answer was composed), so recent canonical turns
// travel with every synchronization under a conditional display contract:
// the host — the only party that can see the visible conversation — skips
// what is already shown and displays what is missing.
export interface RecoveredCanonicalTurn {
  sequence: number;
  speakerType: ConversationSpeakerType;
  speakerDisplayName: string;
  authoredMessage: string;
  displayText: string;
}

export interface ConversationSyncResult {
  conversationToken: string;
  previousCursor: number;
  cursor: number;
  acceptedEvents: number;
  replayedEvents: number;
  hostConductNotices?: string[];
  recentCanonicalTurns?: RecoveredCanonicalTurn[];
}

export interface ConversationInvocationResult {
  invocationId: string;
  conversationToken: string;
  throughCursor: number;
  selectedAgentIds: string[];
  userMessageFidelity: UserMessageFidelity;
  visibleHostAddress?: {
    sequence: number;
    speakerDisplayName: string;
    authoredMessage: string;
    contentHash: string;
    displayText: string;
  };
  ratifiedHostAddress?: {
    sequence: number;
    speakerDisplayName: string;
    authoredMessage: string;
  };
  proposedHostAddress?: {
    sequence: number;
    speakerDisplayName: string;
    authoredMessage: string;
    displayText: string;
  };
  deliveries: Array<{
    agentId: string;
    handle: string;
    fromSequence: number;
    throughSequence: number;
    deliveredEventCount: number;
  }>;
  failures: Array<{
    handle: string;
    detail: string;
  }>;
  messages: DisplayedAgentMessage[];
}

export interface StoredCanonicalMessage {
  recordId: string;
  createdAt: string;
  speakerAgentId?: string;
  body: string;
  bodyHash: string;
  messageId: string;
  invocationId?: string;
  maxDirectQuoteWords?: number;
  responseEnvelope: ResponseEnvelope;
}

export interface LocalAgentManifest {
  schemaVersion: 1;
  agentId: string;
  card: AgentCard;
  cardDigest: string;
  privateArtifacts: {
    originalPdf: string;
    markdown: string;
    chunks: string;
    embeddings?: string;
    extractionReport: string;
    privateKey: string;
  };
  extractionStatus: "clean" | "partial_needs_ocr_review" | "needs_ocr" | "failed";
  sourceHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChunkRecord {
  chunkId: string;
  agentId: string;
  chunkIndex: number;
  page: number;
  location: string;
  text: string;
  tokenEstimate: number;
}

export interface RetrievedPassage extends ChunkRecord {
  score: number;
  role: "match" | "context_before" | "context_after";
}

export interface AgentTransport {
  invoke(agent: AgentRef, card: AgentCard, envelope: InvocationEnvelope): Promise<ResponseEnvelope>;
}
