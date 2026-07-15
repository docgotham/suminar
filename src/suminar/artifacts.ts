import fs from "node:fs";
import type { ChunkRecord, LocalAgentManifest } from "../core/types.js";

export interface EmbeddingRecord { chunkId: string; model: string; embedding: number[]; }

// How the product layer reads a source agent's private artifacts. Manifest
// privateArtifacts values are reader-scoped keys: filesystem paths for the
// open-kernel LocalArtifactReader, storage keys for the hosted reader.
export interface ArtifactReader {
  readChunks(manifest: LocalAgentManifest): Promise<ChunkRecord[]>;
  readEmbeddings(manifest: LocalAgentManifest): Promise<EmbeddingRecord[]>;
  readPrivateKey(manifest: LocalAgentManifest): Promise<string>;
}

export function parseJsonl<T>(text: string): T[] {
  return text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as T);
}

export function readJsonlFile<T>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  return parseJsonl<T>(fs.readFileSync(file, "utf8"));
}

export class LocalArtifactReader implements ArtifactReader {
  async readChunks(manifest: LocalAgentManifest): Promise<ChunkRecord[]> {
    return readJsonlFile<ChunkRecord>(manifest.privateArtifacts.chunks);
  }

  async readEmbeddings(manifest: LocalAgentManifest): Promise<EmbeddingRecord[]> {
    const file = manifest.privateArtifacts.embeddings;
    return file ? readJsonlFile<EmbeddingRecord>(file) : [];
  }

  async readPrivateKey(manifest: LocalAgentManifest): Promise<string> {
    return fs.readFileSync(manifest.privateArtifacts.privateKey, "utf8");
  }
}
