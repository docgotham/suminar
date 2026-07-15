import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createHash } from "node:crypto";
import { DirectAddressRequiredError } from "../core/conversationService.js";
import type { ConversationService, SyncableConversationEvent } from "../core/conversationService.js";
import type { AgentRef, ConversationInvocationResult, RecoveredCanonicalTurn } from "../core/types.js";

export const USER_MESSAGE_META_KEY = "agent-sum/user-message-v1";
export const CONVERSATION_EVENTS_META_KEY = "agent-sum/conversation-events-v1";

const attestedUserMessageMetaSchema = z.object({
  schemaVersion: z.literal(1),
  text: z.string().min(1).max(50000),
  hostMessageId: z.string().min(1).max(500).optional(),
  contentHash: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
  captureMethod: z.literal("host_raw_turn"),
  fidelity: z.literal("host_attested_exact"),
});

const attestedConversationEventsMetaSchema = z.object({
  schemaVersion: z.literal(1),
  events: z.array(z.object({
    speakerType: z.enum(["user", "host"]),
    speakerDisplayName: z.string().min(1).max(300).optional(),
    authoredMessage: z.string().min(1).max(50000),
    hostMessageId: z.string().min(1).max(500).optional(),
    contentHash: z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/),
    captureMethod: z.literal("host_raw_turn"),
    fidelity: z.literal("host_attested_exact"),
  })).max(500),
});

function sha256Matches(text: string, claimed: string): boolean {
  return createHash("sha256").update(text).digest("hex") === claimed.replace(/^sha256:/, "");
}

export function synchronizedEventsFromRequest(
  modelEvents: Array<{ speakerType: "user" | "host"; authoredMessage: string; speakerDisplayName?: string }>,
  meta: Record<string, unknown> | undefined,
): SyncableConversationEvent[] {
  const attestedBatch = meta?.[CONVERSATION_EVENTS_META_KEY];
  if (attestedBatch !== undefined) {
    const parsed = attestedConversationEventsMetaSchema.parse(attestedBatch);
    return parsed.events.map((event) => {
      if (!sha256Matches(event.authoredMessage, event.contentHash)) {
        throw new Error("Host-attested conversation-event hash does not match its text");
      }
      return {
        speakerType: event.speakerType,
        authoredMessage: event.authoredMessage,
        ...(event.speakerDisplayName ? { speakerDisplayName: event.speakerDisplayName } : {}),
        fidelity: event.fidelity,
        captureMethod: event.captureMethod,
        ...(event.hostMessageId ? { hostMessageId: event.hostMessageId } : {}),
      };
    });
  }
  const events: SyncableConversationEvent[] = modelEvents.map((event) => ({
    speakerType: event.speakerType,
    authoredMessage: event.authoredMessage,
    ...(event.speakerDisplayName ? { speakerDisplayName: event.speakerDisplayName } : {}),
    fidelity: "model_copied_unverified",
    captureMethod: "model_tool_argument",
  }));
  const attestedCurrentUser = meta?.[USER_MESSAGE_META_KEY];
  if (attestedCurrentUser !== undefined) {
    const parsed = attestedUserMessageMetaSchema.parse(attestedCurrentUser);
    if (!sha256Matches(parsed.text, parsed.contentHash)) {
      throw new Error("Host-attested user-message hash does not match its text");
    }
    const latestUserIndex = events.findLastIndex((event) => event.speakerType === "user");
    if (latestUserIndex < 0) throw new Error("Host attested a current user turn but the synchronization contains no user event");
    events[latestUserIndex] = {
      speakerType: "user",
      authoredMessage: parsed.text,
      speakerDisplayName: events[latestUserIndex]?.speakerDisplayName,
      fidelity: parsed.fidelity,
      captureMethod: parsed.captureMethod,
      ...(parsed.hostMessageId ? { hostMessageId: parsed.hostMessageId } : {}),
    };
  }
  return events;
}

function toolResult(
  text: string,
  structuredContent?: Record<string, unknown>,
  isError = false,
  meta?: Record<string, unknown>,
) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
    ...(isError ? { isError: true } : {}),
    ...(meta ? { _meta: meta } : {}),
  };
}

function modelReadableContinuation(conversationToken: string, cursor: number): string {
  return [
    "PRIVATE CONTINUATION STATE (machine-use only; never reproduce in the user-facing chat):",
    JSON.stringify({ conversationToken, cursor }),
  ].join("\n");
}

function publicOrigin(origin: string): string {
  if (origin.startsWith("agent-sum-local://")) return "local";
  try { return new URL(origin).origin; } catch { return "external"; }
}

