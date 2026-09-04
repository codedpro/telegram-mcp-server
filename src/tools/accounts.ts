import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "teleproto";
import { formatUser } from "../format.js";
import { activeAccount, listAccounts, setActiveAccount } from "../session.js";
import { getClient, resetClient } from "../telegram.js";
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
      return {
        active,
        accounts: accounts.map((a) => ({ ...a, isActive: a.name === active })),
        note: accounts.length ? undefined : "No saved accounts. Use telegram_login_start to add one.",
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
      await resetClient();
      const me = (await (await getClient()).getMe()) as Api.User;
      return { active: chosen, user: formatUser(me) };
    },
  );
}
