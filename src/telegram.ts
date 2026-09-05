import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { config } from "./config.js";
import { activeAccount, listAccounts, loadSession, saveSession } from "./session.js";

/**
 * A pool of connected accounts, not one client at a time.
 *
 * The single-client design forced a disconnect-and-reconnect on every account
 * switch, which is slow, loses the connection's cached entity access hashes,
 * and — worst — made "which account is this client?" a question answered by a
 * mutable global. That ambiguity is what let one account's session get written
 * over another's. Here every client is keyed by the account it belongs to and
 * can never be mistaken for a different one.
 */
interface Entry {
  client: TelegramClient;
  account: string;
  authorized: boolean;
}

const pool = new Map<string, Entry>();

export class NotLoggedInError extends Error {
  constructor(account: string) {
    super(
      `Account "${account}" has no saved session. Ask the user for their phone number and call telegram_login_start with account "${account}", then telegram_login_code with the code they receive.`,
    );
    this.name = "NotLoggedInError";
  }
}

/** Connects (or returns) the client for one account. Does not require authorization. */
export async function getClient(account = activeAccount()): Promise<TelegramClient> {
  const existing = pool.get(account);
  if (existing) return existing.client;

  const client = new TelegramClient(
    new StringSession(loadSession(account)),
    config.apiId,
    config.apiHash,
    { connectionRetries: 5 },
  );
  await client.connect();
  pool.set(account, { client, account, authorized: false });
  return client;
}

/** Every non-login tool goes through here. */
export async function getAuthorizedClient(account = activeAccount()): Promise<TelegramClient> {
  const client = await getClient(account);
  const entry = pool.get(account)!;
  if (!entry.authorized) {
    entry.authorized = await client.isUserAuthorized();
    if (!entry.authorized) throw new NotLoggedInError(account);
  }
  return client;
}

export async function isAuthorized(account = activeAccount()): Promise<boolean> {
  const client = await getClient(account);
  const entry = pool.get(account)!;
  entry.authorized = entry.authorized || (await client.isUserAuthorized());
  return entry.authorized;
}

export function markAuthorized(account = activeAccount()): void {
  const entry = pool.get(account);
  if (entry) entry.authorized = true;
}

/** Writes one account's session string to that account's file. Never another's. */
export function persistSession(account = activeAccount()): string {
  const entry = pool.get(account);
  if (!entry) throw new Error(`No live client for account "${account}".`);
  return saveSession((entry.client.session as StringSession).save(), account);
}

/** Connects every saved account at once, so no switch needs a reconnect. */
export async function connectAll(): Promise<
  { account: string; connected: boolean; authorized: boolean; error?: string }[]
> {
  const results = [];
  for (const meta of listAccounts()) {
    try {
      await getClient(meta.name);
      results.push({ account: meta.name, connected: true, authorized: await isAuthorized(meta.name) });
    } catch (err) {
      results.push({ account: meta.name, connected: false, authorized: false, error: (err as Error).message.slice(0, 120) });
    }
  }
  return results;
}

export function connectedAccounts(): { account: string; authorized: boolean }[] {
  return [...pool.values()].map((e) => ({ account: e.account, authorized: e.authorized }));
}

export async function resetClient(account = activeAccount()): Promise<void> {
  const entry = pool.get(account);
  pool.delete(account);
  await entry?.client.disconnect();
}

export async function disconnect(): Promise<void> {
  for (const entry of [...pool.values()]) {
    // Keep each file fresh: the library may have migrated data centres since login.
    if (entry.authorized && !config.sessionFromEnv) {
      try {
        persistSession(entry.account);
      } catch {
        // best effort on shutdown
      }
    }
    pool.delete(entry.account);
    await entry.client.disconnect().catch(() => {});
  }
}
