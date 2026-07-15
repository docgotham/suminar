import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CONVERSATION_EVENTS_META_KEY, USER_MESSAGE_META_KEY, synchronizedEventsFromRequest } from "../src/suminar/mcp.js";

const raw = "@scholar Preserve  two spaces, “curly quotes,” and\na line break.";
const hash = createHash("sha256").update(raw).digest("hex");

describe("Suminar host conversation-event attestation", () => {
  it("prefers a host-attested raw current user turn over a model copy", () => {
    const events = synchronizedEventsFromRequest([
      { speakerType: "host", authoredMessage: "Prior visible host speech" },
      { speakerType: "user", authoredMessage: "ask the scholar to preserve the wording" },
    ], {
      [USER_MESSAGE_META_KEY]: {
        schemaVersion: 1,
        text: raw,
        hostMessageId: "host-turn-42",
        contentHash: `sha256:${hash}`,
        captureMethod: "host_raw_turn",
        fidelity: "host_attested_exact",
      },
    });
    expect(events[0]).toMatchObject({ authoredMessage: "Prior visible host speech", fidelity: "model_copied_unverified" });
    expect(events[1]).toEqual({
      speakerType: "user",
      authoredMessage: raw,
      speakerDisplayName: undefined,
      hostMessageId: "host-turn-42",
      captureMethod: "host_raw_turn",
      fidelity: "host_attested_exact",
    });
  });

  it("accepts an independently attested ordered batch of user and host events", () => {
    const host = "A completed host contribution";
    const events = synchronizedEventsFromRequest([], {
      [CONVERSATION_EVENTS_META_KEY]: {
        schemaVersion: 1,
        events: [
          { speakerType: "host", authoredMessage: host, contentHash: createHash("sha256").update(host).digest("hex"), captureMethod: "host_raw_turn", fidelity: "host_attested_exact" },
          { speakerType: "user", authoredMessage: raw, contentHash: hash, captureMethod: "host_raw_turn", fidelity: "host_attested_exact" },
        ],
      },
    });
    expect(events.map((event) => event.authoredMessage)).toEqual([host, raw]);
    expect(events.every((event) => event.fidelity === "host_attested_exact")).toBe(true);
  });

  it("marks ordinary model tool arguments as unverified copies", () => {
    const events = synchronizedEventsFromRequest([{ speakerType: "user", authoredMessage: "ask the scholar" }], undefined);
    expect(events[0]).toMatchObject({ fidelity: "model_copied_unverified", captureMethod: "model_tool_argument" });
  });

  it("rejects a host attestation whose hash does not match", () => {
    expect(() => synchronizedEventsFromRequest([{ speakerType: "user", authoredMessage: "model copy" }], {
      [USER_MESSAGE_META_KEY]: {
        schemaVersion: 1,
        text: raw,
        contentHash: `sha256:${"0".repeat(64)}`,
        captureMethod: "host_raw_turn",
        fidelity: "host_attested_exact",
      },
    })).toThrow(/hash does not match/);
  });
});
