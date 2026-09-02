import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill it in (see README).`,
    );
  }
  return value;
}

/**
 * Read lazily, never at import time: an agent must be able to complete the MCP
 * handshake and list tools on a fresh clone, and only hit the missing-credential
 * error when it actually calls one.
 */
export const config = {
  get apiId(): number {
    return Number(required("TELEGRAM_API_ID"));
  },
  get apiHash(): string {
    return required("TELEGRAM_API_HASH");
  },
  get session(): string {
    return process.env.TELEGRAM_SESSION ?? "";
  },
  /**
   * Chats the agent may send to. Empty means read-only, which is the default
   * on purpose: an agent that can post as you is a much bigger blast radius
   * than one that can only read.
   */
  get writeAllowlist(): string[] {
    return (process.env.TELEGRAM_WRITE_ALLOWLIST ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
  },
};

export function assertWritable(chat: string): void {
  const allowlist = config.writeAllowlist;
  if (allowlist.includes("*")) return;
  if (allowlist.includes(chat)) return;
  throw new Error(
    `Sending to "${chat}" is not allowed. Add it to TELEGRAM_WRITE_ALLOWLIST to enable writes.`,
  );
}
