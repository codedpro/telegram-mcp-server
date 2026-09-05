import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "teleproto";
import { formatChat, formatEntity, formatMessage, formatUser, isoDate, toPlain } from "../format.js";
import { gate } from "../throttle.js";
import { getAuthorizedClient } from "../telegram.js";
import { peer, requireConfirm, tool } from "./util.js";

const chatArg = z.string().describe("Chat id (e.g. -1001234567890), @username, phone number, or 'me'");

export function register(server: McpServer): void {
  tool(
    server,
    "list_chats",
    {
      title: "List chats",
      description:
        "Lists dialogs (private chats, groups, supergroups, channels, bots) newest first, with ids, unread counts, and the last message. Filter by kind or unread.",
      inputSchema: {
        limit: z.number().int().min(1).max(500).default(50),
        kind: z.enum(["all", "dm", "group", "channel", "bot"]).default("all"),
        unreadOnly: z.boolean().default(false),
        archived: z.boolean().default(false).describe("List the archive folder instead of the main list"),
      },
    },
    async ({ limit, kind, unreadOnly, archived }) => {
      const client = await getAuthorizedClient();
      const dialogs = await client.getDialogs({ limit: limit as number, archived: archived as boolean });
      return dialogs
        .filter((d) => {
          if (unreadOnly && !d.unreadCount) return false;
          const entity = d.entity;
          const isBot = entity instanceof Api.User && entity.bot;
          switch (kind) {
            case "dm":
              return d.isUser && !isBot;
            case "bot":
              return Boolean(isBot);
            case "group":
              return d.isGroup;
            case "channel":
              return d.isChannel && !d.isGroup;
            default:
              return true;
          }
        })
        .map((d) => {
          const entity = d.entity;
          const isBot = entity instanceof Api.User && entity.bot;
          return {
            id: String(d.id),
            name: d.name ?? d.title,
            kind: isBot ? "bot" : d.isUser ? "dm" : d.isGroup ? "group" : "channel",
            username: (entity as { username?: string } | undefined)?.username,
            unread: d.unreadCount,
            unreadMentions: d.unreadMentionsCount,
            pinned: d.pinned ?? false,
            lastMessage: d.message
              ? { id: d.message.id, date: isoDate(d.message.date), from: d.message.senderId ? String(d.message.senderId) : undefined, text: d.message.message?.slice(0, 200) }
              : undefined,
          };
        });
    },
  );

  tool(
    server,
    "get_chat",
    {
      title: "Get chat info",
      description: "Full information about a user, group, or channel: title, username, bio/about, member count, admin status, linked chat.",
      inputSchema: { chat: chatArg },
    },
    async ({ chat }) => {
      const client = await getAuthorizedClient();
      const entity = await client.getEntity(peer(chat as string));
      const base = formatEntity(entity) as Record<string, unknown>;
      try {
        if (entity instanceof Api.Channel) {
          const full = await client.invoke(new Api.channels.GetFullChannel({ channel: entity }));
          const info = full.fullChat as Api.ChannelFull;
          return {
            ...base,
            about: info.about,
            participantsCount: info.participantsCount,
            adminsCount: info.adminsCount,
            onlineCount: info.onlineCount,
            linkedChatId: info.linkedChatId ? `-100${info.linkedChatId}` : undefined,
            slowmodeSeconds: info.slowmodeSeconds,
            pinnedMessageId: info.pinnedMsgId,
            inviteLink: info.exportedInvite instanceof Api.ChatInviteExported ? info.exportedInvite.link : undefined,
          };
        }
        if (entity instanceof Api.Chat) {
          const full = await client.invoke(new Api.messages.GetFullChat({ chatId: entity.id }));
          const info = full.fullChat as Api.ChatFull;
          return { ...base, about: info.about, pinnedMessageId: info.pinnedMsgId };
        }
        if (entity instanceof Api.User) {
          const full = await client.invoke(new Api.users.GetFullUser({ id: entity }));
          return {
            ...base,
            about: full.fullUser.about,
            commonChatsCount: full.fullUser.commonChatsCount,
            blocked: full.fullUser.blocked ?? false,
            birthday: full.fullUser.birthday ? toPlain(full.fullUser.birthday) : undefined,
          };
        }
      } catch (err) {
        return { ...base, fullInfoError: (err as Error).message };
      }
      return base;
    },
  );

  tool(
    server,
    "resolve_peer",
    {
      title: "Resolve peer",
      description:
        "Resolves a chat reference into its canonical id and an InputPeer object (with access hash) usable in nested telegram_raw_request parameters.",
      inputSchema: { chat: chatArg },
    },
    async ({ chat }) => {
      const client = await getAuthorizedClient();
      const input = await client.getInputEntity(peer(chat as string));
      return { id: String(await client.getPeerId(input)), inputPeer: toPlain(input) };
    },
  );

  tool(
    server,
    "get_members",
    {
      title: "Get members",
      description: "Lists members of a group or channel (channels require admin rights). Optional name search.",
      inputSchema: {
        chat: chatArg,
        limit: z.number().int().min(1).max(1000).default(100),
        search: z.string().optional(),
        filter: z.enum(["all", "admins", "bots", "banned", "kicked", "recent"]).default("all"),
      },
    },
    async ({ chat, limit, search, filter }) => {
      const client = await getAuthorizedClient();
      const filters: Record<string, Api.TypeChannelParticipantsFilter | undefined> = {
        all: undefined,
        admins: new Api.ChannelParticipantsAdmins(),
        bots: new Api.ChannelParticipantsBots(),
        banned: new Api.ChannelParticipantsBanned({ q: (search as string) ?? "" }),
        kicked: new Api.ChannelParticipantsKicked({ q: (search as string) ?? "" }),
        recent: new Api.ChannelParticipantsRecent(),
      };
      const members = await client.getParticipants(peer(chat as string), {
        limit: limit as number,
        search: search as string | undefined,
        filter: filters[filter as string],
      });
      return {
        total: members.total,
        members: members.map((user) => {
          const p = (user as { participant?: unknown }).participant;
          const role =
            p instanceof Api.ChannelParticipantCreator || p instanceof Api.ChatParticipantCreator
              ? "creator"
              : p instanceof Api.ChannelParticipantAdmin || p instanceof Api.ChatParticipantAdmin
                ? "admin"
                : p instanceof Api.ChannelParticipantBanned
                  ? "banned"
                  : "member";
          return { ...formatUser(user), role };
        }),
      };
    },
  );

  tool(
    server,
    "search_chats",
    {
      title: "Search chats",
      description: "Searches your contacts and public Telegram usernames, groups, and channels by name.",
      inputSchema: { query: z.string().min(1), limit: z.number().int().min(1).max(100).default(20) },
    },
    async ({ query, limit }) => {
      const client = await getAuthorizedClient();
      const result = await client.invoke(new Api.contacts.Search({ q: query as string, limit: limit as number }));
      return {
        users: result.users.map((u) => formatEntity(u)),
        chats: result.chats.map((c) => formatEntity(c)),
      };
    },
  );

  tool(
    server,
    "join_chat",
    {
      title: "Join chat",
      description: "Joins a public group or channel by @username, or a private one by invite link (https://t.me/+... or t.me/joinchat/...).",
      inputSchema: { target: z.string().min(1).describe("@username or invite link") },
    },
    async ({ target }) => {
      const client = await getAuthorizedClient();
      const paced = await gate("join_chat");
      const value = (target as string).trim();
      const invite = value.match(/(?:t\.me\/(?:joinchat\/|\+)|^\+)([\w-]+)/);
      const result = invite
        ? await client.importChatInvite(invite[1])
        : await client.joinChannel(value.replace(/^https?:\/\/t\.me\//, "").replace(/^@/, ""));
      const chats = ((result as unknown as { chats?: Api.TypeChat[] }).chats ?? []).map((c) => formatEntity(c));
      return { joined: true, waitedMs: paced.waitedMs, chats };
    },
  );

  tool(
    server,
    "leave_chat",
    {
      title: "Leave chat",
      description: "Leaves a group or channel. Requires confirm: true.",
      inputSchema: { chat: chatArg, confirm: z.boolean().optional() },
      destructive: true,
    },
    async ({ chat, confirm }) => {
      requireConfirm(confirm as boolean | undefined, `Leaving ${chat}`);
      const client = await getAuthorizedClient();
      const entity = await client.getEntity(peer(chat as string));
      if (entity instanceof Api.Chat) {
        await client.invoke(new Api.messages.DeleteChatUser({ chatId: entity.id, userId: "me" }));
      } else {
        await client.leaveChannel(entity);
      }
      return { left: true, chat: formatEntity(entity) };
    },
  );

  tool(
    server,
    "create_group",
    {
      title: "Create group",
      description: "Creates a new basic group with the given members.",
      inputSchema: {
        title: z.string().min(1),
        members: z.array(chatArg).min(1).describe("Users to add (ids, @usernames, or phone numbers)"),
      },
    },
    async ({ title, members }) => {
      const client = await getAuthorizedClient();
      const result = await client.createChat({ title: title as string, users: (members as string[]).map(peer) });
      return { chat: formatEntity(result.chat), missingInvitees: toPlain(result.missingInvitees) };
    },
  );

  tool(
    server,
    "create_channel",
    {
      title: "Create channel or supergroup",
      description: "Creates a channel (broadcast) or a supergroup (megagroup).",
      inputSchema: {
        title: z.string().min(1),
        about: z.string().default(""),
        supergroup: z.boolean().default(false).describe("true for a supergroup, false for a broadcast channel"),
      },
    },
    async ({ title, about, supergroup }) => {
      const client = await getAuthorizedClient();
      const channel = await client.createChannel({
        title: title as string,
        about: about as string,
        megagroup: supergroup as boolean,
      });
      return formatChat(channel);
    },
  );

  tool(
    server,
    "mark_read",
    {
      title: "Mark as read",
      description: "Marks a chat as read, optionally only up to a message id.",
      inputSchema: { chat: chatArg, maxId: z.number().int().optional() },
    },
    async ({ chat, maxId }) => {
      const client = await getAuthorizedClient();
      const ok = await client.markAsRead(peer(chat as string), maxId as number | undefined, { clearMentions: true });
      return { marked: ok };
    },
  );

  tool(
    server,
    "pin_message",
    {
      title: "Pin or unpin message",
      description: "Pins a message in a chat, or unpins it. Omit messageId with unpin: true to unpin everything.",
      inputSchema: {
        chat: chatArg,
        messageId: z.number().int().optional(),
        unpin: z.boolean().default(false),
        silent: z.boolean().default(false).describe("Pin without notifying members"),
      },
    },
    async ({ chat, messageId, unpin, silent }) => {
      const client = await getAuthorizedClient();
      const target = peer(chat as string);
      if (unpin) {
        if (messageId !== undefined) await client.unpinMessage(target, messageId as number);
        else await client.unpinMessage(target);
        return { unpinned: messageId ?? "all" };
      }
      if (messageId === undefined) throw new Error("messageId is required to pin.");
      const pinned = await client.pinMessage(target, messageId as number, { notify: !(silent as boolean) });
      return { pinned: pinned instanceof Api.Message ? formatMessage(pinned) : messageId };
    },
  );

  tool(
    server,
    "delete_history",
    {
      title: "Delete chat history",
      description: "Deletes the whole history of a private chat or group for you (and for the other side when revoke is true). Requires confirm: true.",
      inputSchema: {
        chat: chatArg,
        revoke: z.boolean().default(false).describe("Also delete for the other participant(s)"),
        confirm: z.boolean().optional(),
      },
      destructive: true,
    },
    async ({ chat, revoke, confirm }) => {
      requireConfirm(confirm as boolean | undefined, `Deleting the history of ${chat}`);
      const client = await getAuthorizedClient();
      const result = await client.deleteHistory(peer(chat as string), { revoke: revoke as boolean });
      return { deleted: true, result: toPlain(result) };
    },
  );
}
