import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as account from "./account.js";
import * as advertisers from "./advertisers.js";
import * as accounts from "./accounts.js";
import * as auth from "./auth.js";
import * as chats from "./chats.js";
import * as contacts from "./contacts.js";
import * as media from "./media.js";
import * as messages from "./messages.js";
import * as raw from "./raw.js";
import * as scans from "./scans.js";

export function registerTools(server: McpServer): void {
  for (const group of [auth, account, accounts, advertisers, chats, messages, media, contacts, scans, raw]) {
    group.register(server);
  }
}
