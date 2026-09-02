import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "teleproto";
import { getClient } from "../telegram.js";
import { assertWritable, config } from "../config.js";

const text = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

export function registerTools(server: McpServer): void {
  server.registerTool(
    "telegram_whoami",
    {
      title: "Who am I",
      description: "Returns the Telegram account this server is signed in as.",
      inputSchema: {},
    },
    async () => {
      const me = (await (await getClient()).getMe()) as Api.User;
      return text({
        id: String(me.id),
        username: me.username,
        firstName: me.firstName,
        phone: me.phone,
        writeAllowlist: config.writeAllowlist.length
          ? config.writeAllowlist
          : "read-only",
      });
    },
  );

  server.registerTool(
    "telegram_list_chats",
    {
      title: "List chats",
      description:
        "Lists recent dialogs (chats, groups, channels) with their ids, newest first.",
      inputSchema: {
        limit: z.number().int().min(1).max(200).default(30),
      },
    },
    async ({ limit }) => {
      const dialogs = await (await getClient()).getDialogs({ limit });
      return text(
        dialogs.map((dialog) => ({
          id: String(dialog.id),
          name: dialog.name,
          kind: dialog.isChannel ? "channel" : dialog.isGroup ? "group" : "dm",
          unread: dialog.unreadCount,
        })),
      );
    },
  );

  server.registerTool(
    "telegram_get_messages",
    {
      title: "Get messages",
      description: "Reads recent messages from one chat, newest first.",
      inputSchema: {
        chat: z.string().describe("Chat id, @username, or phone number"),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ chat, limit }) => {
      const messages = await (await getClient()).getMessages(chat, { limit });
      return text(
        messages.map((message) => ({
          id: message.id,
          date: message.date,
          from: message.senderId ? String(message.senderId) : null,
          text: message.message,
        })),
      );
    },
  );

  server.registerTool(
    "telegram_search_messages",
    {
      title: "Search messages",
      description:
        "Full-text search across one chat, or across every chat when no chat is given.",
      inputSchema: {
        query: z.string().min(1),
        chat: z.string().optional(),
        limit: z.number().int().min(1).max(100).default(20),
      },
    },
    async ({ query, chat, limit }) => {
      const messages = await (await getClient()).getMessages(chat ?? undefined, {
        search: query,
        limit,
      });
      return text(
        messages.map((message) => ({
          id: message.id,
          chatId: message.chatId ? String(message.chatId) : null,
          date: message.date,
          text: message.message,
        })),
      );
    },
  );

  server.registerTool(
    "telegram_send_message",
    {
      title: "Send message",
      description:
        "Sends a message. Only works for chats listed in TELEGRAM_WRITE_ALLOWLIST.",
      inputSchema: {
        chat: z.string().describe("Chat id or @username"),
        message: z.string().min(1),
        replyTo: z.number().int().optional(),
      },
    },
    async ({ chat, message, replyTo }) => {
      assertWritable(chat);
      const sent = await (await getClient()).sendMessage(chat, {
        message,
        replyTo,
      });
      return text({ sent: true, id: sent.id, chat });
    },
  );
}