function publicAgent(agent: AgentRef) {
  return {
    handle: agent.handle,
    displayName: agent.displayName,
    origin: publicOrigin(agent.origin),
    transport: agent.transport,
    sourceIdentity: agent.cardSnapshot.sourceIdentity,
    representativeCharter: agent.cardSnapshot.representativeCharter,
    capabilities: agent.cardSnapshot.capabilities,
    contextPolicy: agent.cardSnapshot.contextPolicy,
    memoryAndRetention: agent.cardSnapshot.memoryAndRetention,
  };
}

const HOST_CONDUCT_RULES = [
  "You are one participant in this shared conversation. Transport privileges give you no authority over, and no duty toward, another participant's speech.",
  "Reproduce each canonical turn exactly and in order, including its bold 📄 attribution line with the origin marker; build nothing around it.",
  "At most one short sentence of your own may precede the first canonical turn; none is better.",
  "If no part of the user's turn was addressed to you, end your visible message immediately after the final canonical turn: no summaries, evaluations, offers, or menus of further queries.",
  "Never offer to relay, push, probe, or re-query a source agent. To pursue a follow-up, register your own @handle message with proposed_host_address and display it; the user's bare affirmative then delivers it (ratified_host_address). A short ratification cue after your proposal is part of the proposal, not a service menu.",
  "If the user asked for your view, give it afterward as your own clearly host-authored contribution.",
  "Each source agent keeps exclusive custody of its private source and retrieval; never claim or offer direct inspection.",
];

const FINAL_TURN_RULE = "FINAL TURN RULE: Reproduce the canonical turns above exactly and in order. If no part of the current user turn was addressed to you the host, end your visible message immediately after the final canonical block — at most one short lead-in sentence before it, and nothing after it: no summaries, evaluations, offers, retries, or menus of further queries. Speak further only as a fellow participant, when the user asked you something or you have a genuinely independent contribution.";

// The server can never know whether a prior tool response actually reached
// the host — a client can time out after an answer was composed and stored.
// So recent canonical turns ride along under a conditional display contract:
// the host, the only party that can see the visible conversation, skips what
// is already shown and displays what is missing.
const DISPLAY_CHECK_HEADER = "CANONICAL DISPLAY CHECK (recovery): The blocks below are the most recent canonical turns recorded in this conversation. If every one already appears in the visible conversation, skip them all and do not mention them — that is the common case. If any block is missing from the visible conversation (for example because a previous Suminar call did not complete on your side), display each missing block verbatim now, in sequence order, before the rest of your reply. Never re-display a block that is already visible, never alter one, and never mention this check to the user.";

function displayCheckSection(turns?: RecoveredCanonicalTurn[]): string[] {
  if (!turns?.length) return [];
  return [[DISPLAY_CHECK_HEADER, ...turns.map((turn) => turn.displayText)].join("\n\n")];
}

function displayCheckPayload(turns?: RecoveredCanonicalTurn[]) {
  return turns?.length
    ? {
      recentCanonicalTurns: turns.map((turn) => ({
        sequence: turn.sequence,
        speakerType: turn.speakerType,
        displayText: turn.displayText,
        displayOnlyIfMissing: true,
      })),
    }
    : {};
}

// Error results after a successful embedded synchronization must hand the
// conversation back: a host that retries without the continuation forks a
// fresh server conversation and fragments the room (observed live — one
// ChatGPT thread produced six server conversations, three abandoned).
interface ErrorContinuation {
  text: string;
  payload: { conversationContinuation: { conversationToken: string; cursor: number; instruction: string } };
}

function errorContinuation(token: string | undefined, cursor: number | undefined): ErrorContinuation | undefined {
  if (token === undefined || cursor === undefined) return undefined;
  return {
    text: [
      modelReadableContinuation(token, cursor),
      "This conversation remains valid and already contains the synchronized events. Reuse this exact continuation state in the corrected retry (conversationToken with throughCursor, no re-synchronization) — never start a new conversation for the same host thread.",
    ].join("\n"),
    payload: {
      conversationContinuation: {
        conversationToken: token,
        cursor,
        instruction: "Reuse in the corrected retry within this same host thread; never display.",
      },
    },
  };
}

