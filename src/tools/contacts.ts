import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatEntity, formatUser } from "../format.js";
import { getAuthorizedClient } from "../telegram.js";
import { peer, requireConfirm, tool } from "./util.js";

const userArg = z.string().describe("User id, @username, or phone number");

export function register(server: McpServer): void {
  tool(
    server,
    "list_contacts",
    {
      title: "List contacts",
      description: "Lists the account's saved contacts.",
      inputSchema: {},
    },
    async () => (await (await getAuthorizedClient()).getContacts()).map(formatUser),
  );

  tool(
    server,
    "add_contact",
    {
      title: "Add contact",
      description: "Saves a user as a contact. Use a phone number to add someone you have no chat with.",
      inputSchema: {
        user: userArg,
        firstName: z.string().min(1),
        lastName: z.string().default(""),
        sharePhone: z.boolean().default(false).describe("Share your phone number with them"),
      },
    },
    async ({ user, firstName, lastName, sharePhone }) => {
      const client = await getAuthorizedClient();
      await client.addContact(peer(user as string), {
        firstName: firstName as string,
        lastName: lastName as string,
        addPhonePrivacyException: sharePhone as boolean,
      });
      return { added: true, user: formatEntity(await client.getEntity(peer(user as string))) };
    },
  );

  tool(
    server,
    "block_user",
    {
      title: "Block user",
      description: "Blocks a user. Requires confirm: true.",
      inputSchema: { user: userArg, confirm: z.boolean().optional() },
      destructive: true,
    },
    async ({ user, confirm }) => {
      requireConfirm(confirm as boolean | undefined, `Blocking ${user}`);
      const client = await getAuthorizedClient();
      await client.block(peer(user as string));
      return { blocked: true, user };
    },
  );

  tool(
    server,
    "unblock_user",
    {
      title: "Unblock user",
      description: "Unblocks a previously blocked user.",
      inputSchema: { user: userArg },
    },
    async ({ user }) => {
      const client = await getAuthorizedClient();
      await client.unblock(peer(user as string));
      return { unblocked: true, user };
    },
  );

  tool(
    server,
    "get_common_chats",
    {
      title: "Common chats",
      description: "Lists groups and channels you share with a user.",
      inputSchema: { user: userArg, limit: z.number().int().min(1).max(100).default(50) },
    },
    async ({ user, limit }) => {
      const client = await getAuthorizedClient();
      const chats = await client.getCommonChats(peer(user as string), { limit: limit as number });
      return chats.map((c) => formatEntity(c));
    },
  );
}
