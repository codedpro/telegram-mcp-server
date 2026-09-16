#!/usr/bin/env node
/**
 * One tick of business-owner outreach, for cron.
 *
 * This never had a cron. campaign-tick.mjs and jobs-tick.mjs did, but direct
 * outreach to leads only ever ran as a hand-typed script in a scratchpad —
 * which is exactly why it silently stopped for a week and the state (who was
 * contacted) evaporated with the session that wrote it. src/leads.ts is the
 * fix for the second half; this script is the fix for the first half.
 *
 * Deliberately slow. A DM to a stranger is a much heavier spam signal than a
 * group post, and this account has already been PEER_FLOOD-locked once from
 * outreach running too fast. One lead per tick, ticks hours apart.
 *
 * Self-pausing like the campaign ticks: a PEER_FLOOD writes a lock file and
 * every tick after that is a no-op until it is cleared by hand, rather than
 * hammering a locked account every few hours for a week.
 *
 * cron: every 3 hours, at minute 17 -- /usr/bin/node scripts/leads-tick.mjs >> data/leads/tick.log 2>&1
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

    const next = await call("telegram_leads_list", { status: "new", limit: 1 });
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
