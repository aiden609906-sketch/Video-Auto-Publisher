import path from "node:path";
import dotenv from "dotenv";

dotenv.config();

const root = process.cwd();

function resolveFromRoot(value: string | undefined, fallback: string) {
  return path.resolve(root, value || fallback);
}

export const config = {
  root,
  port: Number(process.env.SERVER_PORT || 8787),
  inboxDir: resolveFromRoot(process.env.INBOX_DIR, "./data/inbox"),
  archiveDir: resolveFromRoot(process.env.ARCHIVE_DIR, "./data/archive"),
  coversDir: resolveFromRoot(process.env.COVERS_DIR, "./data/covers"),
  diagnosticsDir: resolveFromRoot(process.env.DIAGNOSTICS_DIR, "./data/diagnostics"),
  aiConfigFile: resolveFromRoot(process.env.AI_CONFIG_FILE, "./data/ai-config.json"),
  stateFile: resolveFromRoot(process.env.STATE_FILE, "./data/state.json"),
  browserProfilesDir: resolveFromRoot(process.env.BROWSER_PROFILES_DIR, "./data/browser-profiles"),
  aiProvider: process.env.AI_PROVIDER || "openai",
  aiBaseURL: process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
  aiApiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "",
  aiModel: process.env.AI_MODEL || process.env.OPENAI_MODEL || "gpt-5.2"
};
