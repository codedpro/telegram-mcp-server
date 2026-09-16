import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Advertiser } from "./advertisers.js";

/**
 * The persistent business-owner CRM.
 *
 * find_advertisers writes a fresh, timestamped dump to data/leads/ every time it
 * runs — that is a scan, not a record of what happened. Who we contacted, who
 * replied, and who we have decided is not worth contacting again used to live
 * only in a throwaway scratchpad script, which is why it vanished the moment
 * that session ended and a week of outreach state was gone. This file is the
 * one place that memory now lives, keyed by senderId so it survives a changed
 * username.
 */
export const leadsDir = () => process.env.TELEGRAM_LEADS_DIR ?? join(process.cwd(), "data", "leads");
const crmPath = () => join(leadsDir(), "crm.json");

export type LeadStatus = "new" | "contacted" | "replied" | "blacklisted";

export interface BusinessType {
  key: string;
  fa: string;
  /** Roughly "how much a website/SEO engagement is worth to this trade". */
  value: number;
}

/** Ordered so the first regex to match wins — put more specific trades first. */
export const BUSINESS_TYPES: (BusinessType & { re: RegExp })[] = [
  { key: "clinic", fa: "درمان و کلینیک", value: 5, re: /دندان|ایمپلنت|کلینیک|پزشک|دکتر |مطب|فیزیوتراپ|روانشناس|dental|clinic|therapist|doctor/i },
  { key: "legal", fa: "مهاجرت و امور حقوقی", value: 5, re: /مهاجرت|ویزا|اقامت|وکیل|امور ?اداری|ترجمه ?رسمی|شهروندی|immigration|visa|solicitor|lawyer/i },
  { key: "education", fa: "آموزش و تدریس", value: 4, re: /تدریس|آموزش|کلاس|دوره|زبان ?انگلیسی|مدرس|آیلتس|tutor|teaching|course|ielts/i },
  { key: "realestate", fa: "املاک", value: 4, re: /املاک|اجاره|رهن|خرید ?خانه|آپارتمان|مسکن|real ?estate|property|rent|letting/i },
  { key: "trades", fa: "خدمات فنی و ساختمانی", value: 3, re: /تعمیر|نصب|برقکار|لوله ?کش|نقاش|بنا|ساختمان|نجار|کولر|تاسیسات|plumber|electrician|builder|handyman/i },
  { key: "food", fa: "غذا و رستوران", value: 3, re: /غذای ?خانگی|رستوران|کترینگ|کافه|شیرینی|نان ?|فست ?فود|منو|سفارش ?غذا|restaurant|catering|bakery/i },
  { key: "beauty", fa: "زیبایی و آرایش", value: 3, re: /آرایشگاه|سالن ?زیبایی|میکاپ|ناخن|کاشت ?مو|اپیلاسیون|barber|salon|beauty|makeup/i },
  { key: "transport", fa: "حمل‌ونقل و باربری", value: 3, re: /باربری|حمل ?و ?نقل|بار ?هوایی|کارگو|ارسال ?بار|ترخیص|cargo|shipping|freight|courier/i },
  { key: "retail", fa: "فروشگاه و واردات", value: 3, re: /سوپر ?مارکت|فروشگاه|پخش ?محصولات|واردات|عمده|خواروبار|بقالی|grocery|import|wholesale|shop/i },
  { key: "crypto", fa: "ارز دیجیتال", value: 2, re: /ارز ?دیجیتال|تتر|بیت ?کوین|کریپتو|crypto|bitcoin|usdt/i },
  // صرافی آخر است تا صرافی‌ای که هم آموزش یا ملک تبلیغ می‌کند، به آن دسته‌ی
  // ارزشمندتر برود، نه به صرافی.
  { key: "exchange", fa: "صرافی و انتقال ارز", value: 4, re: /صراف|نرخ ?(ارز|امروز)|حواله|ترانسفر|تبدیل ?ارز|exchange rate|money ?transfer|remittance/i },
];

export function classify(text: string): BusinessType | null {
  for (const t of BUSINESS_TYPES) if (t.re.test(text)) return { key: t.key, fa: t.fa, value: t.value };
  return null;
}

