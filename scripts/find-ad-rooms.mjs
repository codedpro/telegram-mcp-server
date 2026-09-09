#!/usr/bin/env node
/**
 * Find groups that will actually keep an advertisement, before joining any.
 *
 * The expensive way to learn this is the way we just did: join twenty rooms,
 * post forty ads, watch thirty-five get deleted, then read the descriptions and
 * discover most of them sell ad slots and run a moderation bot. Everything that
 * mattered was visible from outside without joining.
 *
 * Three signals, all readable on a public group:
 *   - the description says the room exists for advertising          → good
 *   - the description says "message @someone for ads"               → they sell it, free posts get removed
 *   - an anti-spam bot sits in the admin list (digi*bot and friends) → deletions are automated
 *
 * Prints a ranked shortlist and joins nothing. Deciding is a person's job.
 *
 * usage:  node scripts/find-ad-rooms.mjs [minMembers]
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIN = Number(process.argv[2] ?? 2000);
const outPath = join(root, "data", "ad-room-candidates.md");

/** Rooms that exist to carry advertising, in the languages these markets use. */
const QUERIES = [
  "تبلیغات رایگان", "گروه تبلیغاتی", "نیازمندیها", "دیوار",
  "advertise your business", "free advertising group", "promote your business",
  "classifieds group", "small business promotion", "business networking",
  "freelance services", "services marketplace", "buy and sell group",
  "expat community", "expats classifieds", "digital nomads",
  "reklam grubu", "ilan grubu", "إعلانات مجانية", "تسويق",
  "объявления", "реклама бесплатно", "барахолка",
  "anuncios gratis", "promocionar negocio",
];

/** The room is for ads. */
const WELCOMES = /تبلیغات|آگهی|نیازمندی|دیوار|بازار|advertis|promot|classified|ilan|reklam|إعلان|объявлен|реклам|anuncio|marketplace|buy ?and ?sell/i;
/** Ads are a product they sell, so free ones are removed. */
const SELLS = /برای تبلیغات (پیام|به)|جهت تبلیغات|تعرفه|هزینه تبلیغ|for (ads|advertis\w*) (contact|dm|message)|ad rates|قیمت تبلیغات|رزرو تبلیغ/i;
/** Commercial moderation bots. Their presence means deletions are automatic. */
const GUARD_BOT = /digi\d*bot|rose|combot|shieldy|group ?help|miss ?rose|safeguard|antispam/i;

async function main() {
  const client = new Client({ name: "find-ad-rooms", version: "1" });
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
      timeout: 2_400_000, maxTotalTimeout: 2_400_000,
    });
    return r.isError ? { __e: r.content[0].text } : JSON.parse(r.content[0].text);
  };

  try {
    await call("telegram_connect_all_accounts");
    await call("telegram_switch_account", { name: "default" });

    const found = new Map();
    for (const q of QUERIES) {
      const r = await call("telegram_search_chats", { query: q, limit: 25 });
      for (const ch of r.chats ?? []) {
        // Only supergroups: a channel will not take a member's post at all.
        if (!ch.username || ch.kind !== "supergroup") continue;
        if ((ch.participantsCount ?? 0) < MIN) continue;
        if (!found.has(ch.username)) found.set(ch.username, { ...ch, via: q });
      }
      await new Promise((r) => setTimeout(r, 700));
    }
    console.log(`${found.size} supergroups over ${MIN} members — screening\n`);

    const scored = [];
    for (const ch of found.values()) {
      const info = await call("telegram_get_chat", { chat: "@" + ch.username });
      // نبودِ جزئیات دلیلِ حذف نیست: عنوان و اندازه را از جست‌وجو داریم و همان
      // هم قابلِ امتیاز دادن است. نسخه‌ی قبلی ۴۷ از ۵۲ کاندید را همین‌جا دور ریخت.
      const about = info.__e ? "" : String(info.about ?? "");
      const detail = !info.__e;
      const admins = detail
        ? await call("telegram_get_members", { chat: "@" + ch.username, filter: "admins", limit: 15 })
        : { __e: "not checked" };
      const adminNames = admins.__e ? [] : admins.members.map((m) => `${m.username ?? ""} ${m.firstName ?? ""}`);
      const bots = adminNames.filter((n) => GUARD_BOT.test(n));

      let score = 0;
      const why = [];
      const title = info.__e ? (ch.title ?? "") : info.title;
      if (WELCOMES.test(`${title} ${about}`)) { score += 3; why.push("exists for ads"); }
      if (SELLS.test(about)) { score -= 4; why.push("sells ad slots"); }
      if (bots.length) { score -= 3; why.push(`moderation bot (${bots[0].trim()})`); }
      if (detail && (info.slowmodeSeconds ?? 0) > 600) { score -= 1; why.push(`slow mode ${info.slowmodeSeconds}s`); }
      if (detail && !about.trim()) { score -= 1; why.push("no description"); }
      if (!detail) why.push("details unreadable - screen after joining");

      scored.push({
        username: ch.username, title, members: (info.__e ? ch.participantsCount : info.participantsCount) ?? 0,
        score, why, slowmode: detail ? (info.slowmodeSeconds ?? 0) : 0, via: ch.via,
      });
    }
    scored.sort((a, b) => b.score - a.score || b.members - a.members);

    const lines = ["# Ad-room candidates\n", "Screened without joining. Score: +3 exists for ads, −4 sells slots, −3 moderation bot.\n",
      "| Group | Members | Score | Notes |", "| --- | --- | --- | --- |"];
    for (const s of scored) lines.push(`| @${s.username} | ${s.members} | ${s.score} | ${s.why.join("; ") || "—"} |`);
    writeFileSync(outPath, lines.join("\n") + "\n");

    for (const s of scored.slice(0, 30)) {
      console.log(`${String(s.score).padStart(3)}  ${String(s.members).padStart(7)}  @${s.username.padEnd(28)} ${s.why.join("; ").slice(0, 46)}`);
    }
    console.log(`\nwritten to ${outPath}`);
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exitCode = 1; });
