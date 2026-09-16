import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  BUSINESS_TYPES, blacklist, blacklistByKey, draftOutreach, findByUsername,
  loadCrm, markContacted, rankLeads, saveCrm, syncFromRawLeads,
} from "../leads.js";
import { gate } from "../throttle.js";
import { getAuthorizedClient } from "../telegram.js";
import { peer, tool } from "./util.js";

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
        businessKey: z.string().optional().describe(`One of: ${BUSINESS_TYPES.map((t) => t.key).join(", ")}`),
        limit: z.number().int().min(1).max(200).default(30),
      },
    },
    async ({ status, businessKey, limit }) => {
      const crm = loadCrm();
      let leads = status === "all" ? Object.values(crm.entries) : rankLeads(crm, { status: status === "new" ? undefined : (status as never) });
      if (status === "new") leads = rankLeads(crm).filter((e) => e.status === "new");
      if (businessKey) leads = leads.filter((e) => e.businessKey === businessKey);
      return {
        total: leads.length,
        leads: leads.slice(0, limit as number).map((e) => ({
          senderId: e.senderId, username: e.username ? "@" + e.username : null, name: e.name,
          businessType: e.businessType, posts: e.posts, groups: e.chats, status: e.status,
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
      },
    },
    async ({ username, account }) => {
      const crm = loadCrm();
      const lead = findByUsername(crm, username as string);
      if (!lead) throw new Error(`"${username}" is not in the lead CRM. Run telegram_leads_sync first.`);
      if (lead.status === "blacklisted") {
        throw new Error(`@${lead.username} is blacklisted (${lead.blacklistReason ?? "no reason recorded"}).`);
      }
      const client = await getAuthorizedClient(account as string);
      const paced = await gate("leads_send");
      const text = draftOutreach(lead);
      const sent = await client.sendMessage(peer("@" + lead.username), { message: text });
      markContacted(crm, lead.senderId, account as string);
      saveCrm(crm);
      return { sent: true, to: "@" + lead.username, waitedMs: paced.waitedMs, messageId: sent.id };
    },
  );
}