/** One line specific to the trade — this is what makes the message read as written for them. */
const PITCH: Record<string, string> = {
  exchange: "نرخ‌ها رو هر روز دستی توی گروه‌ها می‌فرستید. یک سایت با صفحه‌ی نرخ که خودکار آپدیت بشه، هم کار روزانه‌تون رو حذف می‌کنه و هم توی گوگل برای «صرافی» شهرتون دیده می‌شید.",
  food: "سفارش‌ها از دایرکت و واتساپ میاد و پیگیری‌شون سخته. یک سایت سفارش‌گیری ساده با منو، به‌علاوه دیده‌شدن توی گوگل مپ، سفارش‌ها رو مرتب می‌کنه.",
  clinic: "بیمار جدید معمولاً اول گوگل رو می‌گرده. یک سایت با صفحه‌ی خدمات و رزرو نوبت آنلاین، به‌علاوه سئوی محلی، ورودی بیمار رو از جست‌وجو میاره.",
  legal: "این حوزه کاملاً جست‌وجومحوره. یک سایت با صفحه‌ی جداگانه برای هر خدمت و فرم دریافت پرونده، سرنخ‌ها رو از گوگل مستقیم میاره سراغتون.",
  retail: "یک فروشگاه آنلاین با پرداخت و ارسال، فروش رو از محدوده‌ی گروه‌های تلگرام میاره بیرون.",
  beauty: "نوبت‌ها از دایرکت میاد و وقت می‌بره. یک صفحه‌ی رزرو آنلاین به‌علاوه دیده‌شدن در گوگل مپ، نوبت‌ها رو خودکار می‌کنه.",
  trades: "مشتری این کار رو توی گوگل سرچ می‌کنه، نه تلگرام. یک سایت کوچک با نمونه‌کار و فرم درخواست قیمت، به‌علاوه سئوی محلی، کار ثابت میاره.",
  transport: "یک سایت با فرم استعلام قیمت و صفحه‌ی مسیرها، هم استعلام‌ها رو منظم می‌کنه و هم برای جست‌وجوی حمل‌ونقل بالا میاردتون.",
  education: "یک صفحه‌ی دوره با ثبت‌نام آنلاین، به‌علاوه محتوای سئوشده، شاگرد رو از گوگل میاره به‌جای اینکه فقط از گروه بیاد.",
  realestate: "یک سایت با لیست ملک‌ها و فیلتر، به‌علاوه سئوی محلی، فایل‌هاتون رو جلوی کسی می‌ذاره که همین الان دنبال خونه‌ست.",
  crypto: "یک سایت با صفحه‌ی نرخ لحظه‌ای و اعتمادسازی (درباره‌ی ما، نظرات، مجوز) تفاوت بزرگی در جذب مشتری جدید می‌سازه.",
};

const GENERIC_FA = "یک سایت درست به‌علاوه دیده‌شدن در گوگل، معمولاً مشتری‌هایی رو میاره که هیچ‌وقت گروه‌های تلگرام رو نمی‌بینن.";

const firstName = (name: string): string => {
  const w = String(name || "")
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, " ")
    .split(/[\s._|/\\-]+/)
    .map((x) => x.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(Boolean);
  const titles = /^(dr|mr|mrs|ms|eng|prof|دکتر|مهندس|استاد|آقای|خانم)\.?$/i;
  const first = w.find((x) => !titles.test(x)) ?? "";
  return first.length >= 2 && /\p{L}/u.test(first) ? first : "";
};

/** Direct-message draft: names the group where the post was seen, then the trade-specific pitch. */
export function draftOutreach(lead: CrmEntry): string {
  const who = firstName(lead.name);
  const group = lead.chats[0] ?? "";
  const pitch = (lead.businessKey && PITCH[lead.businessKey]) || GENERIC_FA;
  return `سلام${who ? " " + who : ""} 👋\n\nپست‌هاتون رو در ${group} دیدم.\n\nمن امیرحسین نوری هستم، مهندس نرم‌افزار. برای کسب‌وکارهای کوچک سایت می‌سازم و سئوشون رو می‌گردونم؛ خودم چند فروشگاه آنلاین در بریتانیا رو راه انداختم و مدیریت می‌کنم.\n\n${pitch}\n\nاگر به‌دردتون می‌خوره، خوشحال می‌شم یک نگاه به وضعیت فعلی‌تون بندازم و صادقانه بگم اصلاً ارزش انجام داره یا نه. بابت این بخش هزینه‌ای نیست.`;
}

export interface CrmEntry {
  senderId: string;
  username: string | null;
  name: string;
  businessKey: string | null;
  businessType: string | null;
  chats: string[];
  posts: number;
  phones: string[];
  links: string[];
  emails: string[];
  sample: string;
  status: LeadStatus;
  contactedAt?: string;
  contactedVia?: string;
  repliedAt?: string;
  blacklistedAt?: string;
  blacklistReason?: string;
  firstSeen: string;
  lastSeen: string;
}

export interface Crm {
  updatedAt: string;
  entries: Record<string, CrmEntry>;
}

export function loadCrm(): Crm {
  try {
    return JSON.parse(readFileSync(crmPath(), "utf8")) as Crm;
  } catch {
    return { updatedAt: new Date().toISOString(), entries: {} };
  }
}

export function saveCrm(crm: Crm): string {
  mkdirSync(leadsDir(), { recursive: true });
  crm.updatedAt = new Date().toISOString();
  writeFileSync(crmPath(), JSON.stringify(crm, null, 2));
  return crmPath();
}

/**
 * Folds every raw find_advertisers dump into the CRM. New senders are added as
 * "new"; a sender already known keeps their status untouched — a sync must
 * never quietly un-blacklist or un-contact someone by overwriting their record
 * with a fresher scan of the same post.
 */
