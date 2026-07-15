import path from "node:path";

export interface AppConfig {
  projectRoot: string;
  dataDir: string;
  port: number;
  python: string;
  openAiModel: string;
  allowPrivateOrigins: boolean;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const projectRoot = overrides.projectRoot ?? process.cwd();
  return {
    projectRoot,
    dataDir: overrides.dataDir ?? path.resolve(projectRoot, process.env.SUMINAR_DATA_DIR || "data"),
    port: overrides.port ?? Number(process.env.SUMINAR_PORT || 4317),
    python: overrides.python ?? (process.env.SUMINAR_PYTHON || "python"),
    openAiModel: overrides.openAiModel ?? (process.env.SUMINAR_OPENAI_MODEL || "gpt-5-mini"),
    allowPrivateOrigins: overrides.allowPrivateOrigins ?? process.env.SUMINAR_ALLOW_PRIVATE_ORIGINS === "1",
  };
}
