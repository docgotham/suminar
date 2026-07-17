import { describe, expect, it } from "vitest";
import { GrantResolvingStore, isGrantToken } from "../src/hosted/grants.js";
import type { GrantDirectory, ResolvedGrant } from "../src/hosted/grants.js";
import type { ConversationStore } from "../src/core/storage.js";
import type { ConversationEvent, ConversationSession } from "../src/core/types.js";

// A2 unit surface: the GrantResolvingStore decorator. The two load-bearing
// invariants are (1) a grant token resolves to the real conversation for the
// inner store, and (2) the raw conversation token NEVER travels back to a
// grant-holding caller — every session and event echoes the credential the
// caller presented. Provenance (viaGrantId) is stamped on appends.

// A minimal in-memory inner store. Conversation methods are real (the paths
// the decorator drives); agent/message passthroughs are inert.
class FakeInnerStore implements ConversationStore {
  private seq = 0;
  private nextConv = 0;
  readonly conversations = new Map<string, ConversationSession>();
  readonly events = new Map<string, ConversationEvent[]>();
  readonly appendedTokens: string[] = [];
  readonly appendedViaGrant: (string | undefined)[] = [];

  createConversation(inputFidelityPolicy: ConversationSession["inputFidelityPolicy"] = "best_effort"): ConversationSession {
    const token = `conv_${"a".repeat(30)}_${String(this.nextConv++).padStart(30, "0")}`;
    const now = new Date(0).toISOString();
    const session: ConversationSession = {
      schemaVersion: 1,
      conversationToken: token,
      inputFidelityPolicy,
      lastSequence: 0,
      agents: [],
      createdAt: now,
      updatedAt: now,
    };
    this.conversations.set(token, session);
    this.events.set(token, []);
    return session;
  }

  getConversation(conversationToken: string): ConversationSession {
    const session = this.conversations.get(conversationToken);
    if (!session) throw new Error("Unknown or expired Suminar conversation token");
    return { ...session };
  }

  saveConversation(conversation: ConversationSession): void {
    this.conversations.set(conversation.conversationToken, { ...conversation });
  }

  appendConversationEvent(
    conversationToken: string,
    input: Omit<ConversationEvent, "schemaVersion" | "eventId" | "createdAt" | "contentHash" | "conversationToken">,
  ): ConversationEvent {
    this.appendedTokens.push(conversationToken);
    this.appendedViaGrant.push(input.viaGrantId);
    const event: ConversationEvent = {
      schemaVersion: 1,
      conversationToken,
      eventId: `evt_${this.seq++}`,
      createdAt: new Date(0).toISOString(),
      contentHash: "hash",
      ...input,
    };
    const list = this.events.get(conversationToken) ?? [];
    list.push(event);
    this.events.set(conversationToken, list);
    return event;
  }

  readConversationEvents(conversationToken: string): ConversationEvent[] {
    return (this.events.get(conversationToken) ?? []).map((event) => ({ ...event }));
  }

  // Passthrough surface — never exercised by the grant paths.
  listLocalAgentManifests() { return []; }
  getLocalAgentManifest(): never { throw new Error("not used"); }
  listRemoteAgentRefs() { return []; }
  saveRemoteAgentRef(): void {}
  removeRemoteAgentRef(): void {}
  readAgentMessage() { return undefined; }
}

class FakeGrantDirectory implements GrantDirectory {
  private counter = 0;
  readonly byToken = new Map<string, ResolvedGrant>();
  minted: Array<{ conversationToken: string; label: string; grantToken: string }> = [];
  failMint = false;

  seed(grantToken: string, grant: ResolvedGrant): void {
    this.byToken.set(grantToken, grant);
  }

  async resolve(grantToken: string): Promise<ResolvedGrant | null> {
    if (!isGrantToken(grantToken)) return null;
    return this.byToken.get(grantToken) ?? null;
  }

  async mint(conversationToken: string, label: string): Promise<{ grantToken: string; id: string }> {
    if (this.failMint) throw new Error("mint failed");
    const grantToken = `convg_${String(this.counter).padStart(40, "0")}`;
    const id = `grant-${this.counter++}`;
    this.byToken.set(grantToken, { id, conversationToken, label });
    this.minted.push({ conversationToken, label, grantToken });
    return { grantToken, id };
  }
}

const GRANT_TOKEN = `convg_${"b".repeat(40)}`;

