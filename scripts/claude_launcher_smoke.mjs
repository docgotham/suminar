import path from "node:path";
import { createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const environment = {
  ...process.env,
  SUMINAR_DATA_DIR: path.join(root, "data"),
  SUMINAR_OPENAI_MODEL: "gpt-5-mini",
};
delete environment.OPENAI_API_KEY;
const transport = new StdioClientTransport({
  command: "node",
  args: [path.join(root, "dist", "src", "claude-launcher.js")],
  env: environment,
});
const client = new Client({ name: "suminar-claude-launcher-smoke", version: "0.10.0" });

try {
  await client.connect(transport);
  const rawUserTurn = "@loury-foreword Explain the Foreword's strongest argument for race-conscious admissions.";
  const priorHost = "We are comparing different arguments about affirmative action.";
  const events = [
    { speakerType: "host", authoredMessage: priorHost },
    { speakerType: "user", authoredMessage: rawUserTurn },
  ];
  const attested = events.map((event, index) => ({
    ...event,
    hostMessageId: `launcher-smoke-${index + 1}`,
    contentHash: `sha256:${createHash("sha256").update(event.authoredMessage).digest("hex")}`,
    captureMethod: "host_raw_turn",
    fidelity: "host_attested_exact",
  }));
  const synchronized = await client.callTool({
    name: "suminar_sync_conversation",
    arguments: {
      afterCursor: 0,
      completedVisibleEventsCopiedWithoutOmission: [
        { speakerType: "host", authoredMessage: "model-copied prior host" },
        { speakerType: "user", authoredMessage: "model-copied current user" },
      ],
    },
    _meta: { "agent-sum/conversation-events-v1": { schemaVersion: 1, events: attested } },
  }, undefined, { timeout: 30_000 });
  if (synchronized.isError) throw new Error("Claude launcher failed to synchronize attested visible events");
  const continuation = synchronized.structuredContent?.conversationContinuation;
  if (!continuation?.conversationToken || continuation.cursor !== 2) throw new Error("Claude launcher did not return continuation state");

  const result = await client.callTool({
    name: "suminar_address_source_agents",
    arguments: {
      conversationToken: continuation.conversationToken,
      throughCursor: continuation.cursor,
      targetHandles: ["@loury-foreword"],
      maxDirectQuoteWords: 0,
    },
  }, undefined, { timeout: 180_000 });
  if (result.isError) {
    const detail = result.content.find((item) => item.type === "text")?.text ?? "unknown MCP error";
    throw new Error(`Source-agent invocation returned an MCP error: ${detail}`);
  }
  const structured = result.structuredContent;
  const messages = structured?.messages ?? [];
  if (messages.length !== 1 || messages[0]?.handle !== "loury-foreword") throw new Error("Invocation did not return exactly the requested source agent");
  if (messages[0].authoredMessage.includes("extractive fallback")) throw new Error("Claude launcher did not provide OPENAI_API_KEY to the source agent");
  if (!structured?.displayContract?.mustDisplayCanonicalBlocksVerbatim) throw new Error("Canonical display contract is missing");
  const hostConduct = structured?.displayContract?.hostConduct ?? [];
  if (!hostConduct.some((rule) => /one participant in this shared conversation/i.test(rule))) {
    throw new Error("Host participant-identity rule is missing from the display contract");
  }
  if (!hostConduct.some((rule) => /end your visible message immediately after the final canonical turn/i.test(rule))) {
    throw new Error("Host hard-stop rule is missing from the display contract");
  }
  if (!hostConduct.some((rule) => /never offer to relay, push, probe, or re-query/i.test(rule))) {
    throw new Error("Host no-service-menu rule is missing from the display contract");
  }
  if (!hostConduct.some((rule) => /exclusive custody/i.test(rule))) {
    throw new Error("Exclusive source-custody rule is missing from the display contract");
  }
  if (structured?.deliverySummary?.[0]?.fromSequence !== 1 || structured?.deliverySummary?.[0]?.deliveredEventCount !== 2) {
    throw new Error("Newly invoked source agent did not receive the complete synchronized host conversation");
  }
  const text = result.content.find((item) => item.type === "text")?.text ?? "";
  if (!text.includes(messages[0].displayText)) throw new Error("Canonical display text is missing from MCP content");
  const continuationMarker = "PRIVATE CONTINUATION STATE (machine-use only; never reproduce in the user-facing chat):";
  const markerOffset = text.indexOf(continuationMarker);
  if (markerOffset < 0) throw new Error("Model-readable continuation marker is missing");
  if (!text.slice(markerOffset).includes(continuation.conversationToken)) throw new Error("Machine-use continuation state omitted the conversation token");
  if (text.slice(0, markerOffset).includes(continuation.conversationToken)) throw new Error("Private conversation token leaked outside the machine-use continuation section");
  if (messages[0].displayText.includes(continuation.conversationToken)) throw new Error("Private conversation token leaked into canonical display text");
  const finalRuleOffset = text.indexOf("FINAL TURN RULE:");
  if (finalRuleOffset < 0 || finalRuleOffset < markerOffset) {
    throw new Error("The final turn rule must close the tool result after the continuation state");
  }

  const delegatedUserRequest = "Use Suminar. Ask @loury-foreword what the Foreword considers the strongest practical argument for race-conscious admissions.";
  const visibleHostQuestion = "@loury-foreword What does the Foreword consider the strongest practical argument for race-conscious admissions?";
  const hostAddressSync = await client.callTool({
    name: "suminar_sync_conversation",
    arguments: {
      afterCursor: 0,
      completedVisibleEventsCopiedWithoutOmission: [
        { speakerType: "user", authoredMessage: delegatedUserRequest },
      ],
    },
  }, undefined, { timeout: 30_000 });
  const hostAddressContinuation = hostAddressSync.structuredContent?.conversationContinuation;
  if (!hostAddressContinuation?.conversationToken) throw new Error("Visible-host-address test did not create conversation state");
  const hostAddressResult = await client.callTool({
    name: "suminar_address_source_agents",
    arguments: {
      conversationToken: hostAddressContinuation.conversationToken,
      throughCursor: hostAddressContinuation.cursor,
      targetHandles: ["@loury-foreword"],
      addressMode: "visible_host",
      visibleHostMessage: visibleHostQuestion,
      visibleHostDisplayName: "Claude",
      maxDirectQuoteWords: 0,
    },
  }, undefined, { timeout: 180_000 });
  if (hostAddressResult.isError) {
    const detail = hostAddressResult.content.find((item) => item.type === "text")?.text ?? "unknown MCP error";
    throw new Error(`Visible host address returned an MCP error: ${detail}`);
  }
  const hostStructured = hostAddressResult.structuredContent;
  if (hostStructured?.visibleHostAddress?.speakerDisplayName !== "Claude") throw new Error("Visible host address lost host authorship");
  if (hostStructured?.visibleHostAddress?.authoredMessage !== visibleHostQuestion) throw new Error("Visible host address wording changed");
  if (!hostStructured?.displayContract?.mustDisplayVisibleHostAddressVerbatim) throw new Error("Visible host display requirement is missing");
  const orderedTurns = hostStructured?.displayContract?.orderedVisibleTurns ?? [];
  if (orderedTurns[0]?.speakerType !== "host" || orderedTurns[0]?.displayText !== visibleHostQuestion) {
    throw new Error("Visible host address is not the first canonical visible turn");
  }
  if (orderedTurns[1]?.speakerType !== "source_agent") throw new Error("Source-agent block does not follow the visible host address");
  const hostText = hostAddressResult.content.find((item) => item.type === "text")?.text ?? "";
  const hostQuestionOffset = hostText.indexOf(visibleHostQuestion);
  const sourceBlockOffset = hostText.indexOf(orderedTurns[1].displayText);
  if (hostQuestionOffset < 0 || sourceBlockOffset <= hostQuestionOffset) throw new Error("MCP text does not preserve visible host then source-agent turn order");
  if (hostStructured?.deliverySummary?.[0]?.fromSequence !== 1
      || hostStructured?.deliverySummary?.[0]?.throughSequence !== 2
      || hostStructured?.deliverySummary?.[0]?.deliveredEventCount !== 2) {
    throw new Error("Visible host address was not delivered with the original user request");
  }

  const hostFollowUpProposal = "@loury-foreword How does that practical argument differ from the diversity rationale the Court relied on?";
  const proposalRegistration = await client.callTool({
    name: "suminar_address_source_agents",
    arguments: {
      conversationToken: hostStructured.conversationContinuation.conversationToken,
      afterCursor: hostStructured.conversationContinuation.cursor,
      completedVisibleEventsCopiedWithoutOmission: [
        { speakerType: "user", authoredMessage: "Interesting. Can you ask it how that differs from the Court's diversity rationale?" },
      ],
      targetHandles: ["@loury-foreword"],
      addressMode: "proposed_host_address",
      visibleHostMessage: hostFollowUpProposal,
      visibleHostDisplayName: "Claude",
    },
  }, undefined, { timeout: 30_000 });
  if (proposalRegistration.isError) {
    const detail = proposalRegistration.content.find((item) => item.type === "text")?.text ?? "unknown MCP error";
    throw new Error(`Proposal registration returned an MCP error: ${detail}`);
  }
  const registered = proposalRegistration.structuredContent;
  if (registered?.proposedHostAddress?.authoredMessage !== hostFollowUpProposal) {
    throw new Error("Proposal registration did not record the exact host proposal");
  }
  if ((registered?.messages ?? []).length) throw new Error("Proposal registration must not deliver a source-agent response");
  const registrationText = proposalRegistration.content.find((item) => item.type === "text")?.text ?? "";
  if (!registrationText.includes("PROPOSAL RECORDED CONTRACT")) throw new Error("Proposal registration is missing its display contract");

  const ratifiedResult = await client.callTool({
    name: "suminar_address_source_agents",
    arguments: {
      conversationToken: registered.conversationContinuation.conversationToken,
      afterCursor: registered.conversationContinuation.cursor,
      completedVisibleEventsCopiedWithoutOmission: [
        { speakerType: "user", authoredMessage: "Yes, go ahead." },
      ],
      targetHandles: ["@loury-foreword"],
      addressMode: "ratified_host_address",
      maxDirectQuoteWords: 0,
    },
  }, undefined, { timeout: 180_000 });
  if (ratifiedResult.isError) {
    const detail = ratifiedResult.content.find((item) => item.type === "text")?.text ?? "unknown MCP error";
    throw new Error(`Ratified host address returned an MCP error: ${detail}`);
  }
  const ratifiedStructured = ratifiedResult.structuredContent;
  if (ratifiedStructured?.ratifiedHostAddress?.authoredMessage !== hostFollowUpProposal
      || ratifiedStructured?.ratifiedHostAddress?.alreadyVisible !== true) {
    throw new Error("Ratified delivery did not preserve the already-visible host proposal exactly");
  }
  if (ratifiedStructured?.visibleHostAddress) throw new Error("Ratified delivery must not mint a second visible host address");
  if ((ratifiedStructured?.messages ?? []).length !== 1) throw new Error("Ratified delivery did not return one canonical source-agent message");
  const ratifiedText = ratifiedResult.content.find((item) => item.type === "text")?.text ?? "";
  if (!ratifiedText.includes("RATIFIED ADDRESS CONTRACT")) throw new Error("Ratified delivery is missing its display contract");
  if (!ratifiedText.includes("do not display it again")) throw new Error("Ratified delivery does not forbid re-displaying the proposal");
  if (ratifiedStructured?.deliverySummary?.[0]?.deliveredEventCount !== 3) {
    throw new Error("Ratified delivery did not carry the follow-up request, registered proposal, and assent events to the source agent");
  }

  const insufficientSync = await client.callTool({
    name: "suminar_sync_conversation",
    arguments: {
      afterCursor: 0,
      completedVisibleEventsCopiedWithoutOmission: [
        { speakerType: "user", authoredMessage: "Yes, please put it to the source agent directly." },
      ],
    },
  }, undefined, { timeout: 30_000 });
  const insufficientContinuation = insufficientSync.structuredContent?.conversationContinuation;
  const insufficientResult = await client.callTool({
    name: "suminar_address_source_agents",
    arguments: {
      conversationToken: insufficientContinuation.conversationToken,
      throughCursor: insufficientContinuation.cursor,
      targetHandles: ["@loury-foreword"],
      addressMode: "visible_host",
      visibleHostMessage: visibleHostQuestion,
      visibleHostDisplayName: "Claude",
    },
  }, undefined, { timeout: 30_000 });
  if (!insufficientResult.isError || insufficientResult.structuredContent?.status !== "direct_address_required") {
    throw new Error("An underspecified user request created a visible host address");
  }
  const insufficientText = insufficientResult.content.find((item) => item.type === "text")?.text ?? "";
  if (!insufficientText.includes("Never send an invisible restatement")) throw new Error("No-backchannel guidance is missing");

  // Live probe of the representative-driven occurrence lane and the first-use
  // combined call: no conversation token, sync and address in one request.
  const occurrenceProbe = await client.callTool({
    name: "suminar_address_source_agents",
    arguments: {
      afterCursor: 0,
      completedVisibleEventsCopiedWithoutOmission: [
        { speakerType: "user", authoredMessage: "@loury-foreword Does the Foreword mention Derek Bok anywhere?" },
      ],
      targetHandles: ["@loury-foreword"],
      maxDirectQuoteWords: 0,
    },
  }, undefined, { timeout: 180_000 });
  if (occurrenceProbe.isError) {
    const detail = occurrenceProbe.content.find((item) => item.type === "text")?.text ?? "unknown MCP error";
    throw new Error(`Occurrence probe returned an MCP error: ${detail}`);
  }
  const occurrenceMessages = occurrenceProbe.structuredContent?.messages ?? [];
  if (occurrenceMessages.length !== 1 || !/bok/i.test(occurrenceMessages[0]?.authoredMessage ?? "")) {
    throw new Error("Occurrence probe did not return a canonical answer about the queried name");
  }
  if (!occurrenceProbe.structuredContent?.conversationContinuation?.conversationToken) {
    throw new Error("First-use combined call did not mint conversation state");
  }

  // Live probe of the discourse-shaped question class that previously refused:
  // the representative should retrieve the passages it needs itself.
  const discourseProbe = await client.callTool({
    name: "suminar_address_source_agents",
    arguments: {
      afterCursor: 0,
      completedVisibleEventsCopiedWithoutOmission: [
        { speakerType: "user", authoredMessage: "@loury-foreword How would the Foreword answer an empirical critic who says its evidence base is unrepresentative?" },
      ],
      targetHandles: ["@loury-foreword"],
    },
  }, undefined, { timeout: 180_000 });
  if (discourseProbe.isError) {
    const detail = discourseProbe.content.find((item) => item.type === "text")?.text ?? "unknown MCP error";
    throw new Error(`Discourse probe returned an MCP error: ${detail}`);
  }
  if ((discourseProbe.structuredContent?.messages ?? []).length !== 1) {
    throw new Error("Discourse probe did not return a canonical answer");
  }

  process.stdout.write(`${JSON.stringify({ ok: true, selectedHandle: messages[0].handle, authoredMessageChars: messages[0].authoredMessage.length, directDeliveredEvents: 2, visibleHostDeliveredEvents: 2, proposalRegistered: true, ratifiedDeliveredEvents: 3, occurrenceProbeAnswered: true }, null, 2)}\n`);
} finally {
  await client.close();
}
