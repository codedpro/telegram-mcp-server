import bigInt from "big-integer";
import { Api } from "teleproto";

const INTERNAL_KEYS = new Set(["CONSTRUCTOR_ID", "SUBCLASS_OF_ID", "classType", "originalArgs"]);

/** Converts any TL object into plain JSON: big ints to strings, buffers to base64. */
export function toPlain(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > 24) return "[depth limit]";
  if (typeof value === "bigint") return value.toString();
  if (bigInt.isInstance(value)) return value.toString();
  if (Buffer.isBuffer(value)) return { base64: value.toString("base64") };
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => toPlain(item, depth + 1));
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    if (typeof source.className === "string") out._ = source.className;
    for (const [key, item] of Object.entries(source)) {
      if (INTERNAL_KEYS.has(key) || key === "className" || key.startsWith("_")) continue;
      if (typeof item === "function" || item === undefined) continue;
      out[key] = toPlain(item, depth + 1);
    }
    return out;
  }
  return value;
}

export const isoDate = (unixSeconds?: number | null) =>
  unixSeconds ? new Date(unixSeconds * 1000).toISOString() : null;

const str = (value: unknown) => (value === undefined || value === null ? undefined : String(value));

export function formatUser(user: Api.User) {
  return {
    id: String(user.id),
    kind: user.bot ? "bot" : "user",
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    phone: user.phone,
    isContact: user.contact ?? false,
    isSelf: user.self ?? false,
    verified: user.verified ?? false,
    premium: user.premium ?? false,
    deleted: user.deleted ?? false,
  };
}

export function formatChat(chat: Api.Chat | Api.Channel | Api.ChatForbidden | Api.ChannelForbidden) {
  if (chat instanceof Api.Channel) {
    return {
      id: `-100${chat.id}`,
      kind: chat.megagroup ? "supergroup" : chat.broadcast ? "channel" : "channel",
      title: chat.title,
      username: chat.username,
      participantsCount: chat.participantsCount,
      isForum: chat.forum ?? false,
      verified: chat.verified ?? false,
      creator: chat.creator ?? false,
      admin: Boolean(chat.adminRights),
      left: chat.left ?? false,
    };
  }
  if (chat instanceof Api.Chat) {
    return {
      id: `-${chat.id}`,
      kind: "group",
      title: chat.title,
      participantsCount: chat.participantsCount,
      creator: chat.creator ?? false,
      admin: Boolean(chat.adminRights),
      left: chat.left ?? false,
      migratedTo: chat.migratedTo ? toPlain(chat.migratedTo) : undefined,
    };
  }
  return { id: String(chat.id), kind: "forbidden", title: chat.title };
}

export function formatEntity(entity: unknown) {
  if (entity instanceof Api.User) return formatUser(entity);
  if (
    entity instanceof Api.Chat ||
    entity instanceof Api.Channel ||
    entity instanceof Api.ChatForbidden ||
    entity instanceof Api.ChannelForbidden
  ) {
    return formatChat(entity);
  }
  return toPlain(entity);
}

export function summarizeMedia(media: Api.TypeMessageMedia | undefined) {
  if (!media) return undefined;
  if (media instanceof Api.MessageMediaPhoto) {
    return { type: "photo", spoiler: media.spoiler ?? false, ttlSeconds: media.ttlSeconds };
  }
  if (media instanceof Api.MessageMediaDocument) {
    const doc = media.document instanceof Api.Document ? media.document : undefined;
    let type = "document";
    let fileName: string | undefined;
    let duration: number | undefined;
    for (const attr of doc?.attributes ?? []) {
      if (attr instanceof Api.DocumentAttributeFilename) fileName = attr.fileName;
      if (attr instanceof Api.DocumentAttributeVideo) {
        type = attr.roundMessage ? "video_note" : "video";
        duration = attr.duration;
      }
      if (attr instanceof Api.DocumentAttributeAudio) {
        type = attr.voice ? "voice" : "audio";
        duration = attr.duration;
      }
      if (attr instanceof Api.DocumentAttributeSticker) type = "sticker";
      if (attr instanceof Api.DocumentAttributeAnimated) type = "gif";
    }
    return {
      type,
      fileName,
      mimeType: doc?.mimeType,
      size: doc ? Number(doc.size) : undefined,
      duration,
      spoiler: media.spoiler ?? false,
    };
  }
  if (media instanceof Api.MessageMediaWebPage) {
    const page = media.webpage instanceof Api.WebPage ? media.webpage : undefined;
    return { type: "webpage", url: page?.url, title: page?.title, description: page?.description };
  }
  if (media instanceof Api.MessageMediaPoll) {
    return {
      type: "poll",
      question: media.poll.question.text,
      answers: media.poll.answers.map((a) => a.text.text),
      closed: media.poll.closed ?? false,
    };
  }
  if (media instanceof Api.MessageMediaContact) {
    return { type: "contact", phone: media.phoneNumber, firstName: media.firstName, lastName: media.lastName };
  }
  if (media instanceof Api.MessageMediaGeo) {
    const geo = media.geo instanceof Api.GeoPoint ? media.geo : undefined;
    return { type: "location", lat: geo?.lat, long: geo?.long };
  }
  return { type: media.className.replace(/^MessageMedia/, "").toLowerCase() };
}

export function formatMessage(message: Api.Message | Api.MessageService | undefined | null) {
  if (!message) return null;
  if (message instanceof Api.MessageService) {
    return {
      id: message.id,
      chatId: str((message as unknown as { chatId?: unknown }).chatId),
      date: isoDate(message.date),
      service: true,
      action: toPlain(message.action),
    };
  }
  const reply = message.replyTo instanceof Api.MessageReplyHeader ? message.replyTo : undefined;
  const reactions = message.reactions?.results.map((r) => ({
    emoji: r.reaction instanceof Api.ReactionEmoji ? r.reaction.emoticon : toPlain(r.reaction),
    count: r.count,
    mine: r.chosenOrder !== undefined,
  }));
  return {
    id: message.id,
    chatId: str(message.chatId),
    date: isoDate(message.date),
    from: str(message.senderId),
    out: message.out ?? false,
    text: message.message,
    media: summarizeMedia(message.media),
    replyToId: reply?.replyToMsgId,
    replyToTopId: reply?.replyToTopId,
    forwardedFrom: message.fwdFrom
      ? { from: str(message.fwdFrom.fromId ? toPlain(message.fwdFrom.fromId) : undefined), name: message.fwdFrom.fromName, date: isoDate(message.fwdFrom.date) }
      : undefined,
    editDate: isoDate(message.editDate),
    views: message.views,
    forwards: message.forwards,
    replies: message.replies?.replies,
    pinned: message.pinned ?? false,
    reactions: reactions?.length ? reactions : undefined,
    grouped: str(message.groupedId),
  };
}
