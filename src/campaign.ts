import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Group advertising, arranged so it does not read as spam.
 *
 * The failure mode here is not technical, it is social: posting the same ad
 * into the same group every day gets you muted by readers and removed by
 * admins, and it is also what trains Telegram's own spam scoring on you. So
 * the schedule is built around two rules that are enforced rather than
 * suggested — a group is not eligible again until `minDaysBetween` has passed,
 * and a copy variant is never repeated in a group while an unused one exists.
 *
 * Everything is on disk so a restarted process cannot forget what it already
 * posted, which is the same reason the rate gate persists.
 */
export const campaignDir = () =>
  process.env.TELEGRAM_CAMPAIGN_DIR ?? join(process.cwd(), "data", "campaign");

const file = (name: string) => join(campaignDir(), name);

export interface Group {
  username: string;
  title: string;
  /** Which price list this group sees. Quoting pounds to Istanbul reads as careless. */
  region: string;
  /** Which language set this group sees. A Persian ad in an English room is ignored. */
  lang?: string;
  members: number;
  /** Telegram's own floor between messages in this group. */
  slowmodeSeconds: number;
  /** Our floor, which is far higher: how long before this group sees us again. */
  minDaysBetween: number;
  /** Which saved account posts here. Failover moves this. */
  account: string;
  enabled: boolean;
  note?: string;
}

export interface Variant {
  id: string;
  angle: string;
  /** Defaults to "fa" so existing copy needs no migration. */
  lang?: string;
  text: string;
  /** Local image path, attached when present. */
  image?: string | null;
}

/** One price list. Every group resolves to exactly one of these. */
export interface Region {
  monthly: string;
  setup: string;
  currencyNote?: string;
}

/** English wording for the same offer. Falls back to the Persian fields. */
export interface OfferLocale {
  contact?: string;
  examples?: string[];
  includes?: string[];
  guarantees?: string[];
}

export interface Offer {
  regions: Record<string, Region>;
  en?: OfferLocale;
  contact: string;
  /** Real, reachable sites. Proof belongs in the ad, not behind a DM. */
  examples: string[];
  includes: string[];
  guarantees: string[];
}

export interface PostRecord {
  group: string;
  variant: string;
  account: string;
  at: string;
  messageId?: number;
  error?: string;
}

export interface Ledger {
  posts: PostRecord[];
}

function readJson<T>(name: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(file(name), "utf8")) as T;
  } catch {
    return fallback;
  }
}

function writeJson(name: string, value: unknown): string {
  mkdirSync(campaignDir(), { recursive: true });
  const path = file(name);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return path;
}

export const loadGroups = () => readJson<{ groups: Group[] }>("roster.json", { groups: [] }).groups;
export const saveGroups = (groups: Group[]) => writeJson("roster.json", { groups });
export const loadCopy = () =>
  readJson<{ offer: Offer; variants: Variant[] }>("copy.json", {
    offer: { regions: {}, contact: "", examples: [], includes: [], guarantees: [] },
    variants: [],
  });
export const saveCopy = (copy: { offer: Offer; variants: Variant[] }) => writeJson("copy.json", copy);
export const loadLedger = () => readJson<Ledger>("ledger.json", { posts: [] });
export const saveLedger = (ledger: Ledger) => writeJson("ledger.json", ledger);

/**
 * Fills the offer into a variant for one region.
 *
 * The region is the point: the first run of this campaign quoted British pounds
 * into two Istanbul groups, which tells the reader immediately that the ad was
 * not written for them.
 */
export function render(text: string, offer: Offer, region: string, lang = "fa"): string {
  const prices = offer.regions[region] ?? Object.values(offer.regions)[0];
  if (!prices) throw new Error(`No price list for region "${region}".`);
  const loc = lang === "en" && offer.en ? offer.en : {};
  const contact = loc.contact ?? offer.contact;
  const examples = loc.examples ?? offer.examples;
  const includes = loc.includes ?? offer.includes;
  const guarantees = loc.guarantees ?? offer.guarantees;
  return text
    .replaceAll("{{monthly}}", prices.monthly)
    .replaceAll("{{setup}}", prices.setup)
    .replaceAll("{{contact}}", contact)
    .replaceAll("{{examples}}", examples.join("\n"))
    .replaceAll("{{includes}}", includes.map((i) => `• ${i}`).join("\n"))
    .replaceAll("{{guarantees}}", guarantees.map((g) => `✅ ${g}`).join("\n"));
}

const successful = (ledger: Ledger) => ledger.posts.filter((p) => !p.error);

export function lastPostTo(ledger: Ledger, group: string): PostRecord | undefined {
  return successful(ledger)
    .filter((p) => p.group === group)
    .sort((a, b) => b.at.localeCompare(a.at))[0];
}

