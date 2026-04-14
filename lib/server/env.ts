import fs from "node:fs";
import path from "node:path";

let localEnvLoaded = false;
let localEnvMtimeMs = 0;

function parseAndApplyLocalEnv(content: string) {
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    let value = line.slice(separatorIndex + 1);

    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function loadLocalEnvFile() {
  const localEnvPath = path.join(process.cwd(), "local.env");
  if (!fs.existsSync(localEnvPath)) {
    localEnvLoaded = true;
    return;
  }

  try {
    const stats = fs.statSync(localEnvPath);

    if (localEnvLoaded && stats.mtimeMs === localEnvMtimeMs) {
      return;
    }

    const content = fs.readFileSync(localEnvPath, "utf8");
    parseAndApplyLocalEnv(content);
    localEnvLoaded = true;
    localEnvMtimeMs = stats.mtimeMs;
  } catch {
    localEnvLoaded = true;
    localEnvMtimeMs = 0;
  }
}

export function ensureServerEnvLoaded() {
  loadLocalEnvFile();
}

export function getRequiredEnv(name: string) {
  ensureServerEnvLoaded();

  let value = process.env[name];
  if (!value) {
    // Retry once to support env file edits without server restart in development.
    localEnvLoaded = false;
    ensureServerEnvLoaded();
    value = process.env[name];
  }

  if (!value) {
    throw new Error(
      `Missing ${name} environment variable. Add it to .env.local or local.env`,
    );
  }

  return value;
}

export function getOptionalEnv(name: string) {
  ensureServerEnvLoaded();

  const value = process.env[name];
  return value && value.trim() ? value : null;
}
