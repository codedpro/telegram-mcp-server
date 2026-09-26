import { join } from "node:path";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = "/home/website-dev/telegram-mcp-server";
const LOG = process.argv[2];
const log = (s) => appendFileSync(LOG, `${new Date().toISOString().slice(11, 19)} ${s}\n`);
const scan = JSON.parse(readFileSync(process.argv[3], "utf8"));

const PLAN = [
  { account: "default", username: "Divar_IRANIANS_UK", region: "uk", ref: "دیوار" },
  { account: "outreach", username: "NiyazmandiArmenia", region: "am", ref: "نیازمندی" },
  { account: "default", username: "IraniaManchester", region: "uk", ref: "منچستر" },
  { account: "outreach", username: "whmfi", region: "ca", ref: "بی‌سی" },
  { account: "default", username: "iranianlondonn", region: "uk", ref: "لندن" },
  { account: "outreach", username: "TORONTO_NEEDS", region: "ca", ref: "تورنتو" },
  { account: "default", username: "kingbravezoro47", region: "am", ref: "ایروان" },
  { account: "outreach", username: "PlazayeIranianToronto", region: "ca", ref: "پلازا" },
];

const c = new Client({ name: "join", version: "1" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "index.js")], env: process.env, cwd: root }));
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 2_400_000, maxTotalTimeout: 2_400_000 });
  return r.isError ? { __e: r.content[0].text } : JSON.parse(r.content[0].text);
};
await call("telegram_connect_all_accounts");

const rosterPath = `${root}/data/campaign/web/roster.json`;
for (const p of PLAN) {
  await call("telegram_switch_account", { name: p.account });
  const r = await call("telegram_join_chat", { target: "@" + p.username });
  if (r.__e) { log(`FAIL ${p.account} @${p.username}: ${r.__e.slice(0, 140)}`); continue; }
  const s = scan.find((x) => x.username === p.username) ?? {};
  const roster = JSON.parse(readFileSync(rosterPath, "utf8"));
  if (!roster.groups.some((g) => g.username.toLowerCase() === p.username.toLowerCase())) {
    roster.groups.push({
      username: p.username, title: s.title ?? p.username, region: p.region, lang: "fa",
      members: s.members ?? 0, slowmodeSeconds: s.slowmode ?? 0, minDaysBetween: 3,
      account: p.account, enabled: true, ref: p.ref,
      note: `added 2026-09-26 after outside scan: ${s.people ?? "?"} advertisers in 30d, rules allow business ads`,
    });
    writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
  }
  log(`joined ${p.account} @${p.username} (waited ${Math.round((r.waitedMs ?? 0) / 1000)}s), added to web roster`);
}
log("DONE");
await Promise.race([c.close().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
