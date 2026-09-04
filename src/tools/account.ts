import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "teleproto";
import { config } from "../config.js";
import { formatUser, isoDate } from "../format.js";
import { getAuthorizedClient } from "../telegram.js";
import { tool } from "./util.js";

export function register(server: McpServer): void {
  tool(
    server,
    "whoami",
    {
      title: "Who am I",
      description: "Returns the Telegram account this server is signed in as and whether writes are restricted.",
      inputSchema: {},
    },
    async () => {
      const me = (await (await getAuthorizedClient()).getMe()) as Api.User;
      return { ...formatUser(me), writeAllowlist: config.writeAllowlist ?? "unrestricted" };
    },
  );

  tool(
    server,
    "list_sessions",
    {
      title: "List active sessions",
      description: "Lists devices and apps currently logged in to this Telegram account, including this server.",
      inputSchema: {},
    },
    async () => {
      const result = await (await getAuthorizedClient()).getAuthorizations();
      return result.authorizations.map((a) => ({
        hash: String(a.hash),
        current: a.current ?? false,
        app: `${a.appName} ${a.appVersion}`,
        device: `${a.deviceModel} (${a.platform} ${a.systemVersion})`,
        ip: a.ip,
        country: a.country,
        created: isoDate(a.dateCreated),
        lastActive: isoDate(a.dateActive),
      }));
    },
  );

  tool(
    server,
    "update_profile",
    {
      title: "Update profile",
      description: "Changes the account's first name, last name, bio, or public username. Only the given fields change.",
      inputSchema: {
        firstName: z.string().optional(),
        lastName: z.string().optional(),
        about: z.string().max(70).optional().describe("Bio text"),
        username: z.string().optional().describe("Public @username without the @"),
      },
    },
    async ({ firstName, lastName, about, username }) => {
      const client = await getAuthorizedClient();
      const changed: string[] = [];
      if (firstName !== undefined || lastName !== undefined || about !== undefined) {
        await client.updateProfile({
          firstName: firstName as string | undefined,
          lastName: lastName as string | undefined,
          about: about as string | undefined,
        });
        changed.push("profile");
      }
      if (username !== undefined) {
        await client.updateUsername(String(username).replace(/^@/, ""));
        changed.push("username");
      }
      const me = (await client.getMe()) as Api.User;
      return { changed, user: formatUser(me) };
    },
  );
}
