import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import type { AppConfig } from "../src/suminar/config.js";

export const projectRoot = path.resolve(import.meta.dirname, "..");
export const fixturesDir = path.join(projectRoot, "tests", "fixtures", "generated");

export function generateFixtures(): void {
  execFileSync("python", [path.join(projectRoot, "tests", "fixtures", "create_fixtures.py")]);
}

export function temporaryConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-sum-test-"));
  return {
    projectRoot,
    dataDir,
    port: 0,
    python: "python",
    openAiModel: "test-model",
    allowPrivateOrigins: true,
    ...overrides,
  };
}

export function cleanup(config: AppConfig): void {
  fs.rmSync(config.dataDir, { recursive: true, force: true });
}
