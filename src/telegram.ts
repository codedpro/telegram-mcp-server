import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { config } from "./config.js";
import { loadSession, saveSession, sessionSource } from "./session.js";

let client: TelegramClient | undefined;
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
  return saveSession((client.session as StringSession).save(), account);
}

export async function resetClient(): Promise<void> {
  const current = client;
  client = undefined;
  authorized = false;
  await current?.disconnect();
}

export async function disconnect(): Promise<void> {
  // Keep the file fresh: the library may have migrated data centers since login.
  if (client && authorized && sessionSource() === "file") {
    try {
      persistSession();
    } catch {
      // best effort on shutdown
    }
  }
  await resetClient();
}
