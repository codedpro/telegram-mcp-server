#!/usr/bin/env node
/**
 * Scan the freelance folder for jobs that have not been seen before.
 *
 * This existed only as something run by hand, which is why job discovery
 * stopped the moment nobody ran it — the advertising side had a cron and this
 * did not.
 *
 * The ledger does the work: every post a previous scan surfaced is skipped,
 * including the same job cross-posted into a dozen channels, so a run that
 * finds nothing new prints one line and costs nothing. Only genuinely new
 * postings reach the report.
 *
 * cron:  30 9,21 * * *  /usr/bin/node scripts/jobs-tick.mjs >> data/scans/jobs.log 2>&1
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = join(root, "data", "scans", "new-jobs.md");
const clientsPath = join(root, "data", "scans", "new-clients.md");

const stamp = () => new Date().toLocaleString("sv-SE");
const log = (m) => console.log(`${stamp()}  ${m}`);

/** Engineering coursework and content gigs dressed as dev work. */
const NOISE =
  /متلب|matlab|سیمولینک|انسیس|فلوئنت|پروتئوس|کامسول|اباکوس|کدویژن|آردوینو|پایان ?نامه|پروپوزال|تدوین|افتر ?افکت|کپکات|گرافیست|پاورپوینت|ترجمه|موشن|ادیت ?ویدیو|ادمین ?(پیج|اینستاگرام)|سوشیال|مشاور ?(فروش|تحصیلی)|ویزیتور|فروشنده|منشی|سناریو|معما|کنکور|مکانیک|عمران|هوافضا|بازاریاب/i;
/** People advertising themselves. An ad and a CV read almost identically. */
const SEEKER =
  /دنبال (فرصت|کار|همکاری)|جویای کار|آماده(‌ی)? همکاری|اعلام آمادگی|#انجام_?دهنده/i;

/** Roughly "how close is this to what he actually sells". */
const SCORE = [
  [/وردپرس|wordpress|ووکامرس/i, 10, "WordPress"],
  [/فرانت|front.?end|react|next\.?js|فول ?استک|full.?stack/i, 9, "Frontend"],
  [/سئو|seo/i, 8, "SEO"],
  [/لاراول|laravel|\bphp\b/i, 7, "PHP"],
  [/پایتون|python|django|fastapi/i, 7, "Python"],
  [/بک ?اند|back.?end|node|\bapi\b|دیتابیس/i, 6, "Backend"],
  [/هوش ?مصنوعی|\bai\b|\bllm\b|automation/i, 5, "AI"],
  [/ربات ?تلگرام/i, 5, "Bot"],
];

/**
 * Someone asking for what we sell (a site, a shop, SEO, marketing, AI work) —
 * a customer to message, as opposed to a job to apply for. Staff hiring and
 * freelancers advertising themselves are excluded; nobody is messaged
 * automatically, this only feeds the hand-picked DM queue.
 */
const CLIENT_NEED =
  /(طراحی|طراح|ساخت|راه ?اندازی|ایجاد|بازطراحی|توسعه|پشتیبانی) ?(یک |یه )?(سایت|وب ?سایت|فروشگاه|اپلیکیشن|ربات|لندینگ)|سئو|\bseo\b|دیجیتال ?مارکتینگ|digital marketing|گوگل ادز|google ads|وردپرس|wordpress|ووکامرس|فروشگاه (اینترنتی|آنلاین)|سایت (فروشگاهی|شرکتی|شخصی|اختصاصی|کلینیک)|چت ?بات|chatbot|website|e-?commerce|web ?(developer|design(er)?)|shopify|woocommerce|landing page|online store|need (a|an) (site|developer|designer)|looking for (a|an) (web|wordpress|shopify|seo)/i;
/** Hiring posts for roles we do not sell, and referral schemes. */
const OFF_TARGET =
  /ادمین|تولید (و انتشار )?محتوا|ادیتور|تماس[_ ]?تلفنی|انجام ?دهنده|کار ?آموز|آهنگ|نماهنگ|پورسانت|درصد مبلغ|معرفی کنن|مسئول[_ ]?کنترل|سوشال ?مدیا|برندینگ/i;
const STAFF_HIRE = /استخدام|حقوق|بیمه|تمام ?وقت|پاره ?وقت|حضوری|ساعت کاری|وزارت کار|full.?time|part.?time|salary|محل کار/i;
const SELLS_SELF = /انجام ?(می ?دهم|میدم|میشه)|سفارش ?(می ?پذیرم|پذیرفته)|پذیرش سفارش|اکانت|اشتراک|خدمات ما|تخفیف ویژه/i;

