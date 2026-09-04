import { Api, type TelegramClient } from "teleproto";

/**
 * Finding the people advertising a business in a group.
 *
 * The contact that matters is usually NOT in the message. Someone posts "کارگر
 * ساختمانی هستم، تماس بگیرید" and nothing else; the way to reach them is the
 * account that sent it. So every hit carries the resolved sender — id, username,
 * name — and any contact details found in the text are extra, not the point.
 */

/** Someone is selling or offering something. Persian and English. */
const AD = new RegExp(
  [
    "خدمات", "ارائه ?می", "می ?فروش", "فروش", "قیمت", "سفارش", "رزرو", "مشاوره",
    "نمایندگی", "شرکت ما", "کلینیک", "رستوران", "کافه", "آرایشگاه", "سالن",
    "وکیل", "مهاجرت", "ویزا", "بیمه", "حمل ?و ?نقل", "باربری", "صرافی", "تبدیل ?ارز",
    "حواله", "تعمیر", "نصب", "آموزش", "کلاس", "تدریس", "دوره", "طراحی", "پذیرفته ?می ?شود",
    "با ?ما ?تماس", "جهت ?اطلاعات", "دایرکت", "پیام ?بدید", "پیوی", "واتساپ", "واتس ?اپ",
    "تخفیف", "رایگان ?مشاوره", "بهترین ?قیمت", "کیفیت ?عالی", "همکاری ?می ?پذیریم",
    "we offer", "our service", "book now", "contact us", "\\bdm me\\b", "whatsapp",
    "discount", "delivery", "free quote", "best price", "available for hire",
  ].join("|"),
  "i",
);

/** Job-seeking, chit-chat and group admin noise that also mentions money. */
const NOT_AD =
  /سلام ?به ?همه|کسی ?میدونه|کسی ?اطلاع|سوال ?داشتم|ببخشید|قوانین ?گروه|ادمین ?گروه|لینک ?گروه|تبریک|تسلیت|خبر ?فوری|https?:\/\/t\.me\/joinchat|فقط ?سوال/i;

export interface Advertiser {
  /** The account that posted — the contact that actually matters. */
  senderId: string;
  username: string | null;
  name: string;
  isBot: boolean;
  isPremium: boolean;
  /** Groups this person advertised in. */
  chats: string[];
  posts: number;
  firstSeen: string;
  lastSeen: string;
  /** Contact details lifted out of the message text. */
  phones: string[];
  handles: string[];
  links: string[];
  emails: string[];
  /** Best sample of what they are selling. */
  sample: string;
  sampleLink: string;
}

const PHONE = /(?:\+|00)\d[\d\s().-]{7,17}\d|\b0\d{9,10}\b/g;
const HANDLE = /@[A-Za-z][A-Za-z0-9_]{3,31}/g;
const LINK = /https?:\/\/[^\s<>"]+|(?:www\.)[^\s<>"]+/gi;
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g;

const clean = (v: string) => v.replace(/\s+/g, " ").trim();

export function looksLikeAd(text: string): boolean {
  if (text.length < 25) return false;
  if (NOT_AD.test(text) && !AD.test(text)) return false;
  return AD.test(text);
}

export function extractContacts(text: string) {
  const emails = [...new Set(text.match(EMAIL) ?? [])];
  // ایمیل‌ها را از هندل‌ها جدا کن، وگرنه دامنه‌ی ایمیل به‌عنوان یوزرنیم خوانده می‌شود.
  const withoutEmails = text.replace(EMAIL, " ");
  return {
    phones: [...new Set((withoutEmails.match(PHONE) ?? []).map((p) => p.replace(/[\s().-]/g, "")))].filter(
      (p) => p.replace(/\D/g, "").length >= 9,
    ),
    handles: [...new Set(withoutEmails.match(HANDLE) ?? [])],
    links: [...new Set(withoutEmails.match(LINK) ?? [])],
    emails,
  };
}

/**
 * Resolves the sender of a message. The entity is normally already cached from
 * the same getMessages call, so this is cheap; when it is not, we fall back to
 * the raw id rather than dropping the lead.
 */
export async function resolveSender(
  client: TelegramClient,
  senderId: string,
  cache: Map<string, { username: string | null; name: string; isBot: boolean; isPremium: boolean }>,
) {
  const hit = cache.get(senderId);
  if (hit) return hit;
  let resolved = { username: null as string | null, name: `user ${senderId}`, isBot: false, isPremium: false };
  try {
    const entity = await client.getEntity(senderId);
    if (entity instanceof Api.User) {
      resolved = {
        username: entity.username ?? null,
        name: [entity.firstName, entity.lastName].filter(Boolean).join(" ") || `user ${senderId}`,
        isBot: entity.bot ?? false,
        isPremium: entity.premium ?? false,
      };
    } else if (entity instanceof Api.Channel || entity instanceof Api.Chat) {
      resolved = { username: (entity as Api.Channel).username ?? null, name: entity.title, isBot: false, isPremium: false };
    }
  } catch {
    // پیام از طرف کانال یا کاربر حذف‌شده — شناسه را نگه می‌داریم.
  }
  cache.set(senderId, resolved);
  return resolved;
}

/** Merges a new sighting into the per-person record. */
export function mergeAdvertiser(
  map: Map<string, Advertiser>,
  base: Omit<Advertiser, "chats" | "posts" | "firstSeen" | "lastSeen"> & { chat: string; date: string },
): void {
  const existing = map.get(base.senderId);
  if (!existing) {
    map.set(base.senderId, {
      senderId: base.senderId,
      username: base.username,
      name: base.name,
      isBot: base.isBot,
      isPremium: base.isPremium,
      chats: [base.chat],
      posts: 1,
      firstSeen: base.date,
      lastSeen: base.date,
      phones: base.phones,
      handles: base.handles,
      links: base.links,
      emails: base.emails,
      sample: base.sample,
      sampleLink: base.sampleLink,
    });
    return;
  }
  existing.posts += 1;
  if (!existing.chats.includes(base.chat)) existing.chats.push(base.chat);
  if (base.date < existing.firstSeen) existing.firstSeen = base.date;
  if (base.date > existing.lastSeen) {
    existing.lastSeen = base.date;
    // آخرین آگهی معمولاً تازه‌ترین چیزی است که می‌فروشند.
    if (base.sample.length > 40) { existing.sample = base.sample; existing.sampleLink = base.sampleLink; }
  }
  for (const k of ["phones", "handles", "links", "emails"] as const) {
    existing[k] = [...new Set([...existing[k], ...base[k]])];
  }
}

export const sampleOf = (text: string, max = 220) => clean(text).slice(0, max);
