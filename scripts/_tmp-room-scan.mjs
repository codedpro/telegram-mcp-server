import { join } from "node:path";
import { appendFileSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = "/home/website-dev/telegram-mcp-server";
const OUT = process.argv[2];
const LOG = OUT.replace(/\.json$/, ".log");
const log = (s) => { appendFileSync(LOG, `${new Date().toISOString().slice(11, 19)} ${s}\n`); };

const LEFT_TO_RECHECK = [
  "Iranian_UK", "niazmandihayeuk", "iraniane_london", "istdubai", "iran_emirate", "iranianresidentuae", "omanir",
  "fanofa_canada", "VancouverIranian", "iranian_berlin", "Iranians_german", "safirearyaei1", "irtrreklam",
  "iranianmoghimistanbul", "iranian_armenia", "Niazmandi_Armenia",
];
const KEEP = new Set(["khaneiranianis", "residentiraniansofvacouver", "amoofaridd", "birminghamiraniancommunity", "fanofa_uk",
  "iranianeusa", "iranihaiemanchester", "iranianevancouver", "iranihaietoronto", "iranianebirmingham"]);
const DEAD = new Set(["tabligh2025tajrobh", "tablighatdokorasioniranian", "kiyanex", "saraffi_peivandi", "sarafionline7groupuk",
  "chatgpt_jwgpt3_fa", "ai_ml_dl_inf", "pyfarsi", "group_pydev", "group_programmer", "promptallgap", "aicommunityir", "iranianemogimearmanestan"]);

const QUERIES = [
  "ایرانیان لندن", "نیازمندی لندن", "ایرانیان انگلیس", "نیازمندیهای انگلیس", "ایرانیان بریتانیا",
  "ایرانیان بیرمنگام", "ایرانیان منچستر", "ایرانیان گلاسکو", "ایرانیان لیدز", "ایرانیان نیوکاسل", "ایرانیان لیورپول",
  "ایرانیان تورنتو", "نیازمندی تورنتو", "ایرانیان ونکوور", "ایرانیان مونترال", "ایرانیان کانادا",
  "ایرانیان دبی", "نیازمندی دبی", "ایرانیان امارات",
  "ایرانیان استانبول", "نیازمندی استانبول", "ایرانیان ترکیه", "ایرانیان آنکارا", "ایرانیان آنتالیا",
  "ایرانیان ایروان", "نیازمندی ارمنستان", "ایرانیان تفلیس", "ایرانیان گرجستان",
  "ایرانیان آلمان", "ایرانیان هامبورگ", "ایرانیان مونیخ", "ایرانیان سوئد", "ایرانیان هلند", "ایرانیان اتریش",
  "ایرانیان استرالیا", "ایرانیان سیدنی", "ایرانیان ملبورن", "ایرانیان آمریکا", "ایرانیان لس آنجلس",
  "Iranians in London", "Iranians UK", "Persian London", "Iranians Toronto", "Iranians Dubai", "Iranians Istanbul",
];
const SKIP_NAME = /صراف|ارز|exchange|sarafi|حواله|crypto|کریپتو|فارکس|forex|بورس/i;
const MIN_MEMBERS = 1500;

const c = new Client({ name: "room-scan", version: "1" });
await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, "dist", "index.js")], env: process.env, cwd: root }));
const call = async (name, args = {}) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 1_800_000, maxTotalTimeout: 1_800_000 });
  return r.isError ? { __e: r.content[0].text } : JSON.parse(r.content[0].text);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await call("telegram_connect_all_accounts");
await call("telegram_switch_account", { name: "default" });

const cands = new Map();
for (const u of LEFT_TO_RECHECK) cands.set(u.toLowerCase(), { username: u, via: "left-recheck" });
for (const q of QUERIES) {
  const r = await call("telegram_search_chats", { query: q, limit: 30 });
  if (r.__e) { log(`search "${q}" ERR ${r.__e.slice(0, 100)}`); await sleep(15000); continue; }
  let added = 0;
  for (const ch of r.chats ?? []) {
    if (!ch.username || ch.kind !== "supergroup") continue;
    if ((ch.participantsCount ?? 0) < MIN_MEMBERS) continue;
    const k = ch.username.toLowerCase();
    if (KEEP.has(k) || DEAD.has(k) || cands.has(k)) continue;
    if (SKIP_NAME.test(ch.title ?? "") || SKIP_NAME.test(ch.username)) continue;
    cands.set(k, { username: ch.username, title: ch.title, members: ch.participantsCount, via: q });
    added++;
  }
  log(`search "${q}" -> +${added} (total ${cands.size})`);
  await sleep(2500);
}

const results = [];
const save = () => writeFileSync(OUT, JSON.stringify(results, null, 1));
for (const cand of cands.values()) {
  const info = await call("telegram_get_chat", { chat: "@" + cand.username });
  if (info.__e) { results.push({ ...cand, err: info.__e.slice(0, 120) }); log(`@${cand.username} get_chat ERR`); save(); continue; }
  const row = { ...cand, title: info.title, members: info.participantsCount, about: (info.about ?? "").slice(0, 300),
    slowmode: info.slowmodeSeconds ?? 0, joined: info.left === false };
  const scan = await call("telegram_find_advertisers", { chat: "@" + cand.username, days: 30, maxPerChat: 800, save: true });
  if (scan.__e) { row.scanErr = scan.__e.slice(0, 120); }
  else {
    const ch = scan.chats?.[0] ?? {};
    Object.assign(row, { scanned: ch.scanned ?? 0, adPosts: ch.ads ?? 0, people: scan.totals?.people ?? 0,
      withUsername: scan.totals?.withUsername ?? 0, file: scan.savedTo });
  }
  results.push(row);
  log(`@${cand.username} members=${row.members} scanned=${row.scanned ?? "-"} ads=${row.adPosts ?? "-"} people=${row.people ?? "-"} ${row.scanErr ? "ERR " + row.scanErr.slice(0, 60) : ""}`);
  save();
  await sleep(3000);
}
const sync = await call("telegram_leads_sync");
log(`leads_sync: ${JSON.stringify(sync).slice(0, 300)}`);
log("DONE");
await Promise.race([c.close().catch(() => {}), sleep(5000)]);
