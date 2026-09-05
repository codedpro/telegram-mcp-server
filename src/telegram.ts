import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { config } from "./config.js";
import { activeAccount, loadSession, saveSession, sessionSource } from "./session.js";

let client: TelegramClient | undefined;
/**
 * Which saved account the live client actually belongs to.
 *
 * Without this, persistSession() wrote the client's session string into
 * whatever account happened to be active at that moment. Switch accounts and
 * then shut down, and the outgoing session lands in the incoming account's
 * file — which is exactly how one account's session overwrote another's here,
 * destroying the original. The client's identity is a property of the client,
 * never of the active-account pointer.
 */
let clientAccount: string | undefined;
let authorized = false;

export class NotLoggedInError extends Error {
  constructor() {
    super(
      "Not logged in to Telegram. Ask the user for their phone number and call telegram_login_start, then telegram_login_code with the code they receive (and telegram_login_password if they use 2FA).",
    );
    this.name = "NotLoggedInError";
  }
}

/** Connects lazily and never requires authorization. Login tools use this. */
export async function getClient(): Promise<TelegramClient> {
  if (client) return client;
  const created = new TelegramClient(
    new StringSession(loadSession()),
    config.apiId,
    config.apiHash,
    { connectionRetries: 5 },
  );
  await created.connect();
  client = created;
  clientAccount = activeAccount();
  return created;
}

/** Every non-login tool goes through here. */
export async function getAuthorizedClient(): Promise<TelegramClient> {
  const current = await getClient();
  if (!authorized) {
    authorized = await current.isUserAuthorized();
    if (!authorized) throw new NotLoggedInError();
  }
  return current;
}

export async function isAuthorized(): Promise<boolean> {
  if (authorized) return true;
  const current = await getClient();
  authorized = await current.isUserAuthorized();
  return authorized;
}

export function markAuthorized(): void {
  authorized = true;
}

/** Writes the current session string to the session file. */
export function persistSession(account?: string): string {
  if (!client) throw new Error("No client to persist.");
  const target = account ?? clientAccount;
  if (!target) throw new Error("No account is associated with the live client; refusing to guess where to save it.");
  return saveSession((client.session as StringSession).save(), target);
}

export async function resetClient(): Promise<void> {
  const current = client;
  client = undefined;
  clientAccount = undefined;
  authorized = false;
  await current?.disconnect();
}

export async function disconnect(): Promise<void> {
  // Keep the file fresh: the library may have migrated data centers since login.
  // فقط به حسابِ خودِ همین کلاینت بنویس، نه به حسابِ فعالِ فعلی.
  if (client && clientAccount && authorized && sessionSource() === "file") {
    try {
      persistSession(clientAccount);
    } catch {
      // best effort on shutdown
    }
  }
  await resetClient();
}
