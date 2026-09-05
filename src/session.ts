import {
  chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { config } from "./config.js";

export type SessionSource = "env" | "file" | "none";

export interface AccountMeta {
  name: string;
  id?: string;
  username?: string;
  firstName?: string;
  phone?: string;
  savedAt?: string;
}

const DEFAULT = "default";
const dir = () => join(dirname(config.sessionFile), "sessions");
const sessionPath = (name: string) => join(dir(), `${safe(name)}.session`);
const metaPath = (name: string) => join(dir(), `${safe(name)}.json`);
const activePath = () => join(dir(), "active");

export function safe(name: string): string {
  const trimmed = name.trim();
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(trimmed)) {
    throw new Error(`Invalid account name "${name}". Use letters, digits, dot, dash, or underscore.`);
  }
  return trimmed;
}

function ensureDir(): string {
  const d = dir();
  mkdirSync(d, { recursive: true, mode: 0o700 });
  return d;
}

/**
 * Older versions saved one unnamed session file. Move it into the named store
 * the first time we look, so an existing login keeps working.
 */
function migrateLegacy(): void {
  const legacy = config.sessionFile;
  if (!existsSync(legacy) || existsSync(sessionPath(DEFAULT))) return;
  ensureDir();
  renameSync(legacy, sessionPath(DEFAULT));
  writeFileSync(activePath(), DEFAULT + "\n", { mode: 0o600 });
}

export function listAccounts(): AccountMeta[] {
  migrateLegacy();
  if (!existsSync(dir())) return [];
  return readdirSync(dir())
    .filter((f) => f.endsWith(".session"))
    .map((f) => {
      const name = f.replace(/\.session$/, "");
      let meta: Partial<AccountMeta> = {};
      try {
        meta = JSON.parse(readFileSync(metaPath(name), "utf8")) as Partial<AccountMeta>;
      } catch {
        // metadata is optional
      }
      return { ...meta, name };
    });
}

export function activeAccount(): string {
  migrateLegacy();
  const fromEnv = process.env.TELEGRAM_ACCOUNT;
  if (fromEnv) return safe(fromEnv);
  try {
    const value = readFileSync(activePath(), "utf8").trim();
    if (value) return value;
  } catch {
    // fall through
  }
  const accounts = listAccounts();
  return accounts.length === 1 ? accounts[0].name : DEFAULT;
}

export function setActiveAccount(name: string): string {
  const clean = safe(name);
  if (!existsSync(sessionPath(clean))) {
    const known = listAccounts().map((a) => a.name);
    throw new Error(
      `No saved account "${clean}".${known.length ? ` Saved accounts: ${known.join(", ")}.` : " Log in first with telegram_login_start."}`,
    );
  }
  ensureDir();
  writeFileSync(activePath(), clean + "\n", { mode: 0o600 });
  return clean;
}

export function sessionSource(): SessionSource {
  if (config.sessionFromEnv) return "env";
  migrateLegacy();
  return existsSync(sessionPath(activeAccount())) ? "file" : "none";
}

/** Env var first, then the active account's saved session. */
export function loadSession(name = activeAccount()): string {
  const fromEnv = config.sessionFromEnv;
  if (fromEnv) return fromEnv;
  migrateLegacy();
  try {
    return readFileSync(sessionPath(name), "utf8").trim();
  } catch {
    return "";
  }
}

/**
 * Owner-only file: the session string is a full login to the account.
 *
 * Keeps one backup of the previous, different value. A session file is the only
 * copy of a login — overwrite it with the wrong account's string and that login
 * is gone, which has already happened once here. The backup makes that
 * recoverable instead of terminal.
 */
export function saveSession(value: string, name = activeAccount()): string {
  const clean = safe(name);
  ensureDir();
  const file = sessionPath(clean);
  try {
    const previous = readFileSync(file, "utf8").trim();
    if (previous && previous !== value.trim()) {
      writeFileSync(`${file}.bak`, previous + "\n", { mode: 0o600 });
    }
  } catch {
    // هنوز فایلی نیست — چیزی برای پشتیبان‌گیری وجود ندارد.
  }
  writeFileSync(file, value + "\n", { mode: 0o600 });
  chmodSync(file, 0o600);
  if (!existsSync(activePath())) writeFileSync(activePath(), clean + "\n", { mode: 0o600 });
  return file;
}

/** Makes an account active. Login does this explicitly; saving no longer does. */
export function markActive(name: string): void {
  const clean = safe(name);
  ensureDir();
  writeFileSync(activePath(), clean + "\n", { mode: 0o600 });
}

export function saveAccountMeta(meta: AccountMeta): void {
  const clean = safe(meta.name);
  ensureDir();
  writeFileSync(metaPath(clean), JSON.stringify({ ...meta, name: clean, savedAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
}

export function clearSession(name = activeAccount()): void {
  const clean = safe(name);
  rmSync(sessionPath(clean), { force: true });
  rmSync(metaPath(clean), { force: true });
  const remaining = listAccounts();
  if (remaining.length) writeFileSync(activePath(), remaining[0].name + "\n", { mode: 0o600 });
  else rmSync(activePath(), { force: true });
}
