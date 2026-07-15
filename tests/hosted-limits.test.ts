import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { LocalAgentInvoker } from "../src/core/conversationService.js";
import type { InvocationEnvelope, LocalAgentManifest, ResponseEnvelope } from "../src/core/types.js";
import { PILOT_LIMITS, PILOT_LIMIT_MESSAGE_PREFIX, isPilotLimitMessage } from "../src/hosted/limits.js";
import { MeteredLocalInvoker } from "../src/hosted/metering.js";

const MIGRATION = "20260714100000_pilot_limits_metering.sql";

function stubClient(insertResult: { error: { message: string } | null }, calls: unknown[] = []): SupabaseClient {
  return {
    from(table: string) {
      return {
        insert: async (row: unknown) => {
          calls.push({ table, row });
          return insertResult;
        },
      };
    },
  } as unknown as SupabaseClient;
}

function stubInner(invocations: unknown[] = []): LocalAgentInvoker {
  return {
    invoke: async (_manifest: LocalAgentManifest, envelope: InvocationEnvelope) => {
      invocations.push(envelope.invocationId);
      return { authoredMessage: "answered" } as unknown as ResponseEnvelope;
    },
  };
}

const manifest = {} as LocalAgentManifest;
const envelope = { targetAgentId: "agent_deadbeef", invocationId: "inv_1" } as InvocationEnvelope;

describe("pilot limits", () => {
  it("keeps the TypeScript limits and the database migration in agreement", async () => {
    // pilot_limits() evolves by create-or-replace across migrations; the
    // agreement that matters is with its LATEST definition.
    const dir = path.join(process.cwd(), "supabase", "migrations");
    const files = (await fs.readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
    let latest = "";
    for (const name of files) {
      const sql = await fs.readFile(path.join(dir, name), "utf8");
      if (/create or replace function public\.pilot_limits/.test(sql)) latest = sql;
    }
    expect(latest, "some migration must define pilot_limits()").not.toBe("");
    for (const [key, value] of Object.entries(PILOT_LIMITS)) {
      expect(latest, `pilot_limits() must carry ${key} = ${value}`).toMatch(
        new RegExp(`'${key}',\\s*${value}\\b`),
      );
    }
    // Enforcement is uniform: triggers, not handler-local checks.
    const metering = await fs.readFile(path.join(dir, MIGRATION), "utf8");
    expect(metering).toMatch(/before insert on public\.invocation_usage/);
    expect(metering).toMatch(/before insert on public\.documents/);
  });

  it("classifies pilot-limit messages by their fixed prefix", () => {
    expect(isPilotLimitMessage(`${PILOT_LIMIT_MESSAGE_PREFIX} the invite beta allows 200`)).toBe(true);
    expect(isPilotLimitMessage("duplicate key value violates unique constraint")).toBe(false);
    expect(isPilotLimitMessage(undefined)).toBe(false);
  });
});

describe("MeteredLocalInvoker", () => {
  it("reserves a usage row, then invokes", async () => {
    const calls: Array<{ table: string; row: { owner: string; agent_id: string; invocation_id: string } }> = [];
    const invocations: unknown[] = [];
    const invoker = new MeteredLocalInvoker(stubInner(invocations), stubClient({ error: null }, calls), "owner-a");
    const response = await invoker.invoke(manifest, envelope);
    expect(response.authoredMessage).toBe("answered");
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("invocation_usage");
    expect(calls[0].row).toMatchObject({ owner: "owner-a", agent_id: "agent_deadbeef", invocation_id: "inv_1" });
    expect(invocations).toEqual(["inv_1"]);
  });

  it("relays a pilot-limit rejection verbatim and never invokes", async () => {
    const invocations: unknown[] = [];
    const message = `${PILOT_LIMIT_MESSAGE_PREFIX} the invite beta allows 200 source-agent invocations per account per day`;
    const invoker = new MeteredLocalInvoker(stubInner(invocations), stubClient({ error: { message } }), "owner-a");
    await expect(invoker.invoke(manifest, envelope)).rejects.toThrow(message);
    expect(invocations).toHaveLength(0);
  });

  it("fails closed when the meter is unreachable", async () => {
    const invocations: unknown[] = [];
    const invoker = new MeteredLocalInvoker(stubInner(invocations), stubClient({ error: { message: "connection reset" } }), "owner-a");
    await expect(invoker.invoke(manifest, envelope)).rejects.toThrow(/could not meter this invocation, so it was not run/);
    expect(invocations).toHaveLength(0);
  });
});
