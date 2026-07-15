import path from "node:path";
import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDashboardApp } from "../src/suminar/dashboard.js";
import { IngestionService } from "../src/suminar/ingestion.js";
import { LocalStore } from "../src/core/storage.js";
import { cleanup, fixturesDir, generateFixtures, temporaryConfig } from "./helpers.js";

const config = temporaryConfig();
const store = new LocalStore(config.dataDir);
const ingestion = new IngestionService(config, store);
let server: http.Server;
let baseUrl: string;
let agentId: string;

describe("public management boundary", () => {
  beforeAll(async () => {
    generateFixtures();
    agentId = (await ingestion.ingest(path.join(fixturesDir, "clean.pdf"), { handle: "private-source" })).agentId;
    server = createDashboardApp(config).listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    cleanup(config);
  });

  it("does not expose private paths, source hashes, PDFs, or Markdown through the dashboard API", async () => {
    const response = await fetch(`${baseUrl}/api/agents`);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("privateArtifacts");
    expect(text).not.toContain("originalPdf");
    expect(text).not.toContain("sourceHash");
    expect((await fetch(`${baseUrl}/private/originals/${agentId}.pdf`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/markdown/${agentId}`)).status).toBe(404);
  });
});
