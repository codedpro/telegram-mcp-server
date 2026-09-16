import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TelegramClient } from "teleproto";
import {
  BUSINESS_TYPES, alreadyHasHistory, blacklist, blacklistByKey, draftOutreach, findByUsername,
  loadCrm, markContacted, rankLeads, saveCrm, syncFromRawLeads, tierOf,
  type LeadTier,
} from "../leads.js";
import {
  enqueue, isEligibleNow, loadBackoff, loadQueue, nextPending, onFailure, onSuccess,
  saveBackoff, saveQueue,
} from "../leads-queue.js";
import { gate } from "../throttle.js";
import { getAuthorizedClient } from "../telegram.js";
import { peer, tool } from "./util.js";

/**
 * The real backstop, checked right before every send: does this chat already
 * have ANY messages in either direction? The CRM is our own bookkeeping and
 * can be wrong or incomplete — the earliest outreach here (Arvin, Atefeh,
 * homayouniex) happened before the CRM existed at all and had to be
 * backfilled by hand afterward. Telegram's own message history cannot be
 * incomplete the way a log file can, so it is the check that actually
 * guarantees "never message someone twice" rather than just usually doing so.
 */
async function hasExistingHistory(client: TelegramClient, username: string): Promise<boolean> {
  try {
    const messages = await client.getMessages(peer("@" + username), { limit: 1 });
    return messages.length > 0;
  } catch {
    // نبودِ دسترسی به تاریخچه نباید جلوِ ارسال را بگیرد؛ فقط یعنی نمی‌دانیم.
    return false;
  }
}

