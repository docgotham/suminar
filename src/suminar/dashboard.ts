import fs from "node:fs";
import path from "node:path";
import express from "express";
import multer from "multer";
import { loadConfig } from "./config.js";
import { IngestionService } from "./ingestion.js";
import { createSuminarConversationService } from "./service.js";
import { LocalStore } from "../core/storage.js";

export function createDashboardApp(config = loadConfig()) {
  const store = new LocalStore(config.dataDir);
  store.ensureLayout();
  const conversations = createSuminarConversationService(config, store);
  const ingestion = new IngestionService(config, store);
  const uploads = path.join(store.privateDir, "uploads");
  fs.mkdirSync(uploads, { recursive: true });
  const upload = multer({ dest: uploads, limits: { fileSize: 250 * 1024 * 1024, files: 1 } });
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "256kb" }));

  app.get("/api/health", (_request, response) => response.json({ ok: true, protocolVersion: "agent-sum/0.1" }));
  app.get("/api/agents", async (_request, response) => response.json((await conversations.listAgents()).map((agent) => {
    if (agent.transport !== "local") return {
      agentId: agent.agentId,
      card: agent.cardSnapshot,
      cardDigest: agent.manifestDigestAtInvitation,
      extractionStatus: "remote",
    };
    const manifest = store.getLocalAgentManifest(agent.localAgentId ?? agent.agentId);
    return {
      agentId: manifest.agentId,
      card: manifest.card,
      cardDigest: manifest.cardDigest,
      extractionStatus: manifest.extractionStatus,
      createdAt: manifest.createdAt,
      updatedAt: manifest.updatedAt,
    };
  })));
  app.get("/api/messages/:messageId", async (request, response) => {
    const record = await store.readAgentMessage(request.params.messageId);
    if (!record?.responseEnvelope) return response.status(404).json({ error: "Canonical message not found" });
    return response.json({ message: record.responseEnvelope, authoredMessage: record.body });
  });

  app.post("/api/ingest", upload.single("pdf"), async (request, response) => {
    if (!request.file) return response.status(400).json({ error: "A PDF file is required" });
    try {
      const manifest = await ingestion.ingest(request.file.path, {
        title: request.body.title || undefined,
        authors: request.body.authors || undefined,
        year: request.body.year ? Number(request.body.year) : undefined,
        citation: request.body.citation || undefined,
        edition: request.body.edition || undefined,
        doiOrIsbn: request.body.doiOrIsbn || undefined,
        handle: request.body.handle || undefined,
        displayName: request.body.displayName || undefined,
        embed: request.body.embed === "true",
      });
      response.status(201).json({
        agentId: manifest.agentId, card: manifest.card, cardDigest: manifest.cardDigest,
        extractionStatus: manifest.extractionStatus,
      });
    } catch (error) {
      response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      try { fs.unlinkSync(request.file.path); } catch { /* already removed */ }
    }
  });

  app.post("/api/agents/:agentId/ocr-mistral", async (request, response) => {
    try {
      const manifest = await ingestion.retryMistralOcr(request.params.agentId);
      response.json({ agentId: manifest.agentId, card: manifest.card, extractionStatus: manifest.extractionStatus });
    } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.patch("/api/agents/:agentId", (request, response) => {
    try {
      const manifest = ingestion.updateMetadata(request.params.agentId, {
        title: request.body.title,
        authors: Array.isArray(request.body.authors) ? request.body.authors : undefined,
        year: request.body.year === null ? null : request.body.year ? Number(request.body.year) : undefined,
        citation: request.body.citation,
        edition: request.body.edition,
        doiOrIsbn: request.body.doiOrIsbn,
        handle: request.body.handle,
        displayName: request.body.displayName,
        representativeCharter: request.body.representativeCharter,
      });
      response.json({ agentId: manifest.agentId, card: manifest.card, cardDigest: manifest.cardDigest, extractionStatus: manifest.extractionStatus });
    } catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.post("/api/remote/preview", async (request, response) => {
    try { response.json(await conversations.previewRemoteAgent(request.body.manifestUrl)); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/remote", async (request, response) => {
    try { response.status(201).json(await conversations.addRemoteAgent(request.body.manifestUrl, request.body.expectedManifestDigest)); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.delete("/api/remote/:handle", async (request, response) => {
    try { await conversations.removeRemoteAgent(request.params.handle); response.status(204).end(); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post("/api/remote/check", async (_request, response) => {
    try { response.json(await conversations.checkRemoteAgents()); }
    catch (error) { response.status(400).json({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.use(express.static(path.join(config.projectRoot, "public"), { index: "index.html", fallthrough: false }));
  return app;
}

if (["dashboard.ts", "dashboard.js"].includes(path.basename(process.argv[1] ?? ""))) {
  const config = loadConfig();
  createDashboardApp(config).listen(config.port, "127.0.0.1", () => {
    process.stdout.write(`Suminar dashboard: http://127.0.0.1:${config.port}\n`);
  });
}
