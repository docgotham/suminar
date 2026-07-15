import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { digestJson, sha256 } from "../core/crypto.js";
import type { ConversationStore } from "../core/storage.js";
import type {
  AgentRef,
  ConversationEvent,
  ConversationSession,
  LocalAgentManifest,
  StoredCanonicalMessage,
} from "../core/types.js";

interface AgentArtifactRow {
  kind: "original" | "markdown" | "chunks" | "embeddings" | "extraction_report" | "private_key";
  storage_key: string;
}

interface SourceAgentRow {
  agent_id: string;
  card: LocalAgentManifest["card"];
  card_digest: string;
  extraction_status: LocalAgentManifest["extractionStatus"];
  source_hash: string;
  created_at: string;
  updated_at: string;
  agent_artifacts: AgentArtifactRow[];
}

interface SyndicationGrantRow {
  local_handle: string;
  source_agents: SourceAgentRow;
}

const GRANT_SELECT = "local_handle, source_agents!inner(agent_id, card, card_digest, extraction_status, source_hash, created_at, updated_at, agent_artifacts(kind, storage_key))";

interface ConversationAgentRow {
  agent_id: string;
  agent_ref: AgentRef;
  joined_at_sequence: number;
  last_delivered_sequence: number;
  created_at: string;
  updated_at: string;
}

interface ConversationRow {
  token: string;
  input_fidelity_policy: ConversationSession["inputFidelityPolicy"];
  last_sequence: number;
  created_at: string;
  updated_at: string;
  conversation_agents: ConversationAgentRow[];
}

function unwrap<T>(result: { data: T | null; error: { message: string } | null }, context: string): T {
  if (result.error) throw new Error(`${context}: ${result.error.message}`);
  if (result.data === null) throw new Error(`${context}: no data returned`);
  return result.data;
}

// Multi-tenant ConversationStore over Supabase Postgres. Every query is scoped
// to one account even though the hosted layer holds a service-role client;
// RLS remains the second wall for any authenticated-client path, and the
// append-only conversation_events trigger holds for every role.
export class SupabaseStore implements ConversationStore {
  constructor(private readonly client: SupabaseClient, private readonly owner: string) {}

  private readonly ownedTokens = new Set<string>();

