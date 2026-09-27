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

/**
 * Ordered so the first regex to match wins — put more specific trades first.
 * Exchange goes first, unconditionally: "صراف" is unambiguous, but exchanges
 * routinely use generic words like "عمده" (wholesale) in their own marketing
 * ("همکاران و خریداران عمده"), which matched retail before this reordering
 * and let real exchanges dodge the blacklist under a different label.
 */
export const BUSINESS_TYPES: (BusinessType & { re: RegExp })[] = [
  { key: "exchange", fa: "صرافی و انتقال ارز", value: 4, re: /صراف|نرخ ?(ارز|امروز)|حواله|ترانسفر|تبدیل ?ارز|تبادل ?ارز|خرید ?(پوند|دلار|یورو)|فروش ?(پوند|دلار|یورو)|exchange rate|money ?transfer|remittance/i },
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
];

export function classify(text: string): BusinessType | null {
  for (const t of BUSINESS_TYPES) if (t.re.test(text)) return { key: t.key, fa: t.fa, value: t.value };
  return null;
}

/** One line specific to the trade — this is what makes the message read as written for them. */
/**
 * One question per trade, not a pitch. Leads kept answering the old
 * paragraph-long drafts with silence and telling us it read like AI: a signed
 * intro, a benefit paragraph and a closing offer is exactly the shape of a
 * generated message. A short note that asks something a person would ask gets
 * a reply; the offer rides along in one line.
 */
const QUESTION: Record<string, string> = {
  exchange: "سایت هم دارید یا فقط تلگرام؟",
  food: "سفارش‌ها رو فقط از دایرکت و واتساپ می‌گیرید یا منوی آنلاین هم دارید؟",
  clinic: "برای نوبت، مراجعه‌کننده‌ها فقط پیام می‌دن یا رزرو آنلاین هم دارید؟",
  legal: "مشتری‌ها بیشتر از همین گروه‌ها میان یا از گوگل هم پیداتون می‌کنن؟",
  retail: "فقط توی تلگرام و اینستا می‌فروشید یا فروشگاه آنلاین هم دارید؟",
  beauty: "نوبت‌ها رو از دایرکت می‌گیرید یا رزرو آنلاین دارید؟",
  trades: "مشتری‌ها از گوگل هم پیداتون می‌کنن یا فقط از گروه‌ها؟",
  transport: "استعلام قیمت‌ها فقط از پیام میاد یا سایت هم دارید؟",
  education: "ثبت‌نام‌ها رو از کجا می‌گیرید؟ سایت دارید؟",
  realestate: "لیست فایل‌هاتون جایی آنلاین هست که مشتری خودش ببینه؟",
  crypto: "سایت هم دارید یا فقط تلگرام؟",
};

const GENERIC_QUESTION = "سایت هم دارید یا مشتری‌ها فقط از تلگرام میان؟";

export const OFFER_LINE = "ما سایت می‌سازیم که تو گوگل دیده بشه، پولش هم ۱۲ ماهه قسطیه. نمونه‌ها: code-nest.dev";

/** Fallback direct message when no hand-written one is given: greeting, one question, one line of offer. */
export function draftOutreach(lead: CrmEntry): string {
  const question = (lead.businessKey && QUESTION[lead.businessKey]) || GENERIC_QUESTION;
  return `سلام، وقت بخیر\nآگهی‌تون رو توی گروه دیدم. ${question}\n\n${OFFER_LINE}`;
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
        // Re-classify only while still untouched: a contacted/replied/blacklisted
        // person's trade label should not shift under a decision already made
        // about them, but a "new" entry should benefit when the classifier
        // improves rather than being stuck with whatever it guessed on day one.
        if (existing.status === "new" && type && type.key !== existing.businessKey) {
          existing.businessKey = type.key;
          existing.businessType = type.fa;
        }
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
 * A flag, not a filter: whether a lead is likely already saturated with cold
 * pitches, from the one comparison we have data for. Every currency exchange
 * we contacted cross-posted into 3+ groups with 50-120 posts and ignored us,
 * while everyone who replied — a dentist, two immigration consultants, a
 * tutor — posted in only 1-2 groups.
 *
 * That is the only thing this predicts: heavy multi-group cross-posting means
 * a business is visible enough that everyone doing this kind of outreach has
 * already found them, so one more cold message is nothing new. It says
 * nothing about a single-post advertiser being a worse lead — a business that
 * posted once could easily be a better one precisely because nobody has
 * pitched them yet. Post count was dropped from this after review: treating
 * "posted rarely" as a mark against someone was backwards, and no formula
 * should be deciding that anyway. This flag informs a human reading the
 * actual post; it does not rank or gate anyone automatically.
 */
export function tierOf(e: CrmEntry): LeadTier {
  if (e.chats.length >= 3) return "low"; // visible everywhere — likely already fielding outreach like this
  if (!e.businessKey) return "standard"; // active, but we don't know what trade to even describe
  return "priority";
}

/**
 * Lists leads for a person to read, not to auto-send to. Sorted only by trade
 * value as a reading aid — the actual decision to contact someone is made by
 * reading their post, not by this score.
 */
export function rankLeads(crm: Crm, opts: { status?: LeadStatus; tiers?: LeadTier[] } = {}): CrmEntry[] {
  return Object.values(crm.entries)
    .filter((e) => e.username && (opts.status ? e.status === opts.status : e.status !== "blacklisted"))
    .filter((e) => !opts.tiers || opts.tiers.includes(tierOf(e)))
    .map((e) => ({ e, score: VALUE[e.businessKey ?? ""] ?? 1 }))
    .sort((a, b) => b.score - a.score)
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

/**
 * Whether the CRM's own bookkeeping says this person is off-limits for a
 * fresh cold-outreach message — already messaged, already replied, or
 * blacklisted. "new" is the only status that clears this.
 */
export function alreadyHasHistory(entry: CrmEntry | undefined): boolean {
  return entry !== undefined && entry.status !== "new";
}
