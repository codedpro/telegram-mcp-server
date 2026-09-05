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
  text: string;
  /** Local image path, attached when present. */
  image?: string | null;
}

export interface Offer {
  starterPrice: string;
  shopPrice: string;
  contact: string;
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
    offer: { starterPrice: "", shopPrice: "", contact: "" },
    variants: [],
  });
export const saveCopy = (copy: { offer: Offer; variants: Variant[] }) => writeJson("copy.json", copy);
export const loadLedger = () => readJson<Ledger>("ledger.json", { posts: [] });
export const saveLedger = (ledger: Ledger) => writeJson("ledger.json", ledger);

/** Fills {{price}}, {{shopPrice}} and {{contact}} so the offer lives in one place. */
export function render(text: string, offer: Offer): string {
  return text
    .replaceAll("{{price}}", offer.starterPrice)
    .replaceAll("{{shopPrice}}", offer.shopPrice)
    .replaceAll("{{contact}}", offer.contact);
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
): Plan | null {
  if (!copy.variants.length) return null;

  const due = groups
    .filter((g) => g.enabled && !exclude.has(g.username))
    .map((g) => ({ g, days: daysSince(lastPostTo(ledger, g.username)?.at) }))
    .filter((x) => x.days >= x.g.minDaysBetween)
    .sort((a, b) => b.days - a.days);

  if (!due.length) return null;
  const { g, days } = due[0]!;

  const usedHere = successful(ledger).filter((p) => p.group === g.username);
  const unseen = copy.variants.filter((v) => !usedHere.some((p) => p.variant === v.id));
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
      const v = copy.variants.find((x) => x.id === p.variant);
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
  } else {
    const oldest = [...usedHere].sort((a, b) => a.at.localeCompare(b.at))[0]!;
    variant = copy.variants.find((v) => v.id === oldest.variant) ?? copy.variants[0]!;
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
