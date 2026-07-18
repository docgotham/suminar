import { createHash, randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ConversationStore, MaybePromise } from "../core/storage.js";
import type {
  AgentRef,
  ConversationEvent,
  ConversationSession,
  LocalAgentManifest,
  StoredCanonicalMessage,
} from "../core/types.js";

// A2: grant-based continuation credentials. The conversation's raw token is
// its primary key and cannot rotate, so it must never be the thing a host
// thread holds. A grant is a revocable stand-in: on the wire it behaves
// exactly like a conversation token (hosts can't tell and don't need to),
// and the store boundary resolves it. The raw token never travels back to a
// grant-holding host — every session and event echoed to the service carries
// the caller's own credential.

const GRANT_TOKEN_PATTERN = /^convg_[a-f0-9]{40}$/i;

export function isGrantToken(token: string): boolean {
  return GRANT_TOKEN_PATTERN.test(token);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface ResolvedGrant {
  id: string;
  conversationToken: string;
  label: string;
}

// The decorator's only dependency; tests fake it, Supabase implements it.
export interface GrantDirectory {
  resolve(grantToken: string): Promise<ResolvedGrant | null>;
  mint(conversationToken: string, label: string): Promise<{ grantToken: string; id: string }>;
}

export class SupabaseGrantDirectory implements GrantDirectory {
  constructor(private readonly client: SupabaseClient, private readonly owner: string) {}

  async resolve(grantToken: string): Promise<ResolvedGrant | null> {
    if (!isGrantToken(grantToken)) return null;
    const result = await this.client
      .from("conversation_grants")
      .select("id, conversation_token, label")
      .eq("token_hash", sha256Hex(grantToken))
      .eq("owner", this.owner)
      .is("revoked_at", null)
      .maybeSingle();
    if (result.error || !result.data) return null;
    const row = result.data as { id: string; conversation_token: string; label: string | null };
    // Recency is display data for the companion's connected-hosts view;
    // never let its bookkeeping fail a real request.
    try {
      await this.client
        .from("conversation_grants")
        .update({ last_used_at: new Date().toISOString() })
        .eq("id", row.id);
    } catch {
      // best-effort only
    }
    return { id: row.id, conversationToken: row.conversation_token, label: row.label ?? "Connected host" };
  }

  async mint(conversationToken: string, label: string): Promise<{ grantToken: string; id: string }> {
    const grantToken = `convg_${randomBytes(20).toString("hex")}`;
    const inserted = await this.client
      .from("conversation_grants")
      .insert({
        token_hash: sha256Hex(grantToken),
        conversation_token: conversationToken,
        owner: this.owner,
        label,
      })
      .select("id")
      .single();
    if (inserted.error || !inserted.data) {
      throw new Error(`Mint conversation grant: ${inserted.error?.message ?? "no data returned"}`);
    }
    return { grantToken, id: (inserted.data as { id: string }).id };
  }
}

// Wraps the hosted store so grants resolve transparently. Raw conversation
// tokens pass straight through (existing threads unaffected); grant tokens
// translate to the raw token on the way in and back to the caller's
// credential on the way out. Events appended through a grant are stamped
// with its id — record provenance for "which host carried which turn".
export class GrantResolvingStore implements ConversationStore {
  private readonly resolved = new Map<string, ResolvedGrant>();

  constructor(
    private readonly inner: ConversationStore,
    private readonly grants: GrantDirectory,
    private readonly originLabel: string = "Origin thread",
  ) {}

  private async resolution(token: string): Promise<ResolvedGrant | null> {
    if (!isGrantToken(token)) return null;
    const cached = this.resolved.get(token);
    if (cached) return cached;
    const grant = await this.grants.resolve(token);
    // Revoked and unknown grants are the same dead credential; the message
    // matches the store's raw-token miss so hosts follow one recovery path.
    if (!grant) throw new Error("Unknown or expired Suminar conversation token");
    this.resolved.set(token, grant);
    return grant;
  }

  async createConversation(
    inputFidelityPolicy?: ConversationSession["inputFidelityPolicy"],
  ): Promise<ConversationSession> {
    const session = await this.inner.createConversation(inputFidelityPolicy);
    // New conversations hand their first host a revocable grant at birth so
    // the raw token never travels. Minting is an enhancement: if it fails,
    // the conversation still works on the raw token (pre-A2 behavior).
    try {
      const minted = await this.grants.mint(session.conversationToken, this.originLabel);
      this.resolved.set(minted.grantToken, {
        id: minted.id,
        conversationToken: session.conversationToken,
        label: this.originLabel,
      });
      return { ...session, conversationToken: minted.grantToken };
    } catch {
      return session;
    }
  }

  async getConversation(conversationToken: string): Promise<ConversationSession> {
    const grant = await this.resolution(conversationToken);
    if (!grant) return this.inner.getConversation(conversationToken);
    const session = await this.inner.getConversation(grant.conversationToken);
    return { ...session, conversationToken };
  }

  async saveConversation(conversation: ConversationSession): Promise<void> {
    const grant = await this.resolution(conversation.conversationToken);
    if (!grant) return this.inner.saveConversation(conversation);
    // Clone rather than mutate: the service keeps using this session object
    // (and its credential) after the save.
    return this.inner.saveConversation({ ...conversation, conversationToken: grant.conversationToken });
  }

  async appendConversationEvent(
    conversationToken: string,
    input: Omit<ConversationEvent, "schemaVersion" | "eventId" | "createdAt" | "contentHash" | "conversationToken">,
  ): Promise<ConversationEvent> {
    const grant = await this.resolution(conversationToken);
    if (!grant) return this.inner.appendConversationEvent(conversationToken, input);
    const event = await this.inner.appendConversationEvent(grant.conversationToken, {
      ...input,
      viaGrantId: grant.id,
    });
    return { ...event, conversationToken };
  }

  async appendConversationEventsAtHead(
    conversationToken: string,
    inputs: Array<Omit<ConversationEvent, "schemaVersion" | "eventId" | "createdAt" | "contentHash" | "conversationToken" | "sequence">>,
  ): Promise<ConversationEvent[]> {
    const grant = await this.resolution(conversationToken);
    if (!grant) return this.inner.appendConversationEventsAtHead(conversationToken, inputs);
    const events = await this.inner.appendConversationEventsAtHead(
      grant.conversationToken,
      inputs.map((input) => ({ ...input, viaGrantId: grant.id })),
    );
    return events.map((event) => ({ ...event, conversationToken }));
  }

  async readConversationEvents(conversationToken: string): Promise<ConversationEvent[]> {
    const grant = await this.resolution(conversationToken);
    if (!grant) return this.inner.readConversationEvents(conversationToken);
    const events = await this.inner.readConversationEvents(grant.conversationToken);
    return events.map((event) => ({ ...event, conversationToken }));
  }

  listLocalAgentManifests(): MaybePromise<LocalAgentManifest[]> {
    return this.inner.listLocalAgentManifests();
  }

  getLocalAgentManifest(agentId: string): MaybePromise<LocalAgentManifest> {
    return this.inner.getLocalAgentManifest(agentId);
  }

  listRemoteAgentRefs(): MaybePromise<AgentRef[]> {
    return this.inner.listRemoteAgentRefs();
  }

  saveRemoteAgentRef(agent: AgentRef): MaybePromise<void> {
    return this.inner.saveRemoteAgentRef(agent);
  }

  removeRemoteAgentRef(agentId: string): MaybePromise<void> {
    return this.inner.removeRemoteAgentRef(agentId);
  }

  readAgentMessage(messageId: string): MaybePromise<StoredCanonicalMessage | undefined> {
    return this.inner.readAgentMessage(messageId);
  }
}