export function daysSince(iso: string | undefined): number {
  if (!iso) return Number.POSITIVE_INFINITY;
  return (Date.now() - new Date(iso).getTime()) / 86_400_000;
}

export interface Plan {
  group: Group;
  variant: Variant;
  daysSinceLastPost: number;
  reason: string;
}

/**
 * Picks what to post next: the group that has waited longest among those past
 * their cooldown, paired with copy that group has not seen — or has seen least
 * recently, if it has seen all of it.
 */
export function planNext(
  groups: Group[],
  copy: { offer: Offer; variants: Variant[] },
  ledger: Ledger,
  exclude: Set<string> = new Set(),
  /** Manual override: ignore the per-group cooldown. The rate gate still applies. */
  ignoreCooldown = false,
): Plan | null {
  if (!copy.variants.length) return null;

  const due = groups
    .filter((g) => g.enabled && !exclude.has(g.username))
    .map((g) => ({ g, days: daysSince(lastPostTo(ledger, g.username)?.at) }))
    .filter((x) => ignoreCooldown || x.days >= x.g.minDaysBetween)
    .sort((a, b) => b.days - a.days);

  if (!due.length) return null;
  const { g, days } = due[0]!;

  const usedHere = successful(ledger).filter((p) => p.group === g.username);
  const lang = g.lang ?? "fa";
  const speakable = copy.variants.filter((v) => (v.lang ?? "fa") === lang);
  if (!speakable.length) return null;
  const unseen = speakable.filter((v) => !usedHere.some((p) => p.variant === v.id));
  let variant: Variant;
  let reason: string;
  if (unseen.length) {
    // تنوعِ سراسری هم مهم است، نه فقط داخلِ یک گروه: خیلی‌ها عضو چند گروه‌اند و
    // دیدنِ یک متنِ یکسان در شش گروه، دقیقاً همان چیزی است که «ربات» به نظر می‌رسد.
    // پس بینِ متن‌هایی که این گروه ندیده، آن را می‌گیریم که در کلِ کمپین دیرتر از
    // همه استفاده شده (یا هرگز استفاده نشده).
    const lastUsedGlobally = new Map<string, string>();
    for (const p of successful(ledger)) {
      const prev = lastUsedGlobally.get(p.variant);
      if (!prev || p.at > prev) lastUsedGlobally.set(p.variant, p.at);
    }
    const angleLastUsed = new Map<string, string>();
    for (const p of successful(ledger)) {
      const v = speakable.find((x) => x.id === p.variant);
      if (!v) continue;
      const prev = angleLastUsed.get(v.angle);
      if (!prev || p.at > prev) angleLastUsed.set(v.angle, p.at);
    }
    const rank = (v: Variant) => [
      lastUsedGlobally.get(v.id) ?? "",
      angleLastUsed.get(v.angle) ?? "",
    ];
    unseen.sort((a, b) => {
      const [av, aa] = rank(a);
      const [bv, ba] = rank(b);
      return av.localeCompare(bv) || aa.localeCompare(ba);
    });
    variant = unseen[0]!;
    const seenBefore = lastUsedGlobally.has(variant.id);
    reason = seenBefore
      ? `new to this group; least recently used campaign-wide`
      : `new to this group and unused campaign-wide`;
    reason += ` (${lang})`;
  } else {
    const oldest = [...usedHere]
      .filter((p) => speakable.some((v) => v.id === p.variant))
      .sort((a, b) => a.at.localeCompare(b.at))[0];
    variant = (oldest && speakable.find((v) => v.id === oldest.variant)) ?? speakable[0]!;
    reason = `all copy used here; reusing the least recent (${Math.round(daysSince(oldest.at))}d ago)`;
  }
  return { group: g, variant, daysSinceLastPost: days, reason };
}

/** A dry-run schedule: what the next `count` posts would be, in order. */
export function planAhead(
  groups: Group[],
  copy: { offer: Offer; variants: Variant[] },
  ledger: Ledger,
  count: number,
): Plan[] {
  const simulated: Ledger = { posts: [...ledger.posts] };
  const plans: Plan[] = [];
  for (let i = 0; i < count; i++) {
    const plan = planNext(groups, copy, simulated);
    if (!plan) break;
    plans.push(plan);
    simulated.posts.push({
      group: plan.group.username,
      variant: plan.variant.id,
      account: plan.group.account,
      at: new Date(Date.now() + i * 1000).toISOString(),
    });
  }
  return plans;
}

export function recordPost(ledger: Ledger, record: PostRecord): Ledger {
  ledger.posts.push(record);
  saveLedger(ledger);
  return ledger;
}

export const campaignExists = () => existsSync(file("roster.json"));
