import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { handleHostedMcpRequest } from "../src/hosted/mcp.js";

// Regression net for a demonstrated production failure (2026-07-14): the
// hosted endpoint serves one stateless request per function invocation and
// closes the server in a finally. In SSE mode handleRequest resolves before
// the JSON-RPC reply reaches the stream, so the close starved the body and
// conformant clients timed out on an empty 200. JSON response mode resolves
// with the complete reply, making close-after-return safe. This test drives
// the actual SDK transport through the hosted shape so an SDK upgrade that
// changes these semantics fails here, not in production.

async function respondThroughHostedShape(enableJsonResponse: boolean): Promise<string> {
  const server = new McpServer({ name: "shape-test", version: "0.0.0" });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse });
  await server.connect(transport);
  const request = new Request("http://local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "shape-test", version: "0.0.0" } },
    }),
  });
  let response: Response;
  try {
    response = await transport.handleRequest(request);
  } finally {
    await server.close();
  }
  return Promise.race([
    response.text(),
    new Promise<string>((resolve) => setTimeout(() => resolve("<<starved>>"), 3000)),
  ]);
}

describe("hosted MCP transport shape", () => {
  it("JSON response mode delivers the complete reply despite close-after-return", async () => {
    const body = await respondThroughHostedShape(true);
    expect(body).toContain('"protocolVersion"');
    expect(body).toContain('"serverInfo"');
  }, 15_000);

  it("documents why SSE mode is unsafe for the stateless hosted shape", async () => {
    const body = await respondThroughHostedShape(false);
    // If a future SDK makes SSE mode deliver the reply through this shape,
    // this expectation flags that the comment in src/hosted/mcp.ts is stale.
    expect(body === "" || body === "<<starved>>").toBe(true);
  }, 15_000);

  it("the hosted endpoint pins JSON response mode", async () => {
    const source = await fs.readFile(path.join(process.cwd(), "src", "hosted", "mcp.ts"), "utf8");
    expect(source).toMatch(/enableJsonResponse: true/);
  });
});

describe("hosted MCP method handling", () => {
  // Regression net for the 2026-07-14 production failure: the pre-auth rate
  // limiter answered mcp-remote's GET SSE-stream probe with 429, which the
  // client treated as retryable and reconnect-stormed until Claude Desktop
  // reported the connection as dead. A stateless POST-only endpoint must 405
  // the probe — and ahead of auth/config/rate-limit, so an empty env still
  // yields 405 rather than 500/401/429.
  it("answers the GET SSE-stream probe with 405, never a retryable status", async () => {
    const response = await handleHostedMcpRequest(
      new Request("http://local/mcp", { method: "GET", headers: { authorization: "Bearer anything" } }),
      {} as NodeJS.ProcessEnv,
    );
    expect(response.status).toBe(405);
    expect(response.status).not.toBe(429);
    expect(response.headers.get("allow")).toContain("POST");
  });

  it("answers DELETE with 405 without requiring auth or configuration", async () => {
    const response = await handleHostedMcpRequest(
      new Request("http://local/mcp", { method: "DELETE" }),
      {} as NodeJS.ProcessEnv,
    );
    expect(response.status).toBe(405);
  });
});