function proposalToolResult(result: ConversationInvocationResult, conductNotices: string[] = [], recovered?: RecoveredCanonicalTurn[]) {
  const proposal = result.proposedHostAddress!;
  const text = [
    ...displayCheckSection(recovered),
    "PROPOSAL RECORDED CONTRACT: Suminar recorded your exact @handle proposal below as your visible speech. Nothing was delivered. Display the proposal verbatim as your visible message, with at most a short ratification cue after it. If the user's next turn is a bare affirmative, synchronize only that user message (never the proposal—it is already recorded) and invoke ratified_host_address. If the user declines, redirects, or adds substance, continue normally; the proposal expires once any further event follows it.",
    "BEGIN RECORDED HOST PROPOSAL",
    proposal.displayText,
    "END RECORDED HOST PROPOSAL",
    ...(conductNotices.length ? [`HOST CONDUCT NOTICE (private; never show or mention to the user): ${conductNotices.join(" ")}`] : []),
    modelReadableContinuation(result.conversationToken, result.throughCursor),
  ].join("\n\n");
  return toolResult(text, {
    ...displayCheckPayload(recovered),
    proposedHostAddress: {
      speakerDisplayName: proposal.speakerDisplayName,
      authoredMessage: proposal.authoredMessage,
      displayText: proposal.displayText,
    },
    messages: [],
    conversationContinuation: {
      conversationToken: result.conversationToken,
      cursor: result.throughCursor,
      instruction: "Keep this state private and reuse it only in the same host conversation.",
    },
    displayContract: {
      mustDisplayProposalVerbatim: true,
      deliveryStatus: "awaiting_user_ratification",
      hostConduct: HOST_CONDUCT_RULES,
    },
  }, false, {
    "agent-sum/internal": {
      invocationId: result.invocationId,
      conversationToken: result.conversationToken,
      cursor: result.throughCursor,
    },
  });
}

const SHARED_CONTRACT_CORE = "The blocks below are other participants' actual visible turns in the shared conversation, not private tool output. Reproduce each canonical block exactly and in order; a block's first line — the bold 📄 attribution with its origin marker — is part of the participant's turn, not optional formatting, and must be displayed with the block. You are a fellow participant, not the presenter, curator, or explainer of source-agent speech: do not frame, summarize, interpret, evaluate, restate, or extend what the user can already read; do not narrate transport, truthfulness, or ordinary compliance; and do not offer further queries, retries, or alternative retrieval paths. Each source agent exclusively controls its private source and retrieval system; the host must not claim or offer to inspect them directly.";

function canonicalMessageToolResult(result: ConversationInvocationResult, conductNotices: string[] = [], recovered?: RecoveredCanonicalTurn[]) {
  if (!result.messages.length && !result.visibleHostAddress) {
    return invocationFailure(result.failures.map((failure) => `@${failure.handle}: ${failure.detail}`).join("; ") || "No source agent returned a canonical response", recovered);
  }
  const blocks = result.messages.map((message) => message.displayText).join("\n\n");
  const failureNotice = result.failures.length
    ? `\n\n${result.failures.map((failure) => `@${failure.handle}`).join(", ")} could not complete a verifiable response on this attempt. Addressing ${result.failures.length > 1 ? "them" : "it"} again may succeed.`
    : "";
  const contract = result.visibleHostAddress
    ? `VISIBLE TURN ORDER CONTRACT: ${SHARED_CONTRACT_CORE} The host-authored @address below is your own already-recorded speech, not the user's: display it exactly first, then each source-agent block exactly and in order.`
    : result.ratifiedHostAddress
      ? `RATIFIED ADDRESS CONTRACT: ${SHARED_CONTRACT_CORE} The user ratified your prior visible @handle proposal, which was delivered exactly as authored. That proposal is already visible in the conversation: do not display it again and do not reword it.`
      : `SHARED-CONVERSATION CONTRACT: ${SHARED_CONTRACT_CORE}`;
  const hostAddressSection = result.visibleHostAddress
    ? [
      "BEGIN CANONICAL VISIBLE HOST ADDRESS",
      result.visibleHostAddress.displayText,
      "END CANONICAL VISIBLE HOST ADDRESS",
    ]
    : [];
  const ratifiedSection = result.ratifiedHostAddress
    ? [`DELIVERED RATIFIED HOST ADDRESS (already visible in the conversation; do not display it again):\n${result.ratifiedHostAddress.authoredMessage}`]
    : [];
  const sourceSections = result.messages.length
    ? ["BEGIN CANONICAL SOURCE-AGENT BLOCKS", blocks, `END CANONICAL SOURCE-AGENT BLOCKS${failureNotice}`]
    : [`${result.failures.map((failure) => `@${failure.handle}`).join(", ") || "The addressed source agent"} could not complete a verifiable response on this attempt. Addressing ${result.failures.length > 1 ? "them" : "it"} again may succeed.`];
  const text = [
    contract,
    ...displayCheckSection(recovered),
    ...ratifiedSection,
    ...hostAddressSection,
    ...sourceSections,
    ...(conductNotices.length ? [`HOST CONDUCT NOTICE (private; never show or mention to the user): ${conductNotices.join(" ")}`] : []),
    modelReadableContinuation(result.conversationToken, result.throughCursor),
    FINAL_TURN_RULE,
  ].join("\n\n");
  const publicMessages = result.messages.map((message) => ({
    displayName: message.displayName,
    handle: message.handle,
    origin: publicOrigin(message.origin),
    authoredMessage: message.authoredMessage,
    citations: message.citations,
    displayText: message.displayText,
  }));
  return toolResult(text, {
    ...displayCheckPayload(recovered),
    ...(result.visibleHostAddress ? {
      visibleHostAddress: {
        speakerDisplayName: result.visibleHostAddress.speakerDisplayName,
        authoredMessage: result.visibleHostAddress.authoredMessage,
        displayText: result.visibleHostAddress.displayText,
      },
    } : {}),
    ...(result.ratifiedHostAddress ? {
      ratifiedHostAddress: {
        speakerDisplayName: result.ratifiedHostAddress.speakerDisplayName,
        authoredMessage: result.ratifiedHostAddress.authoredMessage,
        alreadyVisible: true,
      },
    } : {}),
    messages: publicMessages,
    conversationContinuation: {
      conversationToken: result.conversationToken,
      cursor: result.throughCursor,
      instruction: "Keep this state private and reuse it only in the same host conversation.",
    },
    deliverySummary: result.deliveries.map((delivery) => ({
      handle: delivery.handle,
      fromSequence: delivery.fromSequence,
      throughSequence: delivery.throughSequence,
      deliveredEventCount: delivery.deliveredEventCount,
    })),
    failures: result.failures.map((failure) => ({ handle: failure.handle, status: "no_canonical_response" })),
    ...(conductNotices.length ? { hostConductNotices: conductNotices } : {}),
    displayContract: {
      mustDisplayCanonicalBlocksVerbatim: true,
      mustDisplayVisibleHostAddressVerbatim: Boolean(result.visibleHostAddress),
      ratifiedHostAddressAlreadyVisible: Boolean(result.ratifiedHostAddress),
      orderedVisibleTurns: [
        ...(result.visibleHostAddress ? [{ speakerType: "host", displayText: result.visibleHostAddress.displayText }] : []),
        ...result.messages.map((message) => ({ speakerType: "source_agent", displayText: message.displayText })),
      ],
      hostConduct: HOST_CONDUCT_RULES,
    },
  }, false, {
    "agent-sum/internal": {
      invocationId: result.invocationId,
      conversationToken: result.conversationToken,
      cursor: result.throughCursor,
      messageIds: result.messages.map((message) => message.messageId),
      failures: result.failures,
    },
  });
}

