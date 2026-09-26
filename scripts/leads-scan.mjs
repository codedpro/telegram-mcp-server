#!/usr/bin/env node
/**
 * Refreshes the lead CRM by reading the rooms in data/leads/sources.json.
 *
 * Read-only: it joins nothing and posts nothing. Most public groups can be read
 * without membership, and the rooms that yield business owners are often the
 * ones that delete our ads, so being a lead source and being an ad room are
 * separate lists. New people land in the CRM as "new"; nobody is messaged —
 * the send queue is still filled by hand.
 *
 * usage: node scripts/leads-scan.mjs [days]   (weekly on cron)
 */
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const DAYS = Number(process.argv[2] ?? 8);
const logPath = join(root, "data", "leads", "scan.log");
const log = (m) => appendFileSync(logPath, `${new Date().toLocaleString("sv-SE")}  ${m}\n`);

async function main() {
  const { rooms } = JSON.parse(readFileSync(join(root, "data", "leads", "sources.json"), "utf8"));
  const client = new Client({ name: "leads-scan", version: "1" });
  await client.connect(
    new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "index.js")], env: process.env, cwd: root }),
  );
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 1_800_000, maxTotalTimeout: 1_800_000 });
    return r.isError ? { err: r.content[0].text } : JSON.parse(r.content[0].text);
  };

  try {
    await call("telegram_connect_all_accounts");
    await call("telegram_switch_account", { name: "default" });
    let ads = 0;
    const failed = [];
    for (const room of rooms) {
      const r = await call("telegram_find_advertisers", { chat: "@" + room, days: DAYS, maxPerChat: 800, save: true });
      if (r.err) failed.push(room);
      else ads += r.totals?.adPosts ?? 0;
      await new Promise((res) => setTimeout(res, 3000));
    }
    const sync = await call("telegram_leads_sync");
    log(`scanned ${rooms.length - failed.length}/${rooms.length} rooms, ${ads} ad posts, sync ${JSON.stringify(sync)}${failed.length ? `, unreadable: ${failed.join(" ")}` : ""}`);
  } finally {
    await Promise.race([client.close().catch(() => {}), new Promise((r) => setTimeout(r, 5_000).unref())]);
  }
}

main().catch((err) => {
  log(`scan error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
  process.exitCode = 1;
});
