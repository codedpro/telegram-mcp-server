#!/usr/bin/env node
/**
 * Send outreach to the next unreviewed lead in the CRM. NOT on a cron.
 *
 * It was, briefly, and that was the wrong call: it sent to whoever a formula
 * ranked highest, and the formula turned out to be wrong in a way only a
 * person reading the actual post would catch — a business that advertised
 * once is not automatically a worse lead than one that posts daily, it may
 * just not be drowning in cold pitches the way a heavy poster is. Deciding
 * who is worth a message is a judgment call per lead, not a score to
 * automate over, so this is now something a person (or an agent reading the
 * leads first with telegram_leads_list) runs on purpose, lead by lead.
 *
 * The one thing worth keeping from the cron version: it still self-locks on
 * PEER_FLOOD rather than being retried into a wall, and it still routes
 * through leads_send so the CRM and the rate gate stay authoritative.
 *
 * usage:  node scripts/leads-tick.mjs [account]   (reads and sends the next
 *         tier=priority lead; prefer picking a specific username by hand
 *         via telegram_leads_send once you have actually read their post)
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT = process.argv[2] ?? process.env.TELEGRAM_OUTREACH_ACCOUNT ?? "default";
const lockPath = join(root, "data", "leads", `outreach-${ACCOUNT}.lock.json`);

const stamp = () => new Date().toLocaleString("sv-SE");
const log = (m) => console.log(`${stamp()}  [${ACCOUNT}] ${m}`);

const readLock = () => {
  try { return JSON.parse(readFileSync(lockPath, "utf8")); } catch { return null; }
};

async function main() {
  mkdirSync(join(root, "data", "leads"), { recursive: true });

  const lock = readLock();
  if (lock) {
    log(`locked since ${lock.lockedAt} (${lock.reason}) — delete ${lockPath} to resume`);
    return;
  }

  const client = new Client({ name: "leads-tick", version: "1" });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "dist", "index.js")],
      env: process.env,
      cwd: root,
    }),
  );
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 1_500_000, maxTotalTimeout: 1_500_000,
    });
    return { err: Boolean(r.isError), text: r.content[0].text };
  };

  try {
    await call("telegram_connect_all_accounts");
    await call("telegram_switch_account", { name: ACCOUNT });

    const next = await call("telegram_leads_list", { status: "new", tier: "priority", limit: 1 });
    if (next.err) { log(`list failed: ${next.text.slice(0, 140)}`); return; }
    const lead = JSON.parse(next.text).leads[0];
    if (!lead) { log("no new leads left in the CRM — run telegram_leads_sync after the next find_advertisers scan"); return; }

    const r = await call("telegram_leads_send", { username: lead.username, account: ACCOUNT });
    if (!r.err) {
      const sent = JSON.parse(r.text);
      log(`sent to ${sent.to} (waited ${Math.round((sent.waitedMs ?? 0) / 1000)}s) msg=${sent.messageId}`);
      return;
    }

    const message = r.text.replace(/\s+/g, " ");
    if (/PEER_FLOOD|FLOOD_WAIT/.test(message)) {
      writeFileSync(lockPath, JSON.stringify({ lockedAt: stamp(), reason: message.slice(0, 160) }, null, 2));
      log(`locked: ${message.slice(0, 140)}`);
      process.exitCode = 1;
      return;
    }
    log(`failed ${lead.username}: ${message.slice(0, 140)}`);
    process.exitCode = 1;
  } finally {
    await Promise.race([
      client.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 5_000).unref()),
    ]);
  }
}

main().catch((err) => {
  const line = `${stamp()}  [${ACCOUNT}] tick error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
  console.log(line);
  try { appendFileSync(join(root, "data", "leads", "tick-errors.log"), line + "\n"); } catch {}
  process.exitCode = 1;
});
