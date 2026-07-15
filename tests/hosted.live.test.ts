import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SupabaseStore } from "../src/hosted/supabaseStore.js";

// Live multi-tenant store tests against the real Suminar Supabase project.
// Env-gated: set SUMINAR_TEST_SUPABASE_URL and
// SUMINAR_TEST_SUPABASE_SERVICE_ROLE_KEY to run. Skipped otherwise so the
// ordinary suite stays offline. RLS-as-authenticated tests (anon key + JWT)
// arrive with the trust-suite increment; these prove store-level tenant
// scoping and the append-only trigger.

const url = process.env.SUMINAR_TEST_SUPABASE_URL;
const serviceKey = process.env.SUMINAR_TEST_SUPABASE_SERVICE_ROLE_KEY;

describe.skipIf(!url || !serviceKey)("hosted SupabaseStore (live)", () => {
  // The describe body evaluates even when skipped; use a placeholder URL then.
  const client = createClient(url ?? "http://skipped.invalid", serviceKey ?? "skipped", { auth: { persistSession: false } });
  let ownerA = "";
  let ownerB = "";

  beforeAll(async () => {
    for (const email of [`suminar-test-a-${randomUUID()}@example.com`, `suminar-test-b-${randomUUID()}@example.com`]) {
      const { data, error } = await client.auth.admin.createUser({ email, email_confirm: true });
      if (error) throw new Error(error.message);
      if (!ownerA) ownerA = data.user.id;
      else ownerB = data.user.id;
    }
  });

  afterAll(async () => {
    for (const owner of [ownerA, ownerB]) {
      if (owner) await client.auth.admin.deleteUser(owner);
    }
  });

  it("keeps conversations tenant-scoped and events append-only", async () => {
    const storeA = new SupabaseStore(client, ownerA);
    const storeB = new SupabaseStore(client, ownerB);

    const conversation = await storeA.createConversation();
    await storeA.appendConversationEvent(conversation.conversationToken, {
      sequence: 1,
      speakerType: "user",
      speakerDisplayName: "User",
      authoredMessage: "Opening question",
      fidelity: "model_copied_unverified",
      captureMethod: "model_tool_argument",
    });
    conversation.lastSequence = 1;
    await storeA.saveConversation(conversation);

    const reloaded = await storeA.getConversation(conversation.conversationToken);
    expect(reloaded.lastSequence).toBe(1);
    const events = await storeA.readConversationEvents(conversation.conversationToken);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ sequence: 1, authoredMessage: "Opening question" });

    // Tenant isolation: owner B cannot see or touch owner A's conversation.
    await expect(storeB.getConversation(conversation.conversationToken))
      .rejects.toThrow(/Unknown or expired Suminar conversation token/);
    await expect(storeB.readConversationEvents(conversation.conversationToken))
      .rejects.toThrow(/Unknown or expired Suminar conversation token/);

    // Append-only: the trigger refuses updates for every role, service included.
    const update = await client
      .from("conversation_events")
      .update({ event: { tampered: true } })
      .eq("conversation_token", conversation.conversationToken)
      .eq("sequence", 1);
    expect(update.error?.message ?? "").toMatch(/append-only/);

    // Sequence uniqueness backs the no-rewrite contract at the DB layer.
    await expect(storeA.appendConversationEvent(conversation.conversationToken, {
      sequence: 1,
      speakerType: "user",
      speakerDisplayName: "User",
      authoredMessage: "Rewritten opening",
      fidelity: "model_copied_unverified",
      captureMethod: "model_tool_argument",
    })).rejects.toThrow(/duplicate|unique/i);
  });
});
