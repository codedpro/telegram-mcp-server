import "dotenv/config";
import { homedir } from "node:os";
import { join } from "node:path";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in (see README).`,
    );
  }
  return value;
}

const dataDir = () =>
  process.env.TELEGRAM_DATA_DIR ?? join(homedir(), ".telegram-mcp-server");

/**
 * Read lazily, never at import time: an agent must be able to complete the MCP
 * handshake and list tools on a fresh clone, and only hit the missing-credential
 * error when it actually calls one.
 */
export const config = {
  get apiId(): number {
    const id = Number(required("TELEGRAM_API_ID"));
    if (!Number.isInteger(id) || id <= 0) {
      throw new Error("TELEGRAM_API_ID must be a positive integer.");
    }
    return id;
  },
  get apiHash(): string {
    return required("TELEGRAM_API_HASH");
  },
  /** Session string from the environment. Takes precedence over the file. */
  get sessionFromEnv(): string | undefined {
    return process.env.TELEGRAM_SESSION || undefined;
  },
  get sessionFile(): string {
    return process.env.TELEGRAM_SESSION_FILE ?? join(dataDir(), "session");
  },
  get downloadDir(): string {
    return process.env.TELEGRAM_DOWNLOAD_DIR ?? join(dataDir(), "downloads");
  },
  /**
   * Optional restriction on which chats the agent may write to. Unset means
   * unrestricted: once you have logged the agent in, it can act as you.
   */
  get writeAllowlist(): string[] | undefined {
    const raw = process.env.TELEGRAM_WRITE_ALLOWLIST;
    if (raw === undefined || raw.trim() === "") return undefined;
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  },
};

export function assertWritable(chat: string): void {
  const allowlist = config.writeAllowlist;
  if (!allowlist) return;
  if (allowlist.includes("*")) return;
  if (allowlist.includes(chat)) return;
  throw new Error(
    `Sending to "${chat}" is blocked by TELEGRAM_WRITE_ALLOWLIST. Add it there, or unset the variable for full access.`,
  );
}
