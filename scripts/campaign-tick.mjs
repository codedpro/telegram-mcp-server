#!/usr/bin/env node
/**
 * One tick of the advertising rotation, for cron.
 *
 * Deliberately dumb: it asks the server what is due and posts at most one ad,
 * then exits. All the judgement — which group has waited long enough, which
 * copy that group has not seen, the gap between outward actions — already lives
 * in the server, and duplicating any of it here is how the two copies drift
 * apart. So this drives the same tool a human would call.
 *
 * Run it often. Most ticks post nothing, because every group is inside its
 * cooldown, and that is the intended behaviour rather than a wasted run.
 *
 * Two failures are handled rather than retried, because retrying makes both
 * worse:
 *   CHAT_WRITE_FORBIDDEN — we cannot post there at all, so the group is
 *     disabled in the roster instead of failing again every few hours.
 *   PEER_FLOOD / FLOOD_WAIT — the account is rate limited, so the tick stops
 *     and leaves the rotation for the next run.
 *
 * cron:  0 9,13,17,21 * * *  cd /path/to/telegram-mcp-server && node scripts/campaign-tick.mjs >> data/campaign/tick.log 2>&1
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const rosterPath = join(root, "data", "campaign", "roster.json");

/**
 * Local time, not UTC. cron fires on the machine's clock, so a UTC log makes
 * every entry look like it ran at the wrong hour and sends you hunting for a
 * scheduling bug that is not there.
 */
const stamp = () =>
  new Date().toLocaleString("sv-SE", { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
const log = (msg) => {
  const line = `${stamp()}  ${msg}`;
  console.log(line);
};

/** A group we are forbidden from posting in will never become postable by retrying. */
function disableGroup(username, reason) {
  try {
    const roster = JSON.parse(readFileSync(rosterPath, "utf8"));
    const group = roster.groups.find((g) => g.username === username);
    if (!group || !group.enabled) return false;
    group.enabled = false;
    group.note = `AUTO-DISABLED ${stamp()}: ${reason}`;
    writeFileSync(rosterPath, JSON.stringify(roster, null, 2));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  mkdirSync(join(root, "data", "campaign"), { recursive: true });

  const client = new Client({ name: "campaign-tick", version: "1" });
  // cwd صراحتاً ست می‌شود: سرور مسیرهای data/ را از working directory می‌سازد،
  // و cron از $HOME اجرا می‌کند. بدون این، تیک روی دفترچه‌ی اشتباهی می‌نویسد.
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(root, "dist", "index.js")],
      env: process.env,
      cwd: root,
    }),
  );

  const call = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args }, undefined, {
      timeout: 1_500_000,
      maxTotalTimeout: 1_500_000,
    });
    return { err: Boolean(res.isError), text: res.content[0].text };
  };

  try {
    await call("telegram_connect_all_accounts");
    // به حسابِ مشخص سوئیچ کن، نه «هرچه فعال است». یک اجرای دیگر ممکن است حسابِ
    // فعال را عوض کرده باشد، و پوشه‌ها و عضویت‌ها متعلق به یک حسابِ خاص‌اند.
    await call("telegram_switch_account", { name: "default" });

    const preview = await call("telegram_campaign_post_next", { dryRun: true });
    if (preview.err) {
      log(`skip: ${preview.text.replace(/\s+/g, " ").slice(0, 140)}`);
      return;
    }
    const plan = JSON.parse(preview.text);
    if (!plan.group) {
      log(`nothing due — ${plan.reason ?? "every group is inside its cooldown"}`);
      return;
    }

    const result = await call("telegram_campaign_post_next");
    if (!result.err) {
      const posted = JSON.parse(result.text);
      log(`posted ${posted.group} ${posted.variant}${posted.withImage ? " +image" : ""} msg=${posted.messageId}`);
      return;
    }

    const message = result.text.replace(/\s+/g, " ");
    // گروه‌هایی که برای پست‌کردن پول می‌گیرند، با تلاش دوباره رایگان نمی‌شوند.
    if (/ALLOW_PAYMENT_REQUIRED|CHAT_SEND_PLAIN_FORBIDDEN/.test(message)) {
      const off = disableGroup(plan.group.replace(/^@/, ""), "charges to post: " + message.slice(0, 70));
      log(`${plan.group}: paid posting${off ? " — disabled in roster" : ""}`);
      return;
    }
    if (/CHAT_WRITE_FORBIDDEN|USER_BANNED_IN_CHANNEL|CHANNEL_PRIVATE/.test(message)) {
      const off = disableGroup(plan.group.replace(/^@/, ""), message.slice(0, 90));
      log(`${plan.group}: cannot post${off ? " — disabled in roster" : ""} (${message.slice(0, 90)})`);
      return;
    }
    // slowmode یعنی «الان نه»، نه «هرگز». گروه سالم است؛ نوبتِ بعدی می‌گیردش.
    if (/SLOWMODE_WAIT/.test(message)) {
      log(`${plan.group}: slow mode, skipping this tick`);
      return;
    }
    if (/PEER_FLOOD|FLOOD_WAIT/.test(message)) {
      log(`rate limited, stopping this tick: ${message.slice(0, 110)}`);
      process.exitCode = 1;
      return;
    }
    log(`failed ${plan.group}: ${message.slice(0, 140)}`);
    process.exitCode = 1;
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((err) => {
  const line = `${stamp()}  tick error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`;
  console.log(line);
  try {
    appendFileSync(join(root, "data", "campaign", "tick-errors.log"), line + "\n");
  } catch {
    // logging must never be the reason a tick fails
  }
  process.exitCode = 1;
});
