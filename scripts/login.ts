/**
 * Optional terminal login. The agent can do this for you through the
 * telegram_login_* tools; use this script if you would rather not type the
 * code and password into an agent conversation.
 *
 * Saves the session to the session file (default ~/.telegram-mcp-server/session).
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { config } from "../src/config.js";
import { saveSession } from "../src/session.js";

const rl = createInterface({ input: stdin, output: stdout });
const ask = (prompt: string) => rl.question(prompt);

const client = new TelegramClient(new StringSession(""), config.apiId, config.apiHash, {
  connectionRetries: 5,
});

await client.start({
  phoneNumber: () => ask("Phone number (with country code): "),
  password: (hint) => ask(`2FA password${hint ? ` (hint: ${hint})` : ""}: `),
  phoneCode: () => ask("Code you just received: "),
  onError: (err) => console.error(err.message),
});

const file = saveSession((client.session as StringSession).save());
console.log(`\nLogged in. Session saved to ${file}`);
console.log("The MCP server will pick it up automatically. Keep that file private: it is a full login.\n");
rl.close();
await client.disconnect();
process.exit(0);
