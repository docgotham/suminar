import { z } from "zod";
import { PROTOCOL_VERSION } from "./types.js";

const metadataOriginSchema = z.enum(["document", "crossref", "web", "manual"]);

export const sourceIdentitySchema = z.object({
  title: z.string().min(1).max(500),
  authors: z.array(z.string().min(1).max(200)).max(100),
  edition: z.string().max(200).optional(),
  doiOrIsbn: z.string().max(200).optional(),
  year: z.number().int().min(1).max(3000).optional(),
  publicationDate: z.string().max(100).optional(),
  workType: z.enum(["standalone", "contained"]).optional(),
  citation: z.string().max(2000).optional(),
  pageCount: z.number().int().positive().optional(),
  annotation: z.string().max(500).optional(),
  annotationSource: z.enum(["supplied", "mined", "composed"]).optional(),
  metadataProvenance: z.object({
    title: metadataOriginSchema.optional(),
    authors: metadataOriginSchema.optional(),
    year: metadataOriginSchema.optional(),
    publicationDate: metadataOriginSchema.optional(),
    workType: metadataOriginSchema.optional(),
  }).optional(),
});

export const userMessagePacketSchema = z.object({
  text: z.string().min(1).max(50000),
  fidelity: z.enum(["host_attested_exact", "model_copied_unverified"]),
  captureMethod: z.enum(["host_raw_turn", "trusted_local_adapter", "model_tool_argument"]),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  hostMessageId: z.string().min(1).max(500).optional(),
});

export const addressedMessagePacketSchema = z.object({
  speakerType: z.enum(["user", "host"]),
  text: z.string().min(1).max(50000),
  fidelity: z.enum(["host_attested_exact", "model_copied_unverified", "canonical_host_address"]),
  captureMethod: z.enum(["host_raw_turn", "trusted_local_adapter", "model_tool_argument", "host_authored_tool_message"]),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  hostMessageId: z.string().min(1).max(500).optional(),
});

export const agentCardSchema = z.object({
  protocolVersions: z.array(z.string()).min(1).refine((versions) => versions.includes(PROTOCOL_VERSION), {
    message: `Agent must support ${PROTOCOL_VERSION}`,
  }),
  agentId: z.string().min(3).max(300),
  agentVersion: z.string().min(1).max(100),
  displayName: z.string().min(1).max(300),
  handle: z.string().regex(/^[a-z0-9][a-z0-9._-]{1,99}$/),
  origin: z.string().url(),
  operator: z.record(z.string(), z.unknown()),
  sourceIdentity: sourceIdentitySchema,
  representativeCharter: z.object({
    tone: z.string().max(300).optional(),
    verbosity: z.enum(["brief", "moderate", "detailed"]).optional(),
    interpretiveLatitude: z.enum(["strict", "moderate", "expansive"]).optional(),
    notes: z.string().max(3000).optional(),
  }),
  capabilities: z.array(z.enum(["answer", "quote", "compare", "respond_to_message", "occurrence_search"])).min(1),
  quotationPolicy: z.object({
    maxQuoteChars: z.number().int().min(1).max(5000),
    maxTotalQuoteChars: z.number().int().min(1).max(10000),
    maxQuotes: z.number().int().min(0).max(20),
  }),
  contextPolicy: z.object({
    acceptsConversationContext: z.boolean().optional(),
    acceptsRoomContext: z.boolean().optional(),
    maxContextMessages: z.number().int().min(0).max(100),
  }).refine((policy) => policy.acceptsConversationContext !== undefined || policy.acceptsRoomContext !== undefined, {
    message: "Agent context policy must declare whether conversation context is accepted",
  }).transform((policy) => ({
    acceptsConversationContext: policy.acceptsConversationContext ?? policy.acceptsRoomContext ?? false,
    maxContextMessages: policy.maxContextMessages,
  })),
  memoryAndRetention: z.object({
    storesInvocations: z.boolean(),
    retentionSummary: z.string().min(1).max(2000),
  }),
  endpoint: z.string().url(),
  publicKey: z.string().min(1).max(5000),
});

export const invocationEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  invocationId: z.string().uuid(),
  targetAgentId: z.string().min(1),
  userMessage: userMessagePacketSchema,
  addressedMessage: addressedMessagePacketSchema.optional(),
  conversationUpdate: z.object({
    conversationToken: z.string().min(20).max(200),
    fromSequence: z.number().int().min(1),
    throughSequence: z.number().int().min(0),
    events: z.array(z.object({
      sequence: z.number().int().min(1),
      messageId: z.string().min(1),
      speakerType: z.enum(["user", "host", "source_agent"]),
      speakerAgentId: z.string().min(1).optional(),
      speakerDisplayName: z.string().min(1).max(300),
      authoredMessage: z.string().max(50000),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      fidelity: z.enum(["host_attested_exact", "model_copied_unverified", "canonical_host_address", "canonical_source_agent"]),
    })).max(10000),
  }),
  conversationContext: z.array(z.object({
    sequence: z.number().int().min(1),
    messageId: z.string().min(1),
    speakerType: z.enum(["user", "host", "source_agent"]),
    speakerAgentId: z.string().min(1).optional(),
    speakerDisplayName: z.string().min(1).max(300),
    authoredMessage: z.string().max(50000),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    fidelity: z.enum(["host_attested_exact", "model_copied_unverified", "canonical_host_address", "canonical_source_agent"]),
  })).max(20),
  responseConstraints: z.object({
    maxAuthoredMessageChars: z.number().int().min(100).max(50000),
    maxQuoteChars: z.number().int().min(1).max(5000),
    maxTotalQuoteChars: z.number().int().min(1).max(10000),
    maxQuotes: z.number().int().min(0).max(20),
    maxDirectQuoteWords: z.number().int().min(0).max(500).optional(),
    locale: z.string().min(2).max(50),
  }),
});

export const agentRefSchema = z.object({
  agentId: z.string(),
  origin: z.string(),
  transport: z.enum(["local", "https", "gateway"]),
  manifestUrl: z.string().optional(),
  manifestDigestAtInvitation: z.string(),
  localAgentId: z.string().optional(),
  handle: z.string(),
  aliases: z.array(z.string()),
  displayName: z.string(),
  cardSnapshot: agentCardSchema,
});

export const conversationSessionSchema = z.object({
  schemaVersion: z.literal(1),
  conversationToken: z.string().min(20).max(200),
  inputFidelityPolicy: z.enum(["best_effort", "strict"]),
  lastSequence: z.number().int().min(0),
  agents: z.array(z.object({
    agent: agentRefSchema,
    joinedAtSequence: z.number().int().min(0),
    lastDeliveredSequence: z.number().int().min(0),
    createdAt: z.string(),
    updatedAt: z.string(),
  })),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const citationSchema = z.object({
  title: z.string().min(1).max(500),
  authors: z.array(z.string().max(200)).max(100),
  page: z.number().int().positive().optional(),
  location: z.string().max(500).optional(),
  quotedText: z.string().max(5000).optional(),
});

export const responseEnvelopeSchema = z.object({
  protocolVersion: z.literal(PROTOCOL_VERSION),
  messageId: z.string().uuid(),
  replyToInvocationId: z.string().uuid(),
  agentId: z.string().min(1),
  agentVersion: z.string().min(1),
  agentCardDigest: z.string().regex(/^[a-f0-9]{64}$/),
  authoredMessage: z.string().min(1).max(50000),
  citations: z.array(citationSchema).max(100),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  signature: z.string().min(1).max(10000),
});