function invocationFailure(detail: string, recovered?: RecoveredCanonicalTurn[], continuation?: ErrorContinuation) {
  const requiredDisclosure = "The addressed source agent could not complete a verifiable response on this attempt. Addressing it again may succeed.";
  return toolResult([
    ...displayCheckSection(recovered),
    `HOST FAILURE CONTRACT: ${recovered?.length ? "After first displaying any missing canonical blocks from the display check above, say" : "Say"} only the required disclosure below and stop. Do not answer on the source agent's behalf, use a cached answer, invent a cause, or offer an unrequested retry or alternate retrieval path.`,
    requiredDisclosure,
    `INTERNAL FAILURE DETAIL: ${detail}`,
    ...(continuation ? [continuation.text] : []),
  ].join("\n\n"), {
    status: "no_canonical_response",
    messages: [],
    ...displayCheckPayload(recovered),
    ...(continuation ? continuation.payload : {}),
    displayContract: { requiredDisclosure, stopAfterDisclosure: true },
  }, true, { "agent-sum/internal": { detail } });
}

function protocolMisuse(detail: string) {
  return toolResult([
    "HOST PROTOCOL ERROR: This tool call was malformed. Correct the call and retry silently. Do not mention this mechanical error to the user and do not treat it as a source-agent failure.",
    detail,
  ].join("\n\n"), {
    status: "protocol_misuse",
    messages: [],
    displayContract: { retrySilently: true },
  }, true, { "agent-sum/internal": { detail } });
}

function directAddressRequired(error: DirectAddressRequiredError, continuation?: ErrorContinuation) {
  return toolResult([
    "HOST AUTHORSHIP CONTRACT: Source agents are visible participants, not private tools. Use current_user only when the user's message begins with the selected @handle. If the user asked you to pose the question, invoke again in visible_host mode with the exact host-authored @handle message you will display before the source response. If the user's message is a bare affirmative ratifying the immediately preceding recorded host proposal, invoke again in ratified_host_address mode, synchronizing only that user message. If the user's question concerns a source but names no @handle and no proposal is pending, do not force a delivery: answer what you can as yourself from the visible record, and register the question with proposed_host_address as your own exact @handle message, then display it—the user's next bare affirmative will deliver it. Prefer registering that proposal yourself over instructing the user how to type an address. Never send an invisible restatement or attribute host wording to the user.",
    error.requiredDisclosure,
    ...(continuation ? [continuation.text] : []),
  ].join("\n\n"), {
    status: error.code,
    messages: [],
    ...(continuation ? continuation.payload : {}),
    displayContract: { requiredDisclosure: error.requiredDisclosure, stopAfterDisclosure: true },
  }, true, { "agent-sum/internal": { code: error.code, targetHandles: error.targetHandles } });
}

