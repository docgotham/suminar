import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = path.resolve(import.meta.dirname, "..");
const server = path.join(root, "dist", "src", "server.js");
if (!fs.existsSync(server)) throw new Error("Run npm run build before the MCP smoke test");
const temporaryData = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sum-mcp-smoke-"));
const transport = new StdioClientTransport({
  command: "node",
  args: [server],
  env: { ...process.env, SUMINAR_DATA_DIR: temporaryData },
});
const client = new Client({ name: "suminar-contract-smoke", version: "0.10.0" });

try {
  await client.connect(transport);
  const instructions = typeof client.getInstructions === "function" ? client.getInstructions() ?? "" : "";
  if (typeof client.getInstructions === "function") {
    if (!instructions.includes("first and foremost one participant")) throw new Error("Server instructions do not lead with the participant identity");
    if (!instructions.includes("group-chat member with admin rights")) throw new Error("Server instructions lost the transport-privileges analogy");
    if (!instructions.includes("ratified_host_address")) throw new Error("Server instructions do not describe ratified host addresses");
  }
  const listed = await client.listTools();
  const expected = [
    "suminar_list_agents",
    "suminar_inspect_agent",
    "suminar_sync_conversation",
    "suminar_address_source_agents",
    "suminar_read_message",
    "suminar_preview_remote_origin",
  ];
  const names = listed.tools.map((tool) => tool.name);
  for (const name of expected) if (!names.includes(name)) throw new Error(`Missing MCP tool: ${name}`);
  if (names.some((name) => /room|panel/i.test(name))) throw new Error("A room or panel tool remains in the version-one MCP surface");
  if (names.includes("suminar_invoke_source_agents")) throw new Error("The renamed address tool still has its operator-voiced predecessor registered");

  const syncTool = listed.tools.find((tool) => tool.name === "suminar_sync_conversation");
  const addressTool = listed.tools.find((tool) => tool.name === "suminar_address_source_agents");
  if (!addressTool?.description?.includes("visible_host")
      || !addressTool.description.includes("proposed_host_address")
      || !addressTool.description.includes("ratified_host_address")
      || !addressTool.description.includes("invisible backchannel")
      || !addressTool.description.includes("exclusive source custody")
      || !addressTool.description.includes("rather than presenting or explaining")
      || !addressTool.description.includes("Perform this transport silently")) {
    throw new Error("Address tool does not advertise visible authorship modes, silent transport, source custody, and the conversational-partner contract");
  }
  if (!JSON.stringify(addressTool.inputSchema?.properties?.addressMode ?? {}).includes("proposed_host_address")) {
    throw new Error("Address schema does not offer the proposed_host_address mode");
  }
  const syncProperties = syncTool?.inputSchema?.properties ?? {};
  for (const property of ["conversationToken", "afterCursor", "completedVisibleEventsCopiedWithoutOmission"]) {
    if (!(property in syncProperties)) throw new Error(`Synchronization schema is missing ${property}`);
  }
  for (const forbidden of ["room", "hostContext", "roomTranscript", "exactUserMessageCopiedFromChat"]) {
    if (forbidden in syncProperties) throw new Error(`Legacy or hidden-context field remains in synchronization: ${forbidden}`);
  }
  const addressProperties = addressTool?.inputSchema?.properties ?? {};
  for (const property of ["addressMode", "visibleHostMessage", "visibleHostDisplayName", "afterCursor", "completedVisibleEventsCopiedWithoutOmission", "throughCursor"]) {
    if (!(property in addressProperties)) throw new Error(`Address schema is missing ${property}`);
  }

  const synchronized = await client.callTool({
    name: "suminar_sync_conversation",
    arguments: {
      afterCursor: 0,
      completedVisibleEventsCopiedWithoutOmission: [
        { speakerType: "user", authoredMessage: "First visible message" },
        { speakerType: "host", authoredMessage: "First visible host response" },
        { speakerType: "user", authoredMessage: "Second visible message" },
      ],
    },
  });
  if (synchronized.isError) throw new Error("Conversation synchronization smoke call failed");
  const continuation = synchronized.structuredContent?.conversationContinuation;
  if (!continuation?.conversationToken || continuation.cursor !== 3) throw new Error("Synchronization did not return private continuation state");
  const text = synchronized.content.find((item) => item.type === "text")?.text ?? "";
  if (!text.includes(continuation.conversationToken)) throw new Error("Model-readable MCP text omitted the continuation token");
  if (!text.includes('"cursor":3')) throw new Error("Model-readable MCP text omitted the continuation cursor");
  if (!text.includes("never reproduce in the user-facing chat")) throw new Error("Continuation state lacks its non-display instruction");

  const misuse = await client.callTool({
    name: "suminar_address_source_agents",
    arguments: {
      conversationToken: continuation.conversationToken,
      throughCursor: continuation.cursor,
      afterCursor: continuation.cursor,
      completedVisibleEventsCopiedWithoutOmission: [{ speakerType: "user", authoredMessage: "@nobody hello" }],
      targetHandles: ["@nobody"],
    },
  });
  if (!misuse.isError || misuse.structuredContent?.status !== "protocol_misuse") {
    throw new Error("Combined synchronization misuse did not return a silent protocol-misuse correction");
  }
  const misuseText = misuse.content.find((item) => item.type === "text")?.text ?? "";
  if (!misuseText.includes("retry silently") && !misuseText.includes("Correct the call")) {
    throw new Error("Protocol-misuse result does not instruct a silent corrected retry");
  }

  const agents = await client.callTool({ name: "suminar_list_agents", arguments: {} });
  const agentText = agents.content.find((item) => item.type === "text")?.text ?? "";
  for (const forbidden of ["privateArtifacts", "originalPdf", "markdown", "sourceHash", "privateKey", "conversationToken"]) {
    if (agentText.includes(forbidden)) throw new Error(`Agent listing leaked private field: ${forbidden}`);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, protocol: "agent-sum/0.1", tools: names, synchronizedCursor: continuation.cursor }, null, 2)}\n`);
} finally {
  await client.close();
  fs.rmSync(temporaryData, { recursive: true, force: true });
}
