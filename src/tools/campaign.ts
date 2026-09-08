import { resolve } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  daysSince, lastPostTo, loadCopy, loadGroups, loadLedger, planAhead, planNext,
  recordPost, render, saveGroups,
} from "../campaign.js";
import { gate } from "../throttle.js";
import { getAuthorizedClient } from "../telegram.js";
import { activeAccount, listAccounts } from "../session.js";
import { peer, tool } from "./util.js";

export function register(server: McpServer): void {
  tool(
    server,
    "campaign_status",
    {
      title: "Campaign status",
      description:
        "Shows the advertising roster, which groups are due for a post, when each last saw an ad, and how much of the copy library each has already seen.",
      inputSchema: { campaign: z.string().default("web") },
    },
    async ({ campaign }) => {
      const groups = loadGroups(campaign as string);
      const copy = loadCopy(campaign as string);
      const ledger = loadLedger(campaign as string);
      const ok = ledger.posts.filter((p) => !p.error);
      return {
        offer: copy.offer,
        variants: copy.variants.length,
        regions: Object.keys(copy.offer.regions ?? {}),
        activeAccount: activeAccount(),
        accounts: listAccounts().map((a) => a.name),
        totalPosts: ok.length,
        groups: groups.map((g) => {
          const last = lastPostTo(ledger, g.username);
          const days = daysSince(last?.at);
          const seen = new Set(ok.filter((p) => p.group === g.username).map((p) => p.variant));
          return {
            group: "@" + g.username,
            members: g.members,
            enabled: g.enabled,
            account: g.account,
            lastPostedAt: last?.at ?? null,
            daysSince: Number.isFinite(days) ? Math.round(days * 10) / 10 : null,
            dueIn: g.enabled ? Math.max(0, Math.round((g.minDaysBetween - days) * 10) / 10) : null,
            due: g.enabled && days >= g.minDaysBetween,
            region: g.region,
            copySeen: `${seen.size}/${copy.variants.length}`,
            note: g.note,
          };
        }),
      };
    },
  );

  tool(
    server,
    "campaign_plan",
    {
      title: "Preview the schedule",
      description:
        "Dry run. Shows the next N posts the rotation would make — which group, which copy, and why that pairing — without sending anything.",
      inputSchema: {
        count: z.number().int().min(1).max(60).default(12),
        showText: z.boolean().default(false),
        campaign: z.string().default("web"),
      },
    },
    async ({ count, showText, campaign }) => {
      const copy = loadCopy(campaign as string);
      const plans = planAhead(loadGroups(campaign as string), copy, loadLedger(campaign as string), count as number);
      return {
        planned: plans.length,
        posts: plans.map((p, i) => ({
          order: i + 1,
          group: "@" + p.group.username,
          account: p.group.account,
          variant: p.variant.id,
          angle: p.variant.angle,
          reason: p.reason,
          ...(showText ? { text: render(p.variant.text, copy.offer, p.group.region, p.group.lang ?? "fa") } : {}),
        })),
      };
    },
  );

  tool(
    server,
    "campaign_post_next",
    {
      title: "Post the next scheduled ad",
      description:
        "Posts one ad: the group that has waited longest, paired with copy it has not seen. Goes through the same rate gate as every other outward action. Use dryRun to see what it would do without sending.",
      inputSchema: {
        dryRun: z.boolean().default(false),
        group: z.string().optional().describe("Force a specific group instead of the scheduler's pick"),
        force: z.boolean().default(false).describe("Ignore the per-group cooldown. The rate gate still applies. Manual use only — the cooldown is what stops a group being spammed."),
        campaign: z.string().default("web"),
      },
    },
    async ({ dryRun, group, force, campaign }) => {
      const groups = loadGroups(campaign as string);
      const copy = loadCopy(campaign as string);
      const ledger = loadLedger(campaign as string);

      const plan = group
        ? (() => {
            const g = groups.find((x) => x.username === String(group).replace(/^@/, ""));
            if (!g) throw new Error(`"${group}" is not in the roster.`);
            if (!g.enabled) throw new Error(`@${g.username} is disabled: ${g.note ?? "no reason recorded"}`);
            return planNext([g], copy, ledger, new Set(), force as boolean);
          })()
        : planNext(groups, copy, ledger, new Set(), force as boolean);

      if (!plan) {
        return { posted: false, reason: "Nothing is due. Every enabled group is still inside its cooldown." };
      }
      const text = render(plan.variant.text, copy.offer, plan.group.region, plan.group.lang ?? "fa");
      if (dryRun) {
        return { posted: false, dryRun: true, group: "@" + plan.group.username, variant: plan.variant.id, reason: plan.reason, text };
      }
      // استخرِ حساب‌ها یعنی لازم نیست حسابِ فعال را عوض کنیم؛ همان حسابی که این
      // گروه به آن سپرده شده مستقیماً پست می‌کند.
      const client = await getAuthorizedClient(plan.group.account);
      // این مسیر مستقیم به کلاینت می‌زند، پس باید خودش از گیت رد شود؛ وگرنه سه آگهی
      // در بیست دقیقه می‌رود بیرون، که دقیقاً همان الگویی است که گیت برای جلوگیری از
      // آن نوشته شد.
      const paced = await gate("campaign_post");
      try {
        // متن‌تنها و متن+تصویر را قاطی می‌کنیم: شش آگهیِ پشت‌سرهم با یک قالبِ ثابت،
        // خودش یک الگوی قابلِ تشخیص است.
        const target = peer("@" + plan.group.username);
        let sent;
        let droppedImage = false;
        if (plan.variant.image) {
          try {
            sent = await client.sendFile(target, { file: resolve(plan.variant.image), caption: text });
          } catch (err) {
            // بعضی گروه‌ها متن را می‌پذیرند ولی عکس را نه. آگهی را دور نمی‌ریزیم؛
            // بدون تصویر می‌فرستیم، که هنوز کاملاً خواناست.
            if (!/CHAT_SEND_PHOTOS_FORBIDDEN|CHAT_SEND_MEDIA_FORBIDDEN/.test((err as Error).message)) throw err;
            sent = await client.sendMessage(target, { message: text });
            droppedImage = true;
          }
        } else {
          sent = await client.sendMessage(target, { message: text });
        }
        recordPost(ledger, {
          group: plan.group.username,
          variant: plan.variant.id,
          account: plan.group.account,
          at: new Date().toISOString(),
          messageId: sent.id,
        }, campaign as string);
        return {
          posted: true,
          group: "@" + plan.group.username,
          variant: plan.variant.id,
          withImage: Boolean(plan.variant.image) && !droppedImage,
          imageDropped: droppedImage || undefined,
          waitedMs: paced.waitedMs,
          messageId: sent.id,
        };
      } catch (err) {
        const message = (err as Error).message;
        recordPost(ledger, {
          group: plan.group.username,
          variant: plan.variant.id,
          account: plan.group.account,
          at: new Date().toISOString(),
          error: message.slice(0, 200),
        }, campaign as string);
        throw err;
      }
    },
  );

  tool(
    server,
    "campaign_check_survival",
    {
      title: "Check which groups keep our ads",
      description:
        "Re-reads every ad this campaign posted and reports whether it is still there. Groups that delete ads are the single biggest waste in a rotation — the post costs a rate-gate slot, risks the account, and reaches nobody. Optionally disables groups whose deletion rate is at or above a threshold.",
      inputSchema: {
        minPosts: z.number().int().min(1).max(20).default(2).describe("Only judge a group once it has this many posts to judge on"),
        disableAtRate: z.number().min(0).max(1).default(1).describe("Disable a group whose deleted share is at least this. 1 means only groups deleting everything."),
        apply: z.boolean().default(false).describe("Actually disable; otherwise report only"),
        campaign: z.string().default("web"),
      },
    },
    async ({ minPosts, disableAtRate, apply, campaign }) => {
      const groups = loadGroups(campaign as string);
      const ledger = loadLedger(campaign as string);
      const posts = ledger.posts.filter((p) => !p.error && p.messageId);

      const byGroup = new Map<string, { alive: number; deleted: number }>();
      for (const p of posts) {
        const client = await getAuthorizedClient(
          groups.find((g) => g.username === p.group)?.account ?? "default",
        );
        let alive = false;
        try {
          const found = await client.getMessages(peer("@" + p.group), { ids: [p.messageId!] });
          alive = Boolean(found[0] && (found[0].message ?? "").length);
        } catch {
          alive = false;
        }
        const tally = byGroup.get(p.group) ?? { alive: 0, deleted: 0 };
        if (alive) tally.alive += 1;
        else tally.deleted += 1;
        byGroup.set(p.group, tally);
      }

      const report = [...byGroup.entries()].map(([username, t]) => {
        const total = t.alive + t.deleted;
        return { group: "@" + username, posts: total, alive: t.alive, deleted: t.deleted, deletedRate: total ? t.deleted / total : 0 };
      }).sort((a, b) => b.deletedRate - a.deletedRate);

      const disabled: string[] = [];
      if (apply) {
        for (const row of report) {
          if (row.posts < (minPosts as number) || row.deletedRate < (disableAtRate as number)) continue;
          const g = groups.find((x) => "@" + x.username === row.group);
          if (!g || !g.enabled) continue;
          g.enabled = false;
          g.note = `AUTO-DISABLED: deleted ${row.deleted}/${row.posts} ads`;
          disabled.push(row.group);
        }
        if (disabled.length) saveGroups(groups, campaign as string);
      }
      return { checked: posts.length, groups: report, disabled, applied: Boolean(apply) };
    },
  );

  tool(
    server,
    "campaign_reassign",
    {
      title: "Move groups to another account",
      description:
        "Failover. Reassigns groups to a different saved account, so a limit on one account does not stall the whole rotation.",
      inputSchema: {
        toAccount: z.string().min(1),
        groups: z.array(z.string()).optional().describe("Group usernames; omit to move every group assigned to fromAccount"),
        fromAccount: z.string().optional(),
        campaign: z.string().default("web"),
      },
    },
    async ({ toAccount, groups: names, fromAccount, campaign }) => {
      const known = listAccounts().map((a) => a.name);
      if (!known.includes(toAccount as string)) {
        throw new Error(`No saved account "${toAccount}". Saved: ${known.join(", ") || "none"}.`);
      }
      const roster = loadGroups(campaign as string);
      const want = names ? new Set((names as string[]).map((n) => n.replace(/^@/, ""))) : null;
      const moved: string[] = [];
      for (const g of roster) {
        if (want && !want.has(g.username)) continue;
        if (!want && fromAccount && g.account !== fromAccount) continue;
        if (g.account === toAccount) continue;
        g.account = toAccount as string;
        moved.push("@" + g.username);
      }
      saveGroups(roster, campaign as string);
      return { movedTo: toAccount, moved, count: moved.length };
    },
  );
}