const syncableEventShape = {
  speakerType: z.enum(["user", "host"]),
  authoredMessage: z.string().min(1).max(50000).describe("Complete visible wording authored by this speaker. Do not summarize, extract, or include source-agent blocks embedded in host rendering."),
  speakerDisplayName: z.string().min(1).max(300).optional(),
};

export function createSuminarMcpServer(service: ConversationService): McpServer {
  const server = new McpServer({ name: "suminar", version: "0.10.0" }, {
    instructions: [
      "Suminar brings named situated source agents into the user's existing host-chat conversation as fellow participants. There are no Suminar rooms or panels in version one; the current Claude, ChatGPT, or other host thread is the conversational boundary.",
      "You, the host chatbot, are first and foremost one participant in that shared multi-party conversation. You also hold administrative transport privileges—like a group-chat member with admin rights who can add participants and guarantee message delivery. Those privileges are capabilities, not your conversational identity: they give you no authority over the meaning, status, or presentation of another participant's speech, and no duty to introduce, frame, explain, or extend it. Transport creates no interpretive standing; a user request for your analysis creates full standing.",
      "Perform all transport silently. Never announce, narrate, or describe tool activity—no announcing that you will relay a question, set something up, or report what came back. A canonical source-agent block is that participant's own visible turn, not a tool result you retrieved or a report you commissioned. Reproduce it exactly, and if no part of the user's turn was addressed to you, end your message immediately after the final block. Do not summarize, evaluate, restate, or certify what the user can already read, and do not append menus of possible next steps. This holds on quiet turns too: when the user merely reacts without asking anything, reply briefly as a participant or not at all—do not offer summaries, clarifications, or further queries as services. Never offer to relay, push, probe, or re-query an agent on the user's behalf. Participant voice, not operator voice: saying that another ingested source takes a very different line here is a contribution; offering to pose the same question to that source's agent is operator speech.",
      "Keep one private conversation token and cursor per host thread and never display either. A different host thread starts a new Suminar conversation by omitting the token at cursor 0. Conversation-specific memory never crosses host-thread tokens unless the user explicitly imports visible prior speech.",
      "Once Suminar is active, synchronize at the beginning of every user turn: send every completed visible user or host contribution after the acknowledged cursor, ordinarily the previous completed host message followed by the current complete user message; on first use, send the full visible history available to you. Synchronize only separately authored visible user and host speech—never canonical source-agent blocks or host addresses recorded through the address tool, delivered or proposed (Suminar records both itself), and never hidden reasoning, tool traces, system prompts, or private summaries. When the current turn culminates in addressing source agents, you may supply those same new events directly to suminar_address_source_agents and skip the separate synchronization call.",
      "Address one to three explicitly selected source agents per human-initiated cycle with suminar_address_source_agents; each invoked agent receives every conversation event after its own delivery cursor before it speaks, and a newly invoked agent receives the complete synchronized conversation. All address modes are visible. current_user: the user's own current message begins with each selected @handle. visible_host: the user asked you to put a question to a named @agent—author your own separate exact message beginning with that @handle; Suminar records it as your speech and you display it before the source-agent block. proposed_host_address: register a follow-up without delivering it—supply your exact message beginning with the selected @handle; Suminar records it as your visible speech, you display it with at most a short ratification cue, and nothing is delivered. ratified_host_address: the conversation's immediately preceding event is such a host proposal and the user's current turn is a bare affirmative such as yes, go ahead—synchronize only that user message (the proposal is already recorded) and Suminar delivers the proposal exactly as authored, without re-display. A bare affirmative can only ratify the immediately preceding proposal; it can never authorize a new, reworded, or invisible question, and host-authored wording is never attributed to the user.",
      "If you want to pursue a follow-up with a source agent, do it as a participant: author the follow-up yourself and register it with proposed_host_address in the same call that synchronizes the turn, then display the recorded proposal verbatim. A short ratification cue after your proposal is part of the proposal, not a service offer. Do not offer your transport services without a proposal on the table. The same move handles a user question about what a source contains when no @handle was given: answer what you can as yourself, then register and display the @handle question as your proposal rather than instructing the user how to address the agent.",
      "Each source agent has exclusive custody of its private source artifacts and retrieval system. Never claim or offer to pull passages, inspect pages, search the source, or verify quotations behind the agent; further inquiry into that source happens through another visible address. Your own knowledge and separate research tools remain welcome as an equal participant, clearly presented as your own contribution rather than access to the source agent's corpus.",
      "Ordinary MCP event copies are model_copied_unverified; only independently captured, hash-validated metadata is host_attested_exact. Never claim stronger transcript fidelity than the returned state supports. Use human-readable handles and source identities with the user; never expose conversation tokens, cursors, internal IDs, hashes, signatures, private origins, paths, or retrieval artifacts. Describe what a source agent can do in plain conversational language—it can check its own text—rather than protocol vocabulary such as capabilities, occurrence search, or tool names.",
    ].join(" "),
  });

  server.registerTool("suminar_list_agents", {
    title: "List Suminar Source Agents",
    description: "List source agents available to address by handle. This exposes source identity and origin facts, never private source artifacts or conversation state.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {},
  }, async () => {
    const agents = (await service.listAgents()).map(publicAgent);
    return toolResult(JSON.stringify(agents, null, 2), { agents });
  });

  server.registerTool("suminar_inspect_agent", {
    title: "Inspect Suminar Source Agent",
    description: "Inspect one source agent's public source identity, origin, representative charter, capabilities, context policy, and retention declaration.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { agentHandle: z.string().describe("The source agent's handle, with or without @.") },
  }, async ({ agentHandle }) => {
    try {
      const agent = publicAgent(await service.resolveAgent(agentHandle));
      return toolResult(JSON.stringify(agent, null, 2), { agent });
    } catch (error) {
      return toolResult(error instanceof Error ? error.message : String(error), undefined, true);
    }
  });

  server.registerTool("suminar_sync_conversation", {
    title: "Synchronize Visible Host Conversation",
    description: "Append completed visible user and host contributions to this host thread's private Suminar event stream. Call incrementally at the start of every turn once Suminar is active; when the same turn ends by addressing source agents, you may instead pass these events directly to suminar_address_source_agents in one call. Omit conversationToken only for first use in a new host thread. Never include source-agent canonical blocks, hidden reasoning, or tool traces. Perform this silently; it is administrative bookkeeping, not conversation.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: {
      conversationToken: z.string().min(20).max(200).optional().describe("Private continuation token returned by the preceding synchronization or address call in this same host thread. Omit only to start a new host-thread conversation. Never show it to the user."),
      afterCursor: z.number().int().min(0).describe("The last cursor acknowledged by Suminar for this host thread. Use 0 only for a new conversation."),
      completedVisibleEventsCopiedWithoutOmission: z.array(z.object(syncableEventShape)).min(1).max(500).describe("Every completed visible user or host contribution after afterCursor, in exact conversational order. Normally this is the previous host message followed by the current user message."),
      inputFidelityPolicy: z.enum(["best_effort", "strict"]).optional().describe("New conversations default to best_effort. Strict requires trusted host-attested user events and is unavailable to ordinary model-only hosts."),
    },
    outputSchema: {
      conversationContinuation: z.object({
        conversationToken: z.string(),
        cursor: z.number().int().min(0),
        instruction: z.string(),
      }),
      acceptedEvents: z.number().int().min(0),
      replayedEvents: z.number().int().min(0),
      hostConductNotices: z.array(z.string()).optional(),
      recentCanonicalTurns: z.array(z.object({
        sequence: z.number().int().min(1),
        speakerType: z.string(),
        displayText: z.string(),
        displayOnlyIfMissing: z.boolean(),
      })).optional(),
    },
  }, async ({ conversationToken, afterCursor, completedVisibleEventsCopiedWithoutOmission, inputFidelityPolicy }, extra) => {
    try {
      const events = synchronizedEventsFromRequest(completedVisibleEventsCopiedWithoutOmission, extra._meta);
      const result = await service.syncConversation({
        ...(conversationToken ? { conversationToken } : {}),
        afterCursor,
        events,
        ...(inputFidelityPolicy ? { inputFidelityPolicy } : {}),
      });
      return toolResult(
        [
          `Conversation synchronization accepted through cursor ${result.cursor}.`,
          ...displayCheckSection(result.recentCanonicalTurns),
          ...(result.hostConductNotices?.length
            ? [`HOST CONDUCT NOTICE (private; never show or mention to the user): ${result.hostConductNotices.join(" ")}`]
            : []),
          modelReadableContinuation(result.conversationToken, result.cursor),
          "Copy those values exactly into the next Suminar call in this host thread. Do not guess, shorten, summarize, or display them.",
        ].join("\n\n"),
        {
          conversationContinuation: {
            conversationToken: result.conversationToken,
            cursor: result.cursor,
            instruction: "Retain privately for the next Suminar call in this host thread; never display to the user.",
          },
          acceptedEvents: result.acceptedEvents,
          replayedEvents: result.replayedEvents,
          ...(result.hostConductNotices?.length ? { hostConductNotices: result.hostConductNotices } : {}),
          ...displayCheckPayload(result.recentCanonicalTurns),
        },
        false,
        { "agent-sum/internal": { conversationToken: result.conversationToken, cursor: result.cursor } },
      );
    } catch (error) {
      return toolResult(error instanceof Error ? error.message : String(error), undefined, true);
    }
  });

  server.registerTool("suminar_address_source_agents", {
    title: "Address Suminar Source Agents",
    description: "Deliver a visible address to one to three source agents in the synchronized host thread, optionally synchronizing this turn's new visible events in the same call (supply afterCursor plus completedVisibleEventsCopiedWithoutOmission and omit throughCursor; omit conversationToken only for first use). All address modes are visible: use current_user only when the user's message begins with every selected @handle; use visible_host when the user asked the host to pose the question—supply the exact host-authored @handle message that must be displayed before the source response; use proposed_host_address to register a follow-up without delivering it—supply the exact @handle message, which Suminar records as visible host speech for you to display with a short ratification cue; use ratified_host_address when the conversation's immediately preceding event is such a host proposal and the user's current turn is a bare affirmative—synchronize only that user message and the already-recorded proposal is delivered without re-display or rewording. Never send an invisible backchannel message or misattribute host wording to the user. Every selected agent receives its unseen visible conversation before speaking. Perform this transport silently: do not announce the call or narrate its mechanics, and treat the reply as another participant's speech, not retrieved output. The source agent retains exclusive source custody: this tool does not let the host inspect or search its private source. The host participates as itself rather than presenting or explaining the source agent's reply.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    inputSchema: {
      conversationToken: z.string().min(20).max(200).optional().describe("Private token returned by synchronization for this same host thread. Omit only when starting a new host-thread conversation in this call with afterCursor 0. Never display it."),
      throughCursor: z.number().int().min(1).optional().describe("The latest cursor returned by synchronization. Required when completedVisibleEventsCopiedWithoutOmission is omitted; omit it when synchronizing in this call."),
      afterCursor: z.number().int().min(0).optional().describe("Only with completedVisibleEventsCopiedWithoutOmission: the last acknowledged cursor, exactly as in suminar_sync_conversation."),
      completedVisibleEventsCopiedWithoutOmission: z.array(z.object(syncableEventShape)).min(1).max(500).optional().describe("Optional one-call synchronization: every completed visible user or host contribution after afterCursor, in exact order, ending with the current complete user message. Never include source-agent canonical blocks."),
      targetHandles: z.array(z.string()).min(1).max(3).describe("One to three source-agent handles selected for this human-initiated cycle."),
      addressMode: z.enum(["current_user", "visible_host", "proposed_host_address", "ratified_host_address"]).optional().describe("current_user only for a user turn beginning with the selected @handle. visible_host when the user asked the host to pose the question visibly. proposed_host_address to record a host follow-up proposal without delivering it. ratified_host_address when the user's bare affirmative ratifies the immediately preceding recorded host proposal."),
      visibleHostMessage: z.string().min(1).max(50000).optional().describe("Required in visible_host and proposed_host_address modes: the host's exact separately authored message beginning with the selected @handle. Suminar records it and requires it to appear visibly. Forbidden in ratified_host_address mode, which delivers the already-recorded proposal."),
      visibleHostDisplayName: z.string().min(1).max(300).optional().describe("Optional visible host participant name, such as Claude. Used with visible_host and proposed_host_address modes."),
      maxDirectQuoteWords: z.number().int().min(0).max(500).optional().describe("Optional fresh maximum total directly quoted source words this host can reproduce unchanged. Omit when there is no host-specific ceiling."),
    },
    outputSchema: {
      messages: z.array(z.object({
        displayName: z.string(),
        handle: z.string(),
        origin: z.string(),
        authoredMessage: z.string(),
        citations: z.array(z.unknown()),
        displayText: z.string(),
      })),
      visibleHostAddress: z.object({
        speakerDisplayName: z.string(),
        authoredMessage: z.string(),
        displayText: z.string(),
      }).optional(),
      ratifiedHostAddress: z.object({
        speakerDisplayName: z.string(),
        authoredMessage: z.string(),
        alreadyVisible: z.boolean(),
      }).optional(),
      proposedHostAddress: z.object({
        speakerDisplayName: z.string(),
        authoredMessage: z.string(),
        displayText: z.string(),
      }).optional(),
      conversationContinuation: z.object({
        conversationToken: z.string(),
        cursor: z.number().int().min(0),
        instruction: z.string(),
      }).optional(),
      deliverySummary: z.array(z.unknown()).optional(),
      failures: z.array(z.unknown()).optional(),
      hostConductNotices: z.array(z.string()).optional(),
      displayContract: z.record(z.string(), z.unknown()),
      status: z.string().optional(),
    },
  }, async ({
    conversationToken,
    throughCursor,
    afterCursor,
    completedVisibleEventsCopiedWithoutOmission,
    targetHandles,
    addressMode,
    visibleHostMessage,
    visibleHostDisplayName,
    maxDirectQuoteWords,
  }, extra) => {
    let token = conversationToken;
    let cursor = throughCursor;
    let recovered: RecoveredCanonicalTurn[] | undefined;
    try {
      if (addressMode === "ratified_host_address" && visibleHostMessage !== undefined) {
        return protocolMisuse("ratified_host_address delivers the host's already-visible proposal exactly as authored; omit visibleHostMessage.");
      }
      let conductNotices: string[] = [];
      if (completedVisibleEventsCopiedWithoutOmission !== undefined) {
        if (afterCursor === undefined) {
          return protocolMisuse("Supply afterCursor with completedVisibleEventsCopiedWithoutOmission, exactly as in suminar_sync_conversation.");
        }
        if (throughCursor !== undefined) {
          return protocolMisuse("Omit throughCursor when synchronizing in this call; the embedded synchronization determines the delivery cursor.");
        }
        let sync;
        try {
          const events = synchronizedEventsFromRequest(completedVisibleEventsCopiedWithoutOmission, extra._meta);
          sync = await service.syncConversation({
            ...(token ? { conversationToken: token } : {}),
            afterCursor,
            events,
          });
        } catch (error) {
          return protocolMisuse(error instanceof Error ? error.message : String(error));
        }
        token = sync.conversationToken;
        cursor = sync.cursor;
        conductNotices = sync.hostConductNotices ?? [];
        recovered = sync.recentCanonicalTurns;
      } else {
        if (afterCursor !== undefined) {
          return protocolMisuse("afterCursor is only used together with completedVisibleEventsCopiedWithoutOmission.");
        }
        if (!token || cursor === undefined) {
          return protocolMisuse("Supply conversationToken and throughCursor, or synchronize in this call with afterCursor and completedVisibleEventsCopiedWithoutOmission.");
        }
      }
      const result = await service.invokeAgents({
        conversationToken: token,
        throughCursor: cursor,
        targetHandles,
        ...(addressMode ? { addressMode } : {}),
        ...(visibleHostMessage ? { visibleHostMessage } : {}),
        ...(visibleHostDisplayName ? { visibleHostDisplayName } : {}),
        ...(maxDirectQuoteWords !== undefined ? { maxDirectQuoteWords } : {}),
      });
      return result.proposedHostAddress
        ? proposalToolResult(result, conductNotices, recovered)
        : canonicalMessageToolResult(result, conductNotices, recovered);
    } catch (error) {
      const continuation = errorContinuation(token, cursor);
      if (error instanceof DirectAddressRequiredError) return directAddressRequired(error, continuation);
      return invocationFailure(error instanceof Error ? error.message : String(error), recovered, continuation);
    }
  });

  server.registerTool("suminar_read_message", {
    title: "Read Canonical Source-Agent Message",
    description: "Recover an exact canonical source-agent utterance by its internal message ID. The host should use IDs only from private tool metadata and never expose them to the user.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    inputSchema: { messageId: z.string() },
  }, async ({ messageId }) => {
    const record = await service.store.readAgentMessage(messageId);
    if (!record?.responseEnvelope) return toolResult("Canonical message not found", undefined, true);
    return toolResult(record.body, {
      authoredMessage: record.body,
      responseEnvelope: record.responseEnvelope,
    });
  });

  server.registerTool("suminar_preview_remote_origin", {
    title: "Preview Remote Suminar Origin",
    description: "Inspect a proposed remote source-agent card before adding it through the local management interface. This verifies factual origin and protocol fields, not scholarly quality.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { manifestUrl: z.string().url() },
  }, async ({ manifestUrl }) => {
    try {
      const preview = await service.previewRemoteAgent(manifestUrl);
      const publicPreview = {
        manifestUrl: preview.manifestUrl,
        manifestDigest: preview.manifestDigest,
        firstContactWarning: preview.firstContactWarning,
        agent: publicAgent({
          agentId: preview.card.agentId,
          origin: preview.card.origin,
          transport: "https",
          manifestUrl: preview.manifestUrl,
          manifestDigestAtInvitation: preview.manifestDigest,
          handle: preview.card.handle,
          aliases: [],
          displayName: preview.card.displayName,
          cardSnapshot: preview.card,
        }),
      };
      return toolResult(JSON.stringify(publicPreview, null, 2), { preview: publicPreview });
    } catch (error) {
      return toolResult(error instanceof Error ? error.message : String(error), undefined, true);
    }
  });

  return server;
}
