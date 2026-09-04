import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type Advertiser, extractContacts, looksLikeAd, mergeAdvertiser, resolveSender, sampleOf,
} from "../advertisers.js";
import { isoDate } from "../format.js";
import { resolveFolder } from "../scans.js";
import { getAuthorizedClient } from "../telegram.js";
import { peer, tool } from "./util.js";

const outDir = () => process.env.TELEGRAM_LEADS_DIR ?? join(process.cwd(), "data", "leads");

export function register(server: McpServer): void {
  tool(
    server,
    "find_advertisers",
    {
      title: "Find business owners advertising in groups",
      description:
        "Reads the groups in a folder (or one chat) and pulls out the people advertising a business. Each lead carries the RESOLVED SENDER — user id, @username and name — because in most posts the way to reach someone is their account, not anything written in the message. Phone numbers, handles, links and emails found in the text are added on top. Results are deduplicated per person across groups and saved to data/leads.",
      inputSchema: {
        folder: z.string().optional().describe("Folder name, e.g. Marketing"),
        chat: z.string().optional().describe("A single chat instead of a folder"),
        days: z.number().int().min(1).max(120).default(30),
        maxPerChat: z.number().int().min(50).max(5000).default(1500),
        minPosts: z.number().int().min(1).max(20).default(1).describe("Only keep people who advertised at least this many times"),
        withContactOnly: z.boolean().default(false).describe("Keep only leads that have a username, phone, or link"),
        save: z.boolean().default(true),
      },
    },
    async ({ folder, chat, days, maxPerChat, minPosts, withContactOnly, save }) => {
      if (!folder && !chat) throw new Error("Give either a folder or a chat.");
      const client = await getAuthorizedClient();

      const targets: { peer: unknown; label: string }[] = [];
      let label = String(chat ?? folder);
      if (folder) {
        const resolved = await resolveFolder(client, folder as string);
        label = resolved.title;
        for (const p of resolved.peers) targets.push({ peer: p, label: "" });
      } else {
        targets.push({ peer: peer(chat as string), label: "" });
      }

      const cutoff = Math.floor(Date.now() / 1000) - (days as number) * 86400;
      const senderCache = new Map<string, { username: string | null; name: string; isBot: boolean; isPremium: boolean }>();
      const people = new Map<string, Advertiser>();
      const chats: { title: string; username: string | null; scanned: number; ads: number }[] = [];

      for (const t of targets) {
        let title = "?", uname: string | null = null;
        try {
          const e = (await client.getEntity(t.peer as never)) as { title?: string; username?: string };
          title = e.title ?? "?";
          uname = e.username ?? null;
        } catch { continue; }

        let offsetId = 0, scanned = 0, ads = 0, done = false;
        while (!done && scanned < (maxPerChat as number)) {
          let batch;
          try { batch = await client.getMessages(t.peer as never, { limit: 100, offsetId }); }
          catch { break; }
          if (!batch.length) break;
          for (const m of batch) {
            if (m.date < cutoff) { done = true; break; }
            scanned += 1;
            const text = m.message ?? "";
            if (!text.trim() || !looksLikeAd(text)) continue;
            const senderId = m.senderId ? String(m.senderId) : null;
            if (!senderId) continue;
            const who = await resolveSender(client, senderId, senderCache);
            if (who.isBot) continue;
            ads += 1;
            const contacts = extractContacts(text);
            mergeAdvertiser(people, {
              senderId,
              username: who.username,
              name: who.name,
              isBot: who.isBot,
              isPremium: who.isPremium,
              chat: uname ? `@${uname}` : title,
              date: isoDate(m.date) ?? "",
              ...contacts,
              sample: sampleOf(text),
              sampleLink: uname ? `https://t.me/${uname}/${m.id}` : "",
            });
          }
          offsetId = batch[batch.length - 1].id;
        }
        chats.push({ title, username: uname, scanned, ads });
      }

      let leads = [...people.values()].filter((p) => p.posts >= (minPosts as number));
      if (withContactOnly) leads = leads.filter((p) => p.username || p.phones.length || p.links.length);
      leads.sort((a, b) => b.posts - a.posts || b.lastSeen.localeCompare(a.lastSeen));

      const record = {
        id: `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${label.replace(/[^A-Za-z0-9._-]/g, "_")}-leads`,
        source: label,
        createdAt: new Date().toISOString(),
        days,
        chats,
        totals: {
          scanned: chats.reduce((s, c) => s + c.scanned, 0),
          adPosts: chats.reduce((s, c) => s + c.ads, 0),
          people: people.size,
          kept: leads.length,
          withUsername: leads.filter((l) => l.username).length,
          withPhone: leads.filter((l) => l.phones.length).length,
          multiGroup: leads.filter((l) => l.chats.length > 1).length,
        },
        leads,
      };

      let file: string | undefined;
      if (save) {
        mkdirSync(outDir(), { recursive: true });
        file = join(outDir(), `${record.id}.json`);
        writeFileSync(file, JSON.stringify(record, null, 2));
      }
      return { ...record, leads: undefined, savedTo: file, note: `Read leads with telegram_read_leads id "${record.id}".` };
    },
  );

  tool(
    server,
    "read_leads",
    {
      title: "Read a saved lead list",
      description: "Reads business-owner leads back out of a saved run without touching Telegram. Filter by contact type or by the group they posted in.",
      inputSchema: {
        id: z.string().min(1),
        withUsernameOnly: z.boolean().default(false),
        withPhoneOnly: z.boolean().default(false),
        chat: z.string().optional().describe("Only leads who posted in this group, e.g. @iranianeusa"),
        limit: z.number().int().min(1).max(500).default(60),
        maxChars: z.number().int().min(60).max(1000).default(200),
      },
    },
    async ({ id, withUsernameOnly, withPhoneOnly, chat, limit, maxChars }) => {
      const file = join(outDir(), `${String(id).replace(/[^A-Za-z0-9._-]/g, "")}.json`);
      if (!existsSync(file)) throw new Error(`No lead run "${id}" in ${outDir()}.`);
      const run = JSON.parse(readFileSync(file, "utf8")) as { leads: Advertiser[]; totals: unknown; source: string };
      let leads = run.leads;
      if (withUsernameOnly) leads = leads.filter((l) => l.username);
      if (withPhoneOnly) leads = leads.filter((l) => l.phones.length);
      if (chat) leads = leads.filter((l) => l.chats.includes(chat as string));
      return {
        source: run.source,
        totals: run.totals,
        matching: leads.length,
        leads: leads.slice(0, limit as number).map((l) => ({ ...l, sample: l.sample.slice(0, maxChars as number) })),
      };
    },
  );
}
