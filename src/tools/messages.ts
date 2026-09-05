import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "teleproto";
import { assertWritable } from "../config.js";
import { gate } from "../throttle.js";
import { formatMessage } from "../format.js";
import { getAuthorizedClient } from "../telegram.js";
import { peer, requireConfirm, tool } from "./util.js";

const chatArg = z.string().describe("Chat id, @username, phone number, or 'me'");
const parseModeArg = z.enum(["none", "markdown", "html"]).default("none");

const filters: Record<string, () => Api.TypeMessagesFilter> = {
  photos: () => new Api.InputMessagesFilterPhotos(),
  videos: () => new Api.InputMessagesFilterVideo(),
  documents: () => new Api.InputMessagesFilterDocument(),
  links: () => new Api.InputMessagesFilterUrl(),
  voice: () => new Api.InputMessagesFilterVoice(),
  music: () => new Api.InputMessagesFilterMusic(),
  gifs: () => new Api.InputMessagesFilterGif(),
  pinned: () => new Api.InputMessagesFilterPinned(),
};

const toParseMode = (mode: unknown) => (mode === "markdown" ? "md" : mode === "html" ? "html" : undefined);

export function register(server: McpServer): void {
  tool(
    server,
    "get_messages",
    {
      title: "Get messages",
      description:
        "Reads messages from a chat, newest first. Page with offsetId (messages older than that id). Filter by media type or sender.",
      inputSchema: {
        chat: chatArg,
        limit: z.number().int().min(1).max(200).default(30),
        offsetId: z.number().int().optional().describe("Return messages older than this id"),
        minId: z.number().int().optional().describe("Only messages newer than this id"),
        fromUser: z.string().optional().describe("Only messages from this user"),
        filter: z.enum(["all", "photos", "videos", "documents", "links", "voice", "music", "gifs", "pinned"]).default("all"),
      },
    },
    async ({ chat, limit, offsetId, minId, fromUser, filter }) => {
      const client = await getAuthorizedClient();
      const messages = await client.getMessages(peer(chat as string), {
        limit: limit as number,
        offsetId: (offsetId as number | undefined) ?? 0,
        minId: (minId as number | undefined) ?? 0,
        fromUser: fromUser ? peer(fromUser as string) : undefined,
        filter: filter !== "all" ? filters[filter as string]() : undefined,
      });
      return messages.map((m) => formatMessage(m));
    },
  );

  tool(
    server,
    "get_message",
    {
      title: "Get messages by id",
      description: "Fetches specific messages by id from a chat.",
      inputSchema: { chat: chatArg, ids: z.array(z.number().int()).min(1).max(100) },
    },
    async ({ chat, ids }) => {
      const client = await getAuthorizedClient();
      const messages = await client.getMessages(peer(chat as string), { ids: ids as number[] });
      return messages.map((m) => formatMessage(m));
    },
  );

  tool(
    server,
    "get_message_by_link",
    {
      title: "Get message by link",
      description: "Fetches a message from a t.me link such as https://t.me/channel/123 or https://t.me/c/1234567890/123.",
      inputSchema: { link: z.string().url() },
    },
    async ({ link }) => {
      const client = await getAuthorizedClient();
      return formatMessage(await client.getMessageByLink(link as string));
    },
  );

  tool(
    server,
    "get_replies",
    {
      title: "Get replies / comments",
      description: "Reads the reply thread (comments) under a message in a group or channel.",
      inputSchema: { chat: chatArg, messageId: z.number().int(), limit: z.number().int().min(1).max(200).default(50) },
    },
    async ({ chat, messageId, limit }) => {
      const client = await getAuthorizedClient();
      const messages = await client.getMessages(peer(chat as string), {
        replyTo: messageId as number,
        limit: limit as number,
      });
      return messages.map((m) => formatMessage(m));
    },
  );

  tool(
    server,
    "search_messages",
    {
      title: "Search messages",
      description: "Full-text search in one chat, or across every chat when chat is omitted.",
      inputSchema: {
        query: z.string().min(1),
        chat: chatArg.optional(),
        limit: z.number().int().min(1).max(200).default(30),
        fromUser: z.string().optional(),
      },
    },
    async ({ query, chat, limit, fromUser }) => {
      const client = await getAuthorizedClient();
      const messages = await client.getMessages(chat ? peer(chat as string) : undefined, {
        search: query as string,
        limit: limit as number,
        fromUser: fromUser ? peer(fromUser as string) : undefined,
      });
      return messages.map((m) => formatMessage(m));
    },
  );

  tool(
    server,
    "send_message",
    {
      title: "Send message",
      description: "Sends a text message. Supports replies, markdown or HTML formatting, silent delivery, and scheduling.",
      inputSchema: {
        chat: chatArg,
        message: z.string().min(1),
        replyTo: z.number().int().optional().describe("Message id to reply to"),
        parseMode: parseModeArg,
        silent: z.boolean().default(false),
        linkPreview: z.boolean().default(true),
        scheduleAt: z.string().datetime().optional().describe("ISO 8601 time to schedule the message for"),
      },
    },
    async ({ chat, message, replyTo, parseMode, silent, linkPreview, scheduleAt }) => {
      assertWritable(chat as string);
      const client = await getAuthorizedClient();
      const paced = await gate("send_message");
      const sent = await client.sendMessage(peer(chat as string), {
        message: message as string,
        replyTo: replyTo as number | undefined,
        parseMode: toParseMode(parseMode),
        silent: silent as boolean,
        linkPreview: linkPreview as boolean,
        schedule: scheduleAt ? Math.floor(new Date(scheduleAt as string).getTime() / 1000) : undefined,
      });
      return { sent: true, waitedMs: paced.waitedMs, message: formatMessage(sent) };
    },
  );

  tool(
    server,
    "edit_message",
    {
      title: "Edit message",
      description: "Edits the text of a message you sent.",
      inputSchema: { chat: chatArg, messageId: z.number().int(), text: z.string().min(1), parseMode: parseModeArg },
    },
    async ({ chat, messageId, text, parseMode }) => {
      assertWritable(chat as string);
      const client = await getAuthorizedClient();
      const edited = await client.editMessage(peer(chat as string), {
        message: messageId as number,
        text: text as string,
        parseMode: toParseMode(parseMode),
      });
      return { edited: true, message: formatMessage(edited) };
    },
  );

  tool(
    server,
    "delete_messages",
    {
      title: "Delete messages",
      description: "Deletes messages. revoke deletes for everyone (default) instead of only for you. Requires confirm: true.",
      inputSchema: {
        chat: chatArg,
        messageIds: z.array(z.number().int()).min(1).max(100),
        revoke: z.boolean().default(true),
        confirm: z.boolean().optional(),
      },
      destructive: true,
    },
    async ({ chat, messageIds, revoke, confirm }) => {
      requireConfirm(confirm as boolean | undefined, `Deleting ${(messageIds as number[]).length} message(s)`);
      assertWritable(chat as string);
      const client = await getAuthorizedClient();
      const result = await client.deleteMessages(peer(chat as string), messageIds as number[], { revoke: revoke as boolean });
      return { deleted: result.reduce((sum, r) => sum + r.ptsCount, 0), requested: (messageIds as number[]).length };
    },
  );

  tool(
    server,
    "forward_messages",
    {
      title: "Forward messages",
      description: "Forwards messages from one chat to another.",
      inputSchema: {
        fromChat: chatArg,
        messageIds: z.array(z.number().int()).min(1).max(100),
        toChat: chatArg,
        silent: z.boolean().default(false),
        dropAuthor: z.boolean().default(false).describe("Hide the original sender"),
      },
    },
    async ({ fromChat, messageIds, toChat, silent, dropAuthor }) => {
      assertWritable(toChat as string);
      const client = await getAuthorizedClient();
      await gate("forward_messages");
      const forwarded = await client.forwardMessages(peer(toChat as string), {
        messages: messageIds as number[],
        fromPeer: peer(fromChat as string),
        silent: silent as boolean,
        dropAuthor: dropAuthor as boolean,
      });
      return { forwarded: forwarded.map((m) => formatMessage(m)) };
    },
  );

  tool(
    server,
    "react",
    {
      title: "React to message",
      description: "Adds an emoji reaction to a message, or removes your reaction when emoji is omitted.",
      inputSchema: { chat: chatArg, messageId: z.number().int(), emoji: z.string().optional().describe("e.g. 👍") },
    },
    async ({ chat, messageId, emoji }) => {
      assertWritable(chat as string);
      const client = await getAuthorizedClient();
      await client.sendReaction(
        peer(chat as string),
        messageId as number,
        emoji ? [new Api.ReactionEmoji({ emoticon: emoji as string })] : [],
      );
      return { reacted: emoji ?? null, messageId };
    },
  );
}
