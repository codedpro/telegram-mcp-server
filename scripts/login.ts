/**
 * One-time interactive login. Prints a session string to paste into .env.
 * That string is equivalent to being logged in as you - treat it like a password.
 */
import input from "input";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import "dotenv/config";

const apiId = Number(process.env.TELEGRAM_API_ID);
const apiHash = process.env.TELEGRAM_API_HASH;

if (!apiId || !apiHash) {
  console.error("Set TELEGRAM_API_ID and TELEGRAM_API_HASH in .env first.");
  process.exit(1);
}

const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: () => input.text("Phone number (with country code): "),
  password: () => input.text("2FA password (blank if none): "),
  phoneCode: () => input.text("Code you just received: "),
  onError: (err) => console.error(err),
});

console.log("\nLogged in. Add this line to your .env:\n");
console.log(`TELEGRAM_SESSION=${client.session.save()}\n`);
await client.disconnect();
process.exit(0);
