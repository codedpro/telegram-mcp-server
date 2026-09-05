import { resolve } from "node:path";

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  daysSince, lastPostTo, loadCopy, loadGroups, loadLedger, planAhead, planNext,
  recordPost, render, saveGroups,
} from "../campaign.js";
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
      inputSchema: {},
    },
    async () => {
      const groups = loadGroups();
      const copy = loadCopy();
      const ledger = loadLedger();
      const ok = ledger.posts.filter((p) => !p.error);
      return {
        offer: copy.offer,
        variants: copy.variants.length,
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
      },
    },
    async ({ count, showText }) => {
      const copy = loadCopy();
      const plans = planAhead(loadGroups(), copy, loadLedger(), count as number);
      return {
        planned: plans.length,
        posts: plans.map((p, i) => ({
          order: i + 1,
          group: "@" + p.group.username,
          account: p.group.account,
          variant: p.variant.id,
          angle: p.variant.angle,
          reason: p.reason,
          ...(showText ? { text: render(p.variant.text, copy.offer) } : {}),
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
      },
    },
    async ({ dryRun, group }) => {
      const groups = loadGroups();
      const copy = loadCopy();
      const ledger = loadLedger();

      const plan = group
        ? (() => {
            const g = groups.find((x) => x.username === String(group).replace(/^@/, ""));
            if (!g) throw new Error(`"${group}" is not in the roster.`);
            if (!g.enabled) throw new Error(`@${g.username} is disabled: ${g.note ?? "no reason recorded"}`);
            return planNext([g], copy, ledger);
          })()
        : planNext(groups, copy, ledger);

      if (!plan) {
        return { posted: false, reason: "Nothing is due. Every enabled group is still inside its cooldown." };
      }
      const text = render(plan.variant.text, copy.offer);
      if (dryRun) {
        return { posted: false, dryRun: true, group: "@" + plan.group.username, variant: plan.variant.id, reason: plan.reason, text };
      }
      if (plan.group.account !== activeAccount()) {
        throw new Error(
          `@${plan.group.username} is assigned to account "${plan.group.account}" but "${activeAccount()}" is active. Switch with telegram_switch_account, or reassign with telegram_campaign_reassign.`,
        );
      }

      const client = await getAuthorizedClient();
      try {
        // متن‌تنها و متن+تصویر را قاطی می‌کنیم: شش آگهیِ پشت‌سرهم با یک قالبِ ثابت،
        // خودش یک الگوی قابلِ تشخیص است.
        const target = peer("@" + plan.group.username);
        const sent = plan.variant.image
          ? await client.sendFile(target, { file: resolve(plan.variant.image), caption: text })
          : await client.sendMessage(target, { message: text });
        recordPost(ledger, {
          group: plan.group.username,
          variant: plan.variant.id,
          account: plan.group.account,
          at: new Date().toISOString(),
          messageId: sent.id,
        });
        return {
          posted: true,
          group: "@" + plan.group.username,
          variant: plan.variant.id,
          withImage: Boolean(plan.variant.image),
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
        });
        throw err;
      }
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
      },
    },
    async ({ toAccount, groups: names, fromAccount }) => {
      const known = listAccounts().map((a) => a.name);
      if (!known.includes(toAccount as string)) {
        throw new Error(`No saved account "${toAccount}". Saved: ${known.join(", ") || "none"}.`);
      }
      const roster = loadGroups();
      const want = names ? new Set((names as string[]).map((n) => n.replace(/^@/, ""))) : null;
      const moved: string[] = [];
      for (const g of roster) {
        if (want && !want.has(g.username)) continue;
        if (!want && fromAccount && g.account !== fromAccount) continue;
        if (g.account === toAccount) continue;
        g.account = toAccount as string;
        moved.push("@" + g.username);
      }
      saveGroups(roster);
      return { movedTo: toAccount, moved, count: moved.length };
    },
  );
}
