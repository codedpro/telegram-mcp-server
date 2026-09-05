import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "teleproto";
import { formatUser } from "../format.js";
import { activeAccount, listAccounts, setActiveAccount } from "../session.js";
import { connectAll, connectedAccounts, getClient, isAuthorized } from "../telegram.js";
import { tool } from "./util.js";

export function register(server: McpServer): void {
  tool(
    server,
    "list_accounts",
    {
      title: "List saved accounts",
      description:
        "Lists every Telegram account whose session is saved on this machine, and which one is active. Sessions persist across restarts, so a saved account never needs logging in again.",
      inputSchema: {},
    },
    async () => {
      const active = activeAccount();
      const accounts = listAccounts();
      const live = new Map(connectedAccounts().map((c) => [c.account, c.authorized]));
      return {
        active,
        accounts: accounts.map((a) => ({
          ...a,
          isActive: a.name === active,
          connected: live.has(a.name),
          authorized: live.get(a.name) ?? null,
        })),
        note: accounts.length ? undefined : "No saved accounts. Use telegram_login_start to add one.",
      };
    },
  );

  tool(
    server,
    "connect_all_accounts",
    {
      title: "Connect every saved account",
      description:
        "Brings every saved account online at once and keeps them connected, so acting as a different account needs no re-login and no reconnect. Tools that accept an `account` argument can then target any of them directly.",
      inputSchema: {},
    },
    async () => {
      const results = await connectAll();
      return {
        connected: results.filter((r) => r.connected && r.authorized).map((r) => r.account),
        needsLogin: results.filter((r) => r.connected && !r.authorized).map((r) => r.account),
        failed: results.filter((r) => !r.connected),
        active: activeAccount(),
      };
    },
  );

  tool(
    server,
    "switch_account",
    {
      title: "Switch account",
      description:
        "Switches the active Telegram account to another saved one. Reconnects using that account's stored session; no login code needed.",
      inputSchema: { name: z.string().min(1).describe("Account name from telegram_list_accounts") },
    },
    async ({ name }) => {
      const chosen = setActiveAccount(name as string);
      // استخر باز می‌مانَد: تعویضِ حساب فقط اشاره‌گر را جابه‌جا می‌کند، نه اتصال را.
      const me = (await (await getClient(chosen)).getMe()) as Api.User;
      return { active: chosen, user: formatUser(me), connected: connectedAccounts() };
    },
  );
}