  private manifestFromRow(row: SourceAgentRow): LocalAgentManifest {
    const keys = new Map(row.agent_artifacts.map((artifact) => [artifact.kind, artifact.storage_key]));
    const required = (kind: AgentArtifactRow["kind"]): string => {
      const key = keys.get(kind);
      if (!key) throw new Error(`Source agent ${row.agent_id} is missing its ${kind} artifact`);
      return key;
    };
    return {
      schemaVersion: 1,
      agentId: row.agent_id,
      card: row.card,
      cardDigest: row.card_digest,
      privateArtifacts: {
        originalPdf: required("original"),
        markdown: required("markdown"),
        chunks: required("chunks"),
        ...(keys.has("embeddings") ? { embeddings: keys.get("embeddings")! } : {}),
        extractionReport: required("extraction_report"),
        privateKey: required("private_key"),
      },
      extractionStatus: row.extraction_status,
      sourceHash: row.source_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  // A syndicated agent is the grantor's manifest wearing the recipient's
  // local handle: same artifacts, same custody, a different name at this
  // table. The card's origin stays the grantor's (custody truly didn't
  // move, and origin is a URL by schema); the dashboard badge carries the
  // syndication story. The digest is recomputed for self-consistency.
  private syndicatedManifest(row: SourceAgentRow, localHandle: string): LocalAgentManifest {
    const base = this.manifestFromRow(row);
    const card = { ...base.card, handle: localHandle };
    return { ...base, card, cardDigest: digestJson(card) };
  }

  async listLocalAgentManifests(): Promise<LocalAgentManifest[]> {
    const rows = unwrap(await this.client
      .from("source_agents")
      .select("agent_id, card, card_digest, extraction_status, source_hash, created_at, updated_at, agent_artifacts(kind, storage_key)")
      .eq("owner", this.owner)
      .order("created_at", { ascending: true }), "List source agents");
    const owned = (rows as unknown as SourceAgentRow[]).map((row) => this.manifestFromRow(row));
    // The syndication aperture: agents granted to this account join the
    // roster read-only, artifacts still keyed to the grantor's storage.
    const grants = unwrap(await this.client
      .from("agent_syndication_grants")
      .select(GRANT_SELECT)
      .eq("grantee_user_id", this.owner)
      .is("revoked_at", null)
      .order("created_at", { ascending: true }), "List syndicated agents");
    const granted = (grants as unknown as SyndicationGrantRow[])
      .map((grant) => this.syndicatedManifest(grant.source_agents, grant.local_handle));
    return [...owned, ...granted];
  }

  async getLocalAgentManifest(agentId: string): Promise<LocalAgentManifest> {
    const result = await this.client
      .from("source_agents")
      .select("agent_id, card, card_digest, extraction_status, source_hash, created_at, updated_at, agent_artifacts(kind, storage_key)")
      .eq("owner", this.owner)
      .eq("agent_id", agentId)
      .maybeSingle();
    if (result.error) throw new Error(`Load source agent: ${result.error.message}`);
    if (result.data) return this.manifestFromRow(result.data as unknown as SourceAgentRow);
    const grant = await this.client
      .from("agent_syndication_grants")
      .select(GRANT_SELECT)
      .eq("grantee_user_id", this.owner)
      .eq("agent_id", agentId)
      .is("revoked_at", null)
      .maybeSingle();
    if (grant.error) throw new Error(`Load syndicated agent: ${grant.error.message}`);
    if (grant.data) {
      const row = grant.data as unknown as SyndicationGrantRow;
      return this.syndicatedManifest(row.source_agents, row.local_handle);
    }
    throw new Error(`Unknown local agent: ${agentId}`);
  }

  listRemoteAgentRefs(): AgentRef[] {
    return [];
  }

  saveRemoteAgentRef(_agent: AgentRef): void {
    throw new Error("Remote source agents are not available in hosted Suminar v1");
  }

  removeRemoteAgentRef(_agentId: string): void {
    throw new Error("Remote source agents are not available in hosted Suminar v1");
  }

  async createConversation(inputFidelityPolicy: ConversationSession["inputFidelityPolicy"] = "best_effort"): Promise<ConversationSession> {
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
    unwrap(await this.client.from("conversations").insert({
      token: conversation.conversationToken,
      owner: this.owner,
      input_fidelity_policy: inputFidelityPolicy,
      last_sequence: 0,
    }).select("token").single(), "Create conversation");
    this.ownedTokens.add(conversation.conversationToken);
    return conversation;
  }

  async getConversation(conversationToken: string): Promise<ConversationSession> {
    if (!/^conv_[a-f0-9_-]{60,}$/i.test(conversationToken)) throw new Error("Invalid conversation token");
    const result = await this.client
      .from("conversations")
      .select("token, input_fidelity_policy, last_sequence, created_at, updated_at, conversation_agents(agent_id, agent_ref, joined_at_sequence, last_delivered_sequence, created_at, updated_at)")
      .eq("owner", this.owner)
      .eq("token", conversationToken)
      .maybeSingle();
    if (result.error) throw new Error(`Load conversation: ${result.error.message}`);
    if (!result.data) throw new Error("Unknown or expired Suminar conversation token");
    const row = result.data as unknown as ConversationRow;
    this.ownedTokens.add(row.token);
    return {
      schemaVersion: 1,
      conversationToken: row.token,
      inputFidelityPolicy: row.input_fidelity_policy,
      lastSequence: row.last_sequence,
      agents: row.conversation_agents
        .sort((a, b) => a.created_at.localeCompare(b.created_at))
        .map((agentRow) => ({
          agent: agentRow.agent_ref,
          joinedAtSequence: agentRow.joined_at_sequence,
          lastDeliveredSequence: agentRow.last_delivered_sequence,
          createdAt: agentRow.created_at,
          updatedAt: agentRow.updated_at,
        })),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async assertOwnedConversation(conversationToken: string): Promise<void> {
    if (this.ownedTokens.has(conversationToken)) return;
    await this.getConversation(conversationToken);
  }

  async saveConversation(conversation: ConversationSession): Promise<void> {
    await this.assertOwnedConversation(conversation.conversationToken);
    unwrap(await this.client
      .from("conversations")
      .update({
        input_fidelity_policy: conversation.inputFidelityPolicy,
        last_sequence: conversation.lastSequence,
      })
      .eq("owner", this.owner)
      .eq("token", conversation.conversationToken)
      .select("token")
      .single(), "Save conversation");
    if (conversation.agents.length) {
      unwrap(await this.client
        .from("conversation_agents")
        .upsert(conversation.agents.map((state) => ({
          conversation_token: conversation.conversationToken,
          agent_id: state.agent.agentId,
          agent_ref: state.agent,
          joined_at_sequence: state.joinedAtSequence,
          last_delivered_sequence: state.lastDeliveredSequence,
        })), { onConflict: "conversation_token,agent_id" })
        .select("agent_id"), "Save conversation agents");
    }
  }

  async appendConversationEvent(
    conversationToken: string,
    input: Omit<ConversationEvent, "schemaVersion" | "eventId" | "createdAt" | "contentHash" | "conversationToken">,
  ): Promise<ConversationEvent> {
    await this.assertOwnedConversation(conversationToken);
    const event: ConversationEvent = {
      schemaVersion: 1,
      conversationToken,
      eventId: randomUUID(),
      createdAt: new Date().toISOString(),
      contentHash: sha256(input.authoredMessage),
      ...input,
    };
    unwrap(await this.client.from("conversation_events").insert({
      conversation_token: conversationToken,
      sequence: event.sequence,
      event,
    }).select("sequence").single(), "Append conversation event");
    return event;
  }

  async readConversationEvents(conversationToken: string): Promise<ConversationEvent[]> {
    await this.assertOwnedConversation(conversationToken);
    const rows = unwrap(await this.client
      .from("conversation_events")
      .select("event")
      .eq("conversation_token", conversationToken)
      .order("sequence", { ascending: true }), "Read conversation events");
    return (rows as Array<{ event: ConversationEvent }>).map((row) => row.event);
  }

  async readAgentMessage(messageId: string): Promise<StoredCanonicalMessage | undefined> {
    const result = await this.client
      .from("conversation_events")
      .select("event, conversations!inner(owner)")
      .eq("conversations.owner", this.owner)
      .eq("event->>canonicalMessageId", messageId)
      .eq("event->>speakerType", "source_agent")
      .limit(1)
      .maybeSingle();
    if (result.error) throw new Error(`Read canonical message: ${result.error.message}`);
    if (!result.data) return undefined;
    const event = (result.data as unknown as { event: ConversationEvent }).event;
    if (!event.responseEnvelope) return undefined;
    return {
      recordId: event.eventId,
      createdAt: event.createdAt,
      ...(event.speakerAgentId ? { speakerAgentId: event.speakerAgentId } : {}),
      body: event.authoredMessage,
      bodyHash: event.contentHash,
      messageId: event.canonicalMessageId!,
      invocationId: event.invocationId,
      maxDirectQuoteWords: event.maxDirectQuoteWords,
      responseEnvelope: event.responseEnvelope,
    };
  }
}
