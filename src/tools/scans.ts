import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Api } from "teleproto";
import { isoDate } from "../format.js";
import { activeAccount } from "../session.js";
import {
  CATEGORIES, classify, lastScan, listFolders, listScans, readScan, resolveFolder, saveScan,
  type ScanItem, type ScanRecord,
} from "../scans.js";
import * as ledgerStore from "../ledger.js";
import { getAuthorizedClient } from "../telegram.js";
import { peer, requireConfirm, tool } from "./util.js";

const categoryArg = z
  .array(z.enum(["SEO", "AI", "Web", "Software"]))
  .default([])
  .describe("Categories to keep. Empty means all four.");

export function register(server: McpServer): void {
  tool(
    server,
    "list_folders",
    {
      title: "List chat folders",
      description: "Lists your Telegram chat folders (the tabs above the chat list) and how many chats each holds.",
      inputSchema: {},
    },
    async () => listFolders(await (await getAuthorizedClient()).invoke(new Api.messages.GetDialogFilters())),
  );

  tool(
    server,
    "create_folder",
    {
      title: "Create a folder",
      description:
        "Creates a new folder (tab) containing the given chats. Use this when the folder you wanted is a shared folder (chatlist type), which Telegram does not let you add arbitrary chats to. You must already be a member of each chat.",
      inputSchema: {
        title: z.string().min(1).max(24),
        chats: z.array(z.string().min(1)).min(1).max(100),
        emoticon: z.string().max(8).default("").describe("Optional folder icon emoji"),
      },
    },
    async ({ title, chats, emoticon }) => {
      const client = await getAuthorizedClient();
      const existing = await client.invoke(new Api.messages.GetDialogFilters());
      const used = new Set<number>();
      for (const f of existing.filters) {
        const id = (f as unknown as { id?: number }).id;
        if (typeof id === "number") used.add(id);
      }
      // شناسه‌ی پوشه از ۲ شروع می‌شود؛ ۰ و ۱ رزرو تلگرام‌اند.
      let id = 2;
      while (used.has(id)) id += 1;

      const include: Api.TypeInputPeer[] = [];
      const skipped: { chat: string; reason: string }[] = [];
      for (const chat of chats as string[]) {
        try {
          include.push(await client.getInputEntity(peer(chat)));
        } catch (err) {
          skipped.push({ chat, reason: (err as Error).message.slice(0, 80) });
        }
      }
      if (!include.length) throw new Error("None of those chats could be resolved. Join them first.");

      await client.invoke(
        new Api.messages.UpdateDialogFilter({
          id,
          filter: new Api.DialogFilter({
            id,
            title: new Api.TextWithEntities({ text: String(title), entities: [] }),
            emoticon: (emoticon as string) || undefined,
            pinnedPeers: [],
            includePeers: include,
            excludePeers: [],
          }),
        }),
      );
      return { created: title, id, added: include.length, skipped };
    },
  );

  tool(
    server,
    "delete_folder",
    {
      title: "Delete a folder",
      description:
        "Removes a folder (tab). The chats stay in your chat list and in any other folder — only the tab goes. Shared folders (chatlist type) are removed from your account too. Requires confirm: true.",
      inputSchema: { folder: z.string().min(1), confirm: z.boolean().optional() },
      destructive: true,
    },
    async ({ folder, confirm }) => {
      requireConfirm(confirm as boolean | undefined, `Deleting the folder "${folder}"`);
      const client = await getAuthorizedClient();
      const res = await client.invoke(new Api.messages.GetDialogFilters());
      const title = (f: Api.TypeDialogFilter) => {
        const t = (f as { title?: { text?: string } | string }).title;
        return typeof t === "string" ? t : (t?.text ?? "");
      };
      const target = res.filters.find((f) => title(f).toLowerCase() === String(folder).trim().toLowerCase());
      if (!target) throw new Error(`No folder named "${folder}".`);
      const id = (target as unknown as { id?: number }).id;
      if (typeof id !== "number") throw new Error(`"${folder}" is the default list and cannot be deleted.`);
      // آپدیت بدون filter یعنی حذف — همان راهی که خودِ تلگرام پوشه را برمی‌دارد.
      await client.invoke(new Api.messages.UpdateDialogFilter({ id }));
      return { deleted: title(target), id, kind: target.className };
    },
  );

  tool(
    server,
    "add_to_folder",
    {
      title: "Add chats to a folder",
      description:
        "Adds chats to an existing folder (tab). You must already be a member of each chat — join first with telegram_join_chat. Shared folders (chatlist type) cannot be edited this way.",
      inputSchema: {
        folder: z.string().min(1),
        chats: z.array(z.string().min(1)).min(1).max(50).describe("Chat ids, @usernames"),
      },
    },
    async ({ folder, chats }) => {
      const client = await getAuthorizedClient();
      const res = await client.invoke(new Api.messages.GetDialogFilters());
      const title = (f: Api.TypeDialogFilter) => {
        const t = (f as { title?: { text?: string } | string }).title;
        return typeof t === "string" ? t : (t?.text ?? "");
      };
      const target = res.filters.find((f) => title(f).toLowerCase() === String(folder).trim().toLowerCase());
      if (!target) throw new Error(`No folder named "${folder}".`);
      if (!(target instanceof Api.DialogFilter)) {
        throw new Error(`"${folder}" is a shared folder (${target.className}) and cannot be edited here.`);
      }

      const existing = new Set<string>();
      for (const p of [...target.pinnedPeers, ...target.includePeers, ...target.excludePeers]) {
        existing.add(String(await client.getPeerId(p)));
      }

      const added: string[] = [];
      const skipped: { chat: string; reason: string }[] = [];
      for (const chat of chats as string[]) {
        try {
          const input = await client.getInputEntity(peer(chat));
          const id = String(await client.getPeerId(input));
          if (existing.has(id)) { skipped.push({ chat, reason: "already in the folder" }); continue; }
          target.includePeers.push(input);
          existing.add(id);
          added.push(chat);
        } catch (err) {
          // معمولاً یعنی عضو گروه نیستیم و دسترسی به آن نداریم.
          skipped.push({ chat, reason: (err as Error).message.slice(0, 90) });
        }
      }

      if (added.length) {
        await client.invoke(new Api.messages.UpdateDialogFilter({ id: target.id, filter: target }));
      }
      return {
        folder: title(target),
        added,
        skipped,
        totalInFolder: target.pinnedPeers.length + target.includePeers.length,
      };
    },
  );

  tool(
    server,
    "scan_folder",
    {
      title: "Scan a folder for job posts",
      description:
        "Reads every chat in a folder over the last N days, classifies posts as SEO, AI, Web, or Software, marks which are employer openings versus self-promotion versus already closed, and saves the result to data/scans so a later session can read it back without refetching.",
      inputSchema: {
        folder: z.string().min(1).describe("Folder name, e.g. freelance"),
        days: z.number().int().min(1).max(30).default(3),
        categories: categoryArg,
        onlyNew: z.boolean().default(false).describe("Return only posts not seen in the previous scan of this folder"),
        skipKnown: z.boolean().default(true).describe("Skip posts already in the ledger, including cross-posted copies. This is what keeps repeat scans cheap."),
        dedupe: z.boolean().default(true).describe("Collapse the same job cross-posted into several channels into one entry"),
        retentionDays: z.number().int().min(7).max(365).default(90).describe("Ledger rotation: forget 'seen' entries older than this. Applied entries are never forgotten."),
        save: z.boolean().default(true),
        maxPerChat: z.number().int().min(50).max(2000).default(1000),
      },
    },
    async ({ folder, days, categories, onlyNew, skipKnown, dedupe, retentionDays, save, maxPerChat }) => {
      const client = await getAuthorizedClient();
      const { title, peers } = await resolveFolder(client, folder as string);
      const cutoff = Math.floor(Date.now() / 1000) - (days as number) * 86400;
      const previous = onlyNew ? lastScan(title) : undefined;
      const seen = new Set((previous?.items ?? []).map((i) => `${i.chatId}:${i.messageId}`));

      // خاطره‌ی چیزهایی که قبلاً دیده‌ایم — چرخانده می‌شود تا بی‌انتها رشد نکند.
      const ledger = ledgerStore.load(title);
      const rotated = ledgerStore.rotate(ledger, retentionDays as number);
      const knownBefore = Object.keys(ledger.entries).length;
      /** اثر انگشتِ آگهی‌هایی که در همین اسکن دیده‌ایم — برای حذفِ کپی‌های بین‌کانالی. */
      const seenThisRun = new Set<string>();
      let skippedKnown = 0;
      let skippedDuplicate = 0;

      const chats: ScanRecord["chats"] = [];
      const items: ScanItem[] = [];

      for (const p of peers) {
        let chatTitle = "?", username: string | null = null, chatId = "?";
        try {
          const entity = (await client.getEntity(p)) as { title?: string; firstName?: string; lastName?: string; username?: string };
          chatTitle = entity.title ?? [entity.firstName, entity.lastName].filter(Boolean).join(" ") ?? "?";
          username = entity.username ?? null;
          chatId = String(await client.getPeerId(p));
        } catch {
          continue;
        }
        let offsetId = 0, scanned = 0, matched = 0, done = false;
        while (!done && scanned < (maxPerChat as number)) {
          let batch;
          try {
            batch = await client.getMessages(p, { limit: 100, offsetId });
          } catch {
            break;
          }
          if (!batch.length) break;
          for (const m of batch) {
            if (m.date < cutoff) { done = true; break; }
            scanned += 1;
            const text = m.message ?? "";
            if (!text.trim()) continue;
            const verdict = classify(text, categories as string[]);
            if (!verdict) continue;
            if (onlyNew && seen.has(`${chatId}:${m.id}`)) continue;

            const fp = ledgerStore.fingerprint(text);
            if (skipKnown && ledger.entries[fp]) {
              // همان آگهی را قبلاً سطح آورده‌ایم؛ فقط تاریخِ آخرین رؤیت را تازه کن.
              ledger.entries[fp].lastSeen = new Date().toISOString();
              skippedKnown += 1;
              continue;
            }
            if (dedupe && seenThisRun.has(fp)) { skippedDuplicate += 1; continue; }
            seenThisRun.add(fp);
            matched += 1;
            items.push({
              chatId, chatTitle, username,
              messageId: m.id,
              date: isoDate(m.date) ?? "",
              link: username ? `https://t.me/${username}/${m.id}` : `https://t.me/c/${chatId.replace("-100", "")}/${m.id}`,
              ...verdict,
              text: text.replace(/\s+/g, " ").trim(),
            });
          }
          offsetId = batch[batch.length - 1].id;
        }
        chats.push({ id: chatId, title: chatTitle, username, scanned, matched });
      }

      // هرچه تازه پیدا شد وارد دفتر می‌شود، تا اسکنِ بعدی دوباره سراغش نرود.
      for (const i of items) {
        ledgerStore.record(ledger, { text: i.text, title: i.chatTitle, link: i.link, categories: i.categories });
      }
      const ledgerFile = ledgerStore.save(ledger);

      const byCategory: Record<string, number> = {};
      for (const i of items) for (const c of i.categories) byCategory[c] = (byCategory[c] ?? 0) + 1;
      const openJobs = items.filter((i) => i.isJob && !i.isProvider && !i.isClosed).length;

      const record: ScanRecord = {
        id: `${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${title.replace(/[^A-Za-z0-9._-]/g, "_")}`,
        folder: title,
        createdAt: new Date().toISOString(),
        days: days as number,
        cutoff: new Date(cutoff * 1000).toISOString(),
        account: activeAccount(),
        chats,
        totals: { scanned: chats.reduce((s, c) => s + c.scanned, 0), matched: items.length, openJobs, byCategory },
        items,
      };
      const file = save ? saveScan(record) : undefined;
      return {
        ...record,
        savedTo: file,
        comparedWith: previous?.id,
        ledger: {
          file: ledgerFile,
          knownBefore,
          knownAfter: Object.keys(ledger.entries).length,
          skippedAlreadySeen: skippedKnown,
          skippedCrossPostCopies: skippedDuplicate,
          rotatedOut: rotated.pruned,
          retentionDays,
        },
        items: undefined,
        note: `Only posts not already in the ledger are included. Read them with telegram_read_scan id "${record.id}".`,
      };
    },
  );

  tool(
    server,
    "list_scans",
    {
      title: "List saved scans",
      description: "Lists previous folder scans stored in data/scans, newest first.",
      inputSchema: { limit: z.number().int().min(1).max(200).default(20) },
    },
    async ({ limit }) => listScans().slice(0, limit as number),
  );

  tool(
    server,
    "read_scan",
    {
      title: "Read a saved scan",
      description:
        "Reads posts back out of a saved scan without touching Telegram. Filter by category, and by whether a post is a live employer opening.",
      inputSchema: {
        id: z.string().min(1),
        categories: categoryArg,
        openJobsOnly: z.boolean().default(true).describe("Keep only employer openings that are not self-promotion and not marked taken"),
        limit: z.number().int().min(1).max(500).default(50),
        maxChars: z.number().int().min(80).max(4000).default(400),
      },
    },
    async ({ id, categories, openJobsOnly, limit, maxChars }) => {
      const scan = readScan(id as string);
      const wanted = categories as string[];
      let items = scan.items;
      if (wanted.length) items = items.filter((i) => i.categories.some((c) => wanted.includes(c)));
      if (openJobsOnly) items = items.filter((i) => i.isJob && !i.isProvider && !i.isClosed);
      return {
        scan: { id: scan.id, folder: scan.folder, createdAt: scan.createdAt, cutoff: scan.cutoff },
        returned: Math.min(items.length, limit as number),
        matching: items.length,
        categoriesAvailable: Object.keys(CATEGORIES),
        items: items.slice(0, limit as number).map((i) => ({
          ...i,
          text: i.text.slice(0, maxChars as number),
        })),
      };
    },
  );

  tool(
    server,
    "list_ledger",
    {
      title: "List the seen/applied ledger",
      description:
        "Shows what a folder's ledger already knows: posts previously surfaced, and which ones you applied to. Repeat scans skip everything in here, which is what keeps them cheap.",
      inputSchema: {
        folder: z.string().min(1),
        status: z.enum(["all", "seen", "applied", "ignored"]).default("all"),
        limit: z.number().int().min(1).max(500).default(50),
      },
    },
    async ({ folder, status, limit }) => {
      const ledger = ledgerStore.load(folder as string);
      let entries = Object.values(ledger.entries);
      if (status !== "all") entries = entries.filter((e) => e.status === status);
      entries.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
      const counts = Object.values(ledger.entries).reduce<Record<string, number>>((acc, e) => {
        acc[e.status] = (acc[e.status] ?? 0) + 1;
        return acc;
      }, {});
      return {
        folder: ledger.folder,
        updatedAt: ledger.updatedAt,
        total: Object.keys(ledger.entries).length,
        counts,
        entries: entries.slice(0, limit as number),
      };
    },
  );

  tool(
    server,
    "mark_applied",
    {
      title: "Mark a post as applied",
      description:
        "Records that you contacted the poster of a job. Applied entries are never rotated out of the ledger, so the same job is never surfaced or re-applied to, even if it is reposted months later.",
      inputSchema: {
        folder: z.string().min(1),
        fingerprints: z.array(z.string().min(6)).min(1).describe("Fingerprints from telegram_list_ledger or a scan"),
        contact: z.string().optional().describe("Who you wrote to, e.g. @someone"),
        note: z.string().optional(),
      },
    },
    async ({ folder, fingerprints, contact, note }) => {
      const ledger = ledgerStore.load(folder as string);
      const updated: string[] = [];
      const missing: string[] = [];
      for (const fp of fingerprints as string[]) {
        const entry = ledgerStore.markAppliedByFingerprint(ledger, fp, note as string | undefined);
        if (!entry) { missing.push(fp); continue; }
        if (contact) entry.contact = contact as string;
        updated.push(fp);
      }
      const file = ledgerStore.save(ledger);
      return { folder, updated: updated.length, missing, file };
    },
  );

  tool(
    server,
    "forget_ledger",
    {
      title: "Rotate or clear the ledger",
      description:
        "Runs the retention rotation by hand, or clears a folder's ledger entirely so the next scan surfaces everything again. Applied entries survive rotation but not a full clear.",
      inputSchema: {
        folder: z.string().min(1),
        retentionDays: z.number().int().min(1).max(365).default(90),
        clearAll: z.boolean().default(false).describe("Wipe the whole ledger, applied entries included"),
        confirm: z.boolean().optional(),
      },
      destructive: true,
    },
    async ({ folder, retentionDays, clearAll, confirm }) => {
      const ledger = ledgerStore.load(folder as string);
      const before = Object.keys(ledger.entries).length;
      if (clearAll) {
        requireConfirm(confirm as boolean | undefined, `Clearing the whole ledger for "${folder}"`);
        ledger.entries = {};
        return { folder, before, after: 0, file: ledgerStore.save(ledger) };
      }
      const { kept, pruned } = ledgerStore.rotate(ledger, retentionDays as number);
      return { folder, before, kept, pruned, retentionDays, file: ledgerStore.save(ledger) };
    },
  );
}
