import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { config } from "./config.js";

let client: TelegramClient | undefined;

/** Connects lazily so the MCP handshake is not blocked on the network. */
export async function getClient(): Promise<TelegramClient> {
  if (client) return client;

  if (!config.session) {
    throw new Error(
      "No TELEGRAM_SESSION. Run `npm run login` once, then put the printed string in .env.",
    );
  }

  client = new TelegramClient(
    new StringSession(config.session),
    config.apiId,
    config.apiHash,
    { connectionRetries: 5 },
  );

  await client.connect();
  return client;
}

export async function disconnect(): Promise<void> {
  await client?.disconnect();
  client = undefined;
}