const CHANNELS =
  /^@(cproje|Hajifreelance|doorkarijoo|mihan_proje|project_board|FreelancerH|Daneshjoo_Com|freelancer_job|DorkariLand|SevenProzhe|ProzheLancer|weproje|Freelaancing|AloFreelancer|AloJobs|uprojeh|projeh_2400|freelancer_booth|doorkaari|kardidjob|Freelancersho_ir|tarahanwebsitee|Collegian_Projection)$/i;

async function main() {
  mkdirSync(join(root, "data", "scans"), { recursive: true });
  const client = new Client({ name: "jobs-tick", version: "1" });
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
      timeout: 2_400_000,
      maxTotalTimeout: 2_400_000,
    });
    return { err: Boolean(r.isError), text: r.content[0].text };
  };

  try {
    await call("telegram_connect_all_accounts");
    // به حسابِ مشخص سوئیچ کن، نه «هرچه فعال است». یک اجرای دیگر ممکن است حسابِ
    // فعال را عوض کرده باشد، و پوشه‌ها و عضویت‌ها متعلق به یک حسابِ خاص‌اند.
    await call("telegram_switch_account", { name: "default" });
    const scan = await call("telegram_scan_folder", { folder: "freelance", days: 2, maxPerChat: 600 });
    if (scan.err) {
      log(`scan failed: ${scan.text.replace(/\s+/g, " ").slice(0, 140)}`);
      process.exitCode = 1;
      return;
    }
    const s = JSON.parse(scan.text);
    if (!s.totals.matched) {
      log(`nothing new (skipped ${s.ledger.skippedAlreadySeen} already seen)`);
      return;
    }

    const read = await call("telegram_read_scan", {
      id: s.id,
      openJobsOnly: true,
      limit: 200,
      maxChars: 400,
    });
    if (read.err) {
      log(`read failed: ${read.text.slice(0, 120)}`);
      return;
    }

    const ranked = [];
    for (const item of JSON.parse(read.text).items) {
      if (NOISE.test(item.text) || SEEKER.test(item.text)) continue;
      let score = 0;
      const tags = [];
      for (const [re, pts, tag] of SCORE) {
        if (re.test(item.text)) { score += pts; tags.push(tag); }
      }
      if (!score) continue;
      const handles = [...new Set(item.text.match(/@[A-Za-z0-9_]{4,}/g) ?? [])].filter((h) => !CHANNELS.test(h));
      // بدون راه تماس مستقیم، این آگهی به درد نمی‌خورد: نقطه‌ی کلِ سیستم رسیدن به
      // خودِ آدم است، نه فرستادن او به یک فرم در آپ‌ورک یا لینکدین.
      if (!handles.length) continue;
      ranked.push({ ...item, score, tags, contact: handles[0] });
    }
    ranked.sort((a, b) => b.score - a.score);

    const clients = [];
    for (const item of JSON.parse(read.text).items) {
      const t = item.text ?? "";
      if (!CLIENT_NEED.test(t) || OFF_TARGET.test(t) || STAFF_HIRE.test(t) || SEEKER.test(t) || SELLS_SELF.test(t)) continue;
      const handles = [...new Set(t.match(/@[A-Za-z0-9_]{5,}/g) ?? [])].filter((h) => !CHANNELS.test(h) && !/bot$/i.test(h));
      if (handles.length) clients.push({ ...item, contact: handles[0] });
    }
    if (clients.length) {
      const block = [`\n## ${stamp()} — ${clients.length} possible customers, scan ${s.id}\n`];
      for (const j of clients) block.push(`- ${j.contact} — ${j.link}\n  ${j.text.replace(/\s+/g, " ").slice(0, 220)}`);
      appendFileSync(clientsPath, block.join("\n") + "\n");
    }
    log(`${clients.length} possible customers -> ${clientsPath}`);

    log(`${s.totals.matched} new, ${ranked.length} worth a look (skipped ${s.ledger.skippedAlreadySeen} already seen)`);
    if (!ranked.length) return;

    const lines = [`\n## ${stamp()} — scan ${s.id}\n`];
    for (const j of ranked.slice(0, 25)) {
      lines.push(`- **[${j.score}] ${j.tags.join("+")}** ${j.contact ?? "(no handle)"} — ${j.link}`);
      lines.push(`  ${j.text.replace(/\s+/g, " ").slice(0, 200)}`);
      log(`  [${j.score}] ${(j.contact ?? "(no handle)").padEnd(24)} ${j.text.replace(/\s+/g, " ").slice(0, 70)}`);
    }
    appendFileSync(reportPath, lines.join("\n") + "\n");
    log(`appended to ${reportPath}`);
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch((err) => {
  log(`tick error: ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
  process.exitCode = 1;
});
