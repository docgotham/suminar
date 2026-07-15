import type { SupabaseClient } from "@supabase/supabase-js";
import { parseJsonl } from "../suminar/artifacts.js";
import type { ArtifactReader, EmbeddingRecord } from "../suminar/artifacts.js";
import type { ChunkRecord, LocalAgentManifest } from "../core/types.js";

export const ARTIFACT_BUCKET = "artifacts";

// Reads a source agent's private artifacts from Supabase Storage. Manifest
// privateArtifacts values are storage keys (set by SupabaseStore); the private
// bucket is service-role only, so a signing key never reaches a client.
export class SupabaseArtifactReader implements ArtifactReader {
  constructor(private readonly client: SupabaseClient, private readonly bucket = ARTIFACT_BUCKET) {}

  private async download(storageKey: string): Promise<string> {
    const { data, error } = await this.client.storage.from(this.bucket).download(storageKey);
    if (error || !data) throw new Error(`Artifact download failed for ${storageKey}: ${error?.message ?? "no data"}`);
    return await data.text();
  }

  async readChunks(manifest: LocalAgentManifest): Promise<ChunkRecord[]> {
    return parseJsonl<ChunkRecord>(await this.download(manifest.privateArtifacts.chunks));
  }

  async readEmbeddings(manifest: LocalAgentManifest): Promise<EmbeddingRecord[]> {
    const key = manifest.privateArtifacts.embeddings;
    if (!key) return [];
    return parseJsonl<EmbeddingRecord>(await this.download(key));
  }

  async readPrivateKey(manifest: LocalAgentManifest): Promise<string> {
    return this.download(manifest.privateArtifacts.privateKey);
  }
}
