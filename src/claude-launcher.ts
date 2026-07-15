import { execFileSync } from "node:child_process";

function userEnvironmentVariable(name: string): string | undefined {
  if (process.platform !== "win32") return undefined;
  try {
    const output = execFileSync(
      "reg.exe",
      ["query", "HKCU\\Environment", "/v", name],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] },
    );
    const line = output.split(/\r?\n/).find((candidate) => candidate.trimStart().startsWith(name));
    const match = line?.match(/^\s*\S+\s+REG_\S+\s+(.+?)\s*$/);
    return match?.[1];
  } catch {
    return undefined;
  }
}

// Store-packaged desktop apps can retain an environment block that predates a
// user-level key. Read the current user environment without copying the secret
// into Claude's MCP config. Never print the value: stdout belongs to MCP stdio.
if (!process.env.OPENAI_API_KEY) {
  const apiKey = userEnvironmentVariable("OPENAI_API_KEY");
  if (apiKey) process.env.OPENAI_API_KEY = apiKey;
}

await import("./server.js");