describe("isGrantToken", () => {
  it("matches convg_ + 40 hex, and nothing else", () => {
    expect(isGrantToken(GRANT_TOKEN)).toBe(true);
    expect(isGrantToken(`convg_${"b".repeat(39)}`)).toBe(false);
    expect(isGrantToken(`convg_${"g".repeat(40)}`)).toBe(false);
    expect(isGrantToken(`conv_${"a".repeat(60)}`)).toBe(false);
    expect(isGrantToken("")).toBe(false);
  });
});

describe("GrantResolvingStore", () => {
  it("passes raw conversation tokens straight through", async () => {
    const inner = new FakeInnerStore();
    const grants = new FakeGrantDirectory();
    const store = new GrantResolvingStore(inner, grants);
    const created = inner.createConversation();

    const session = await store.getConversation(created.conversationToken);
    expect(session.conversationToken).toBe(created.conversationToken);

    await store.appendConversationEvent(created.conversationToken, {
      sequence: 1, speakerType: "user", speakerDisplayName: "User",
      authoredMessage: "hi", fidelity: "model_copied_unverified",
    });
    expect(inner.appendedTokens).toEqual([created.conversationToken]);
    expect(inner.appendedViaGrant).toEqual([undefined]); // no grant provenance on raw path
  });

  it("mints a grant at conversation birth and never returns the raw token", async () => {
    const inner = new FakeInnerStore();
    const grants = new FakeGrantDirectory();
    const store = new GrantResolvingStore(inner, grants);

    const session = await store.createConversation();
    expect(isGrantToken(session.conversationToken)).toBe(true);
    expect(grants.minted).toHaveLength(1);
    expect(grants.minted[0]!.label).toBe("Origin thread");
    // The minted grant resolves to a real conversation the inner store holds.
    expect(inner.conversations.has(grants.minted[0]!.conversationToken)).toBe(true);
  });

  it("falls open to the raw token if minting fails at birth", async () => {
    const inner = new FakeInnerStore();
    const grants = new FakeGrantDirectory();
    grants.failMint = true;
    const store = new GrantResolvingStore(inner, grants);

    const session = await store.createConversation();
    expect(isGrantToken(session.conversationToken)).toBe(false);
    expect(session.conversationToken.startsWith("conv_")).toBe(true);
  });

  it("resolves a grant token for the inner store while echoing the grant to the caller", async () => {
    const inner = new FakeInnerStore();
    const grants = new FakeGrantDirectory();
    const raw = inner.createConversation();
    grants.seed(GRANT_TOKEN, { id: "g1", conversationToken: raw.conversationToken, label: "Resumed" });
    const store = new GrantResolvingStore(inner, grants);

    const session = await store.getConversation(GRANT_TOKEN);
    // Echo illusion: caller sees only their grant, never the raw PK.
    expect(session.conversationToken).toBe(GRANT_TOKEN);

    const appended = await store.appendConversationEvent(GRANT_TOKEN, {
      sequence: 1, speakerType: "user", speakerDisplayName: "User",
      authoredMessage: "q", fidelity: "model_copied_unverified",
    });
    expect(appended.conversationToken).toBe(GRANT_TOKEN);
    // But the inner store received the real token and the provenance stamp.
    expect(inner.appendedTokens).toEqual([raw.conversationToken]);
    expect(inner.appendedViaGrant).toEqual(["g1"]);

    const events = await store.readConversationEvents(GRANT_TOKEN);
    expect(events).toHaveLength(1);
    expect(events[0]!.conversationToken).toBe(GRANT_TOKEN);
  });

  it("saveConversation translates the grant back to the raw token for the inner store", async () => {
    const inner = new FakeInnerStore();
    const grants = new FakeGrantDirectory();
    const raw = inner.createConversation();
    grants.seed(GRANT_TOKEN, { id: "g1", conversationToken: raw.conversationToken, label: "Resumed" });
    const store = new GrantResolvingStore(inner, grants);

    const session = await store.getConversation(GRANT_TOKEN);
    session.lastSequence = 5;
    await store.saveConversation(session);

    // The inner store was updated under the raw token; the caller's session
    // object still carries the grant (the service keeps using it).
    expect(inner.conversations.get(raw.conversationToken)!.lastSequence).toBe(5);
    expect(session.conversationToken).toBe(GRANT_TOKEN);
    expect(inner.conversations.has(GRANT_TOKEN)).toBe(false);
  });

  it("treats a revoked or unknown grant as a dead credential, matching the raw-token miss", async () => {
    const inner = new FakeInnerStore();
    const grants = new FakeGrantDirectory(); // seeds nothing → resolve returns null
    const store = new GrantResolvingStore(inner, grants);

    await expect(store.getConversation(GRANT_TOKEN)).rejects.toThrow("Unknown or expired Suminar conversation token");
  });
});
