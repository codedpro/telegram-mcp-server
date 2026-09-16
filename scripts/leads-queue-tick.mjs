#!/usr/bin/env node
/**
 * One attempt at the next queued lead, for one account, on cron.
 *
 * Unlike the old leads-tick.mjs (removed), this never picks who to message —
 * that list was hand-built by telegram_leads_queue_add after a person read
 * the actual posts. This script only works through it, in order, respecting
 * that account's own backoff state.
 *
 * cron, one line per account, every 10 minutes:
 *   /usr/bin/node scripts/leads-queue-tick.mjs default  >> data/leads/queue.log 2>&1
 *   /usr/bin/node scripts/leads-queue-tick.mjs outreach >> data/leads/queue.log 2>&1
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ACCOUNT = process.argv[2];
if (!ACCOUNT) {
  console.error("usage: leads-queue-tick.mjs <account>");
  process.exit(1);
}

const stamp = () => new Date().toLocaleString("sv-SE");
const log = (m) => console.log(`${stamp()}  [${ACCOUNT}] ${m}`);

async function main() {
  mkdirSync(join(root, "data", "leads"), { recursive: true });
  const client = new Client({ name: "leads-queue-tick", version: "1" });
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

    const r = await call("telegram_leads_queue_tick", { account: ACCOUNT });
    if (r.err) { log(`error: ${r.text.slice(0, 160)}`); process.exitCode = 1; return; }
    const j = JSON.parse(r.text);

    if (!j.attempted) {
      log(j.reason ? j.reason : `not eligible yet (stage=${j.stage}, next at ${j.nextAttemptAt})`);
      return;
    }
    if (j.sent) {
      log(`sent to ${j.to} (waited ${Math.round((j.waitedMs ?? 0) / 1000)}s) msg=${j.messageId}`);
      return;
    }
    if (j.blocked) {
      log(`blocked -> stage=${j.stage}, next attempt ${j.nextAttemptAt}`);
      return;
    }
    log(`unexpected result: ${JSON.stringify(j).slice(0, 160)}`);
  } finally {
    await Promise.race([
      client.close().catch(() => {}),
      new Promise((r) => setTimeout(r, 5_000).unref()),
    ]);
  }
}

main().catch((err) => {
  log(`tick error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
  process.exitCode = 1;
});
