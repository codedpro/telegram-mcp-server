import { mkdirSync, statSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "teleproto";
import { assertWritable, config } from "../config.js";
import { formatMessage, summarizeMedia } from "../format.js";
import { getAuthorizedClient } from "../telegram.js";
import { peer, tool } from "./util.js";

const chatArg = z.string().describe("Chat id, @username, phone number, or 'me'");

const extensionFor = (mime?: string) =>
  ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "video/mp4": ".mp4", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "application/pdf": ".pdf" })[mime ?? ""] ?? "";

export function register(server: McpServer): void {
  tool(
    server,
    "download_media",
    {
      title: "Download media",
      description:
        "Downloads the photo, video, document, voice note, or sticker attached to a message and saves it to disk. Returns the local file path.",
      inputSchema: {
        chat: chatArg,
        messageId: z.number().int(),
        outputDir: z.string().optional().describe("Directory to save into (default: TELEGRAM_DOWNLOAD_DIR or ~/.telegram-mcp-server/downloads)"),
        fileName: z.string().optional().describe("Override the saved file name"),
      },
    },
    async ({ chat, messageId, outputDir, fileName }) => {
      const client = await getAuthorizedClient();
      const [message] = await client.getMessages(peer(chat as string), { ids: messageId as number });
      if (!message?.media) throw new Error(`Message ${messageId} has no downloadable media.`);
      const summary = summarizeMedia(message.media) as { type: string; fileName?: string; mimeType?: string } | undefined;
      const dir = resolve((outputDir as string | undefined) ?? config.downloadDir);
      mkdirSync(dir, { recursive: true });
      const name =
        (fileName as string | undefined) ??
        summary?.fileName ??
        `${String(message.chatId ?? "chat")}_${message.id}${summary?.type === "photo" ? ".jpg" : extensionFor(summary?.mimeType)}`;
      const path = join(dir, basename(name));
      const saved = await client.downloadMedia(message, { outputFile: path });
      const size = statSync(typeof saved === "string" ? saved : path).size;
      return { path: typeof saved === "string" ? saved : path, size, media: summary };
    },
  );

  tool(
    server,
    "send_file",
    {
      title: "Send file",
      description:
        "Uploads and sends a local file: photos and videos are sent as media unless asDocument is set; audio can be sent as a voice note.",
      inputSchema: {
        chat: chatArg,
        path: z.string().min(1).describe("Absolute path of the file to send"),
        caption: z.string().optional(),
        replyTo: z.number().int().optional(),
        asDocument: z.boolean().default(false).describe("Send as a file instead of compressed media"),
        voiceNote: z.boolean().default(false),
        silent: z.boolean().default(false),
        parseMode: z.enum(["none", "markdown", "html"]).default("none"),
      },
    },
    async ({ chat, path, caption, replyTo, asDocument, voiceNote, silent, parseMode }) => {
      assertWritable(chat as string);
      const file = resolve(path as string);
      statSync(file);
      const client = await getAuthorizedClient();
      const sent = await client.sendFile(peer(chat as string), {
        file,
        caption: caption as string | undefined,
        replyTo: replyTo as number | undefined,
        forceDocument: asDocument as boolean,
        voiceNote: voiceNote as boolean,
        silent: silent as boolean,
        parseMode: parseMode === "markdown" ? "md" : parseMode === "html" ? "html" : undefined,
        attributes: asDocument
          ? [new Api.DocumentAttributeFilename({ fileName: basename(file) })]
          : undefined,
      });
      return { sent: true, fileName: basename(file), extension: extname(file), message: formatMessage(sent) };
    },
  );
}