export function register(server: McpServer): void {
  tool(
    server,
    "leads_sync",
    {
      title: "Sync the lead CRM",
      description:
        "Folds every find_advertisers dump in data/leads into the persistent CRM. New people are added as new; anyone already tracked keeps their status (contacted, replied, blacklisted) untouched. Run this after find_advertisers, before leads_list or leads_send.",
      inputSchema: {},
    },
    async () => syncFromRawLeads(),
  );

  tool(
    server,
    "leads_list",
    {
      title: "List leads",
      description: "Lists business-owner leads from the CRM, best fit first. Filter by status or trade.",
      inputSchema: {
        status: z.enum(["new", "contacted", "replied", "blacklisted", "all"]).default("new"),
        tier: z.enum(["priority", "standard", "low", "all"]).default("all")
          .describe("low means already visible to everyone doing this kind of outreach (3+ groups), not 'weak'. This is a reading aid, not a quality filter — a rarely-posting lead can easily be a better target than a heavy poster. Read the sample text and decide per lead; do not treat this as a score to automate over."),
        businessKey: z.string().optional().describe(`One of: ${BUSINESS_TYPES.map((t) => t.key).join(", ")}`),
        limit: z.number().int().min(1).max(200).default(30),
      },
    },
    async ({ status, tier, businessKey, limit }) => {
      const crm = loadCrm();
      const tiers = tier === "all" ? undefined : [tier as LeadTier];
      let leads = status === "all"
        ? Object.values(crm.entries).filter((e) => !tiers || tiers.includes(tierOf(e)))
        : rankLeads(crm, { status: status === "new" ? undefined : (status as never), tiers });
      if (status === "new") leads = rankLeads(crm, { tiers }).filter((e) => e.status === "new");
      if (businessKey) leads = leads.filter((e) => e.businessKey === businessKey);
      return {
        total: leads.length,
        leads: leads.slice(0, limit as number).map((e) => ({
          senderId: e.senderId, username: e.username ? "@" + e.username : null, name: e.name,
          businessType: e.businessType, tier: tierOf(e), posts: e.posts, groups: e.chats, status: e.status,
          sample: e.sample,
        })),
      };
    },
  );

  tool(
    server,
    "leads_blacklist",
    {
      title: "Blacklist leads",
      description:
        "Marks leads as blacklisted, by sender id/username or by whole trade (businessKey). Blacklisted leads are skipped by leads_list and leads_send permanently, and leads_sync never un-blacklists them.",
      inputSchema: {
        senderIds: z.array(z.string()).optional().describe("Sender ids or @usernames"),
        businessKey: z.string().optional().describe(`Blacklist a whole trade: ${BUSINESS_TYPES.map((t) => t.key).join(", ")}`),
        reason: z.string().min(1),
      },
    },
    async ({ senderIds, businessKey, reason }) => {
      const crm = loadCrm();
      let n = 0;
      if (businessKey) n += blacklistByKey(crm, businessKey as string, reason as string);
      if ((senderIds as string[] | undefined)?.length) {
        const ids = (senderIds as string[]).map((s) => {
          if (/^\d+$/.test(s)) return s;
          return findByUsername(crm, s)?.senderId ?? s;
        });
        n += blacklist(crm, ids, reason as string);
      }
      saveCrm(crm);
      return { blacklisted: n };
    },
  );

  tool(
    server,
    "leads_send",
    {
      title: "Send outreach to one lead",
      description:
        "Sends the drafted Persian outreach message to one lead by username and marks them contacted in the CRM. Goes through the same rate gate as every other outward action. Refuses blacklisted leads.",
      inputSchema: {
        username: z.string().min(1),
        account: z.string().default("default"),
        message: z.string().optional().describe("Use this exact text instead of the generic draft. A personalized message that references what the lead actually posted converts better than the template."),
      },
    },
    async ({ username, account, message }) => {
      const crm = loadCrm();
      const lead = findByUsername(crm, username as string);
      if (!lead) throw new Error(`"${username}" is not in the lead CRM. Run telegram_leads_sync first.`);
      if (alreadyHasHistory(lead)) {
        throw new Error(`@${lead.username} already has history (status: ${lead.status}${lead.blacklistReason ? ", " + lead.blacklistReason : ""}). Not sending again.`);
      }
      const client = await getAuthorizedClient(account as string);
      if (await hasExistingHistory(client, lead.username!)) {
        markContacted(crm, lead.senderId, account as string);
        saveCrm(crm);
        throw new Error(`@${lead.username} already has message history on Telegram that the CRM didn't know about. Marked contacted; not sending.`);
      }
      // کلیدِ جداگانه به‌ازای هر حساب: پیامِ سرنخ‌ها نباید منتظرِ نوبتِ کمپینِ
      // تبلیغاتی یا حساب دیگر بماند — هرکدام ساعتِ خودشان را دارند.
      const paced = await gate("leads_send", `leads:${account}`);
      const text = (message as string | undefined) ?? draftOutreach(lead);
      const sent = await client.sendMessage(peer("@" + lead.username), { message: text });
      markContacted(crm, lead.senderId, account as string);
      saveCrm(crm);
      return { sent: true, to: "@" + lead.username, waitedMs: paced.waitedMs, messageId: sent.id };
    },
  );

  tool(
    server,
    "leads_queue_add",
    {
      title: "Add hand-picked leads to the send queue",
      description:
        "Adds specific, already-read leads to the outreach queue in priority order, each with the exact message to send them. This is for leads a person (or an agent, having read the actual post) decided are worth contacting — nothing goes in here by a formula. Skips anyone already queued, and refuses anyone the CRM says already has history (contacted, replied, or blacklisted) — sync first if a name should be queueable but isn't.",
      inputSchema: {
        items: z.array(z.object({
          username: z.string().min(1),
          priority: z.number().int().min(1).describe("Lower sends first"),
          message: z.string().min(1),
          reason: z.string().min(1).describe("Why this lead was picked, for the log"),
        })).min(1),
      },
    },
    async ({ items }) => {
      const crm = loadCrm();
      const list = items as { username: string; priority: number; message: string; reason: string }[];
      const refused: { username: string; status: string }[] = [];
      const clean = list.filter((it) => {
        const lead = findByUsername(crm, it.username);
        if (alreadyHasHistory(lead)) {
          refused.push({ username: it.username, status: lead!.status });
          return false;
        }
        return true;
      });
      return { added: enqueue(clean as never), refused };
    },
  );

  tool(
    server,
    "leads_queue_status",
    {
      title: "Queue and backoff status",
      description: "Shows the send queue and each account's current backoff stage.",
      inputSchema: { accounts: z.array(z.string()).default(["default", "outreach"]) },
    },
    async ({ accounts }) => {
      const q = loadQueue();
      const counts: Record<string, number> = {};
      for (const i of q.items) counts[i.status] = (counts[i.status] ?? 0) + 1;
      return {
        queue: counts,
        pendingNext: nextPending(q)?.username ?? null,
        backoff: Object.fromEntries((accounts as string[]).map((a) => [a, loadBackoff(a)])),
      };
    },
  );

  tool(
    server,
    "leads_queue_tick",
    {
      title: "Attempt the next queued send for one account",
      description:
        "Checks that account's backoff state; if eligible, sends the next pending queue item as that account and records success or failure. Before sending, verifies (against the CRM and against Telegram's own message history) that this person has never been contacted — a queue item that turns out to already have history is skipped, not sent, and the search moves to the next pending item rather than burning the tick. On PEER_FLOOD/FLOOD_WAIT it escalates the backoff (1h, then 1d, then 1d, then weekly, giving up after 4 weekly attempts) rather than retrying blind. Any success resets the account straight back to normal pacing.",
      inputSchema: { account: z.string().min(1) },
    },
    async ({ account }) => {
      const acct = account as string;
      const backoff = loadBackoff(acct);
      if (!isEligibleNow(backoff)) {
        return { attempted: false, stage: backoff.stage, nextAttemptAt: backoff.nextAttemptAt };
      }
      const client = await getAuthorizedClient(acct);

      // چند تلاش پشت‌سرهم برای رد شدن از موارد «قبلاً سابقه داشته‌ایم»، بدون
      // اینکه یک تیک را کاملاً هدر بدهند یا حلقه‌ی بی‌پایان بسازند.
      const skipped: { username: string; reason: string }[] = [];
      for (let i = 0; i < 5; i++) {
        const q = loadQueue();
        const item = nextPending(q);
        if (!item) {
          return skipped.length
            ? { attempted: false, reason: "queue is empty after skipping duplicates", skipped }
            : { attempted: false, reason: "queue is empty" };
        }

        const crm = loadCrm();
        const lead = findByUsername(crm, item.username);
        if (alreadyHasHistory(lead)) {
          item.status = "skipped";
          saveQueue(q);
          skipped.push({ username: item.username, reason: `CRM already says ${lead!.status}` });
          continue;
        }
        if (await hasExistingHistory(client, item.username)) {
          item.status = "skipped";
          saveQueue(q);
          if (lead) markContacted(crm, lead.senderId, acct);
          saveCrm(crm);
          skipped.push({ username: item.username, reason: "Telegram already has message history the CRM didn't know about" });
          continue;
        }

        try {
          const paced = await gate("leads_queue", `leads:${acct}`);
          const sent = await client.sendMessage(peer("@" + item.username), { message: item.message });
          item.status = "sent";
          item.sentAt = new Date().toISOString();
          item.messageId = sent.id;
          item.account = acct;
          saveQueue(q);
          if (lead) { markContacted(crm, lead.senderId, acct); saveCrm(crm); }
          saveBackoff(acct, onSuccess());
          return { attempted: true, sent: true, to: "@" + item.username, waitedMs: paced.waitedMs, messageId: sent.id, skipped: skipped.length ? skipped : undefined };
        } catch (err) {
          const message = (err as Error).message;
          if (/PEER_FLOOD|FLOOD_WAIT/.test(message)) {
            const next = onFailure(backoff, message.slice(0, 160));
            saveBackoff(acct, next);
            return { attempted: true, sent: false, blocked: true, stage: next.stage, nextAttemptAt: next.nextAttemptAt, error: message.slice(0, 160), skipped: skipped.length ? skipped : undefined };
          }
          item.status = "failed";
          saveQueue(q);
          throw err;
        }
      }
      return { attempted: false, reason: "too many already-contacted items in a row", skipped };
    },
  );
}