export function syncFromRawLeads(): { scanned: number; added: number; updated: number } {
  const crm = loadCrm();
  let scanned = 0, added = 0, updated = 0;
  if (!existsSync(leadsDir())) return { scanned, added, updated };

  for (const file of readdirSync(leadsDir())) {
    if (!file.endsWith(".json") || file === "crm.json") continue;
    let dump: { leads?: Advertiser[] };
    try {
      dump = JSON.parse(readFileSync(join(leadsDir(), file), "utf8"));
    } catch {
      continue;
    }
    for (const l of dump.leads ?? []) {
      scanned += 1;
      const type = classify(`${l.sample} ${l.handles.join(" ")}`);
      const existing = crm.entries[l.senderId];
      if (existing) {
        existing.username = l.username ?? existing.username;
        existing.name = l.name || existing.name;
        existing.chats = [...new Set([...existing.chats, ...l.chats])];
        existing.posts = Math.max(existing.posts, l.posts);
        existing.phones = [...new Set([...existing.phones, ...l.phones])];
        existing.links = [...new Set([...existing.links, ...l.links])];
        existing.emails = [...new Set([...existing.emails, ...l.emails])];
        if (l.lastSeen > existing.lastSeen) { existing.lastSeen = l.lastSeen; existing.sample = l.sample; }
        updated += 1;
      } else {
        crm.entries[l.senderId] = {
          senderId: l.senderId, username: l.username, name: l.name,
          businessKey: type?.key ?? null, businessType: type?.fa ?? null,
          chats: l.chats, posts: l.posts, phones: l.phones, links: l.links, emails: l.emails,
          sample: l.sample, status: "new", firstSeen: l.firstSeen, lastSeen: l.lastSeen,
        };
        added += 1;
      }
    }
  }
  saveCrm(crm);
  return { scanned, added, updated };
}

const VALUE = Object.fromEntries(BUSINESS_TYPES.map((t) => [t.key, t.value]));

export type LeadTier = "priority" | "standard" | "low";

/**
 * Whether a lead looks like it will actually answer a cold message, learned
 * from the one comparison we have data for: every currency exchange we
 * contacted cross-posted into 3+ groups with 50-120 posts and ignored us,
 * while everyone who replied — a dentist, two immigration consultants, a
 * tutor — posted in only 1-2 groups with a much more modest history.
 *
 * The read: heavy multi-group cross-posting is what a business does once its
 * marketing is already a running system, at which point a cold pitch about
 * getting found online has nothing to offer them. A single-group poster with
 * some history is a real, moderately active business that has not yet built
 * that system — which is exactly who benefits from one.
 *
 * "low" is not "bad", it is "low confidence" — nothing here is blacklisted on
 * a hunch. It just does not go in the queue a cron works through unattended.
 */
export function tierOf(e: CrmEntry): LeadTier {
  if (e.chats.length >= 3) return "low"; // cross-posts everywhere — already has a system, tunes us out
  if (e.posts < 5) return "low"; // one or two posts ever — likely a one-off, not a running business
  if (!e.businessKey) return "standard"; // active and focused, but we don't know what to pitch them
  return "priority";
}

/** Best-first queue within a tier: value of the trade, how active they are. */
export function rankLeads(crm: Crm, opts: { status?: LeadStatus; tiers?: LeadTier[] } = {}): CrmEntry[] {
  const tierRank: Record<LeadTier, number> = { priority: 0, standard: 1, low: 2 };
  return Object.values(crm.entries)
    .filter((e) => e.username && (opts.status ? e.status === opts.status : e.status !== "blacklisted"))
    .filter((e) => !opts.tiers || opts.tiers.includes(tierOf(e)))
    .map((e) => ({
      e,
      tier: tierOf(e),
      score: (VALUE[e.businessKey ?? ""] ?? 1) * 3 + Math.min(e.posts, 60) / 4,
    }))
    .sort((a, b) => tierRank[a.tier] - tierRank[b.tier] || b.score - a.score)
    .map((x) => x.e);
}

export function blacklist(crm: Crm, senderIds: string[], reason: string): number {
  const now = new Date().toISOString();
  let n = 0;
  for (const id of senderIds) {
    const e = crm.entries[id];
    if (!e || e.status === "blacklisted") continue;
    e.status = "blacklisted";
    e.blacklistedAt = now;
    e.blacklistReason = reason;
    n += 1;
  }
  return n;
}

export function blacklistByKey(crm: Crm, businessKey: string, reason: string): number {
  const ids = Object.values(crm.entries).filter((e) => e.businessKey === businessKey).map((e) => e.senderId);
  return blacklist(crm, ids, reason);
}

export function markContacted(crm: Crm, senderId: string, via: string): void {
  const e = crm.entries[senderId];
  if (!e) return;
  e.status = "contacted";
  e.contactedAt = new Date().toISOString();
  e.contactedVia = via;
}

export function markReplied(crm: Crm, senderId: string): void {
  const e = crm.entries[senderId];
  if (!e) return;
  e.status = "replied";
  e.repliedAt = new Date().toISOString();
}

export function findByUsername(crm: Crm, username: string): CrmEntry | undefined {
  const clean = username.replace(/^@/, "").toLowerCase();
  return Object.values(crm.entries).find((e) => e.username?.toLowerCase() === clean);
}
