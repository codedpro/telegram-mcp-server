import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Api, type TelegramClient } from "teleproto";

/** Scans live in the repo so a later session can re-read them without refetching. */
export const scanDir = () => process.env.TELEGRAM_SCAN_DIR ?? join(process.cwd(), "data", "scans");

export const CATEGORIES: Record<string, RegExp> = {
  SEO: /سئو|seo|بک ?لینک|backlink|رتبه.?(گوگل|سایت)|دیجیتال ?مارکتینگ|سرچ ?کنسول|search ?console/i,
  AI: /هوش ?مصنوعی|\bai\b|machine ?learning|deep ?learning|chatgpt|\bgpt\b|\bllm\b|\bnlp\b|بینایی ?ماشین|data ?scien|دیتا ?ساینس|یادگیری ?ماشین|یادگیری ?عمیق/i,
  Web: /وردپرس|wordpress|react|next\.?js|vue|angular|laravel|\bphp\b|django|فرانت|front.?end|بک.?اند|back.?end|node\.?js|طراحی ?(سایت|وب)|وب.?سایت|\bhtml\b|\bcss\b|javascript|typescript|tailwind|فول.?استک|full.?stack|woocommerce|ووکامرس/i,
  Software: /برنامه ?نویس|developer|دولوپر|python|پایتون|\bjava\b|c\#|\.net|flutter|فلاتر|react ?native|اندروید|android|\bios\b|اپلیکیشن|\bapi\b|دیتابیس|database|\bsql\b|devops|docker|کدنویس|توسعه ?دهنده|نرم ?افزار|ربات ?تلگرام/i,
};

/** Words an employer uses. Used to separate real openings from self-promotion. */
const JOB = /نیازمند|نیازمندیم|استخدام|جذب|همکاری|حقوق|دستمزد|بودجه|قرارداد|hiring|\bjob\b|پاره ?وقت|تمام ?وقت|مبلغ|کارفرما|درخواست ?کننده/i;
/** Words a service provider uses when advertising themselves. */
const PROVIDER = /#?انجام_?دهنده|#?فریلنسر_?آماده|رزومه و نمونه.?کار|در خدمتم|آماده.?ام|خدمات (تخصصی|ما)|قیمت پیشنهادی خودتون/i;
/** Markers that a post is already taken or expired. */
const CLOSED = /واگذار ?شد|حل ?شد|منقضی|بسته ?شد|تکمیل ?شد|پر ?شد/;

export interface ScanItem {
  chatId: string;
  chatTitle: string;
  username: string | null;
  messageId: number;
  date: string;
  link: string;
  categories: string[];
  isJob: boolean;
  isProvider: boolean;
  isClosed: boolean;
  text: string;
}

export interface ScanRecord {
  id: string;
  folder: string;
  createdAt: string;
  days: number;
  cutoff: string;
  account?: string;
  chats: { id: string; title: string; username: string | null; scanned: number; matched: number }[];
  totals: { scanned: number; matched: number; openJobs: number; byCategory: Record<string, number> };
  items: ScanItem[];
}

export async function resolveFolder(client: TelegramClient, folder: string) {
  const res = await client.invoke(new Api.messages.GetDialogFilters());
  const named = res.filters.filter((f) => !(f instanceof Api.DialogFilterDefault));
  const title = (f: Api.TypeDialogFilter) => {
    const t = (f as { title?: { text?: string } | string }).title;
    return typeof t === "string" ? t : (t?.text ?? "");
  };
  const match = named.find((f) => title(f).toLowerCase() === folder.trim().toLowerCase());
  if (!match) {
    throw new Error(`No chat folder named "${folder}". Folders: ${named.map(title).join(", ")}.`);
  }
  const m = match as unknown as { pinnedPeers?: Api.TypeInputPeer[]; includePeers?: Api.TypeInputPeer[] };
  return { title: title(match), peers: [...(m.pinnedPeers ?? []), ...(m.includePeers ?? [])] };
}

export function listFolders(res: Api.messages.DialogFilters) {
  return res.filters.map((f) => {
    if (f instanceof Api.DialogFilterDefault) return { title: "All chats", id: null, kind: "default", chats: 0 };
    const m = f as unknown as { id: number; title?: { text?: string } | string; pinnedPeers?: unknown[]; includePeers?: unknown[] };
    const t = typeof m.title === "string" ? m.title : (m.title?.text ?? "");
    return {
      title: t,
      id: m.id,
      kind: f.className.replace("DialogFilter", "").toLowerCase() || "filter",
      chats: (m.pinnedPeers?.length ?? 0) + (m.includePeers?.length ?? 0),
    };
  });
}

export function classify(text: string, categories: string[]): Omit<ScanItem, "chatId" | "chatTitle" | "username" | "messageId" | "date" | "link" | "text"> | null {
  const wanted = categories.length ? categories : Object.keys(CATEGORIES);
  const cats = wanted.filter((c) => CATEGORIES[c]?.test(text));
  if (!cats.length) return null;
  return {
    categories: cats,
    isJob: JOB.test(text),
    isProvider: PROVIDER.test(text),
    isClosed: CLOSED.test(text),
  };
}

export function saveScan(record: ScanRecord): string {
  const d = scanDir();
  mkdirSync(d, { recursive: true });
  const file = join(d, `${record.id}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  return file;
}

export function listScans(): { id: string; folder: string; createdAt: string; totals: ScanRecord["totals"] }[] {
  const d = scanDir();
  if (!existsSync(d)) return [];
  return readdirSync(d)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const r = JSON.parse(readFileSync(join(d, f), "utf8")) as ScanRecord;
      return { id: r.id, folder: r.folder, createdAt: r.createdAt, totals: r.totals };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readScan(id: string): ScanRecord {
  const file = join(scanDir(), `${id.replace(/[^A-Za-z0-9._-]/g, "")}.json`);
  if (!existsSync(file)) {
    const known = listScans().map((s) => s.id).slice(0, 10);
    throw new Error(`No scan "${id}".${known.length ? ` Recent scans: ${known.join(", ")}.` : ""}`);
  }
  return JSON.parse(readFileSync(file, "utf8")) as ScanRecord;
}

export function lastScan(folder: string): ScanRecord | undefined {
  const match = listScans().find((s) => s.folder === folder);
  return match ? readScan(match.id) : undefined;
}
