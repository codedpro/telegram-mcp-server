import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

/**
 * A record of every post a scan has already surfaced, so the next scan does not
 * pay to look at it again.
 *
 * Keyed by a fingerprint of the message text rather than by id: these channels
 * cross-post the same job into a dozen places, and paying attention to it once
 * should silence all twelve copies. The fingerprint strips @handles and
 * punctuation so a repost with a different contact line still matches.
 */
export const ledgerDir = () => process.env.TELEGRAM_LEDGER_DIR ?? join(process.cwd(), "data", "ledger");

const fileFor = (folder: string) =>
  join(ledgerDir(), `${folder.replace(/[^A-Za-z0-9._-]/g, "_")}.json`);

export type EntryStatus = "seen" | "applied" | "ignored";

export interface LedgerEntry {
  fingerprint: string;
  status: EntryStatus;
  title: string;
  link: string;
  contact?: string;
  categories: string[];
  firstSeen: string;
  lastSeen: string;
  /** Set when status becomes "applied". */
  appliedAt?: string;
  note?: string;
}

export interface Ledger {
  folder: string;
  updatedAt: string;
  entries: Record<string, LedgerEntry>;
}

/** Normalizes away channel branding, handles and punctuation before hashing. */
export function fingerprint(text: string): string {
  const normalized = text
    .replace(/@[A-Za-z0-9_]+/g, " ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .slice(0, 400);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 24);
}

export function load(folder: string): Ledger {
  const file = fileFor(folder);
  if (!existsSync(file)) return { folder, updatedAt: new Date().toISOString(), entries: {} };
  try {
    return JSON.parse(readFileSync(file, "utf8")) as Ledger;
  } catch {
    return { folder, updatedAt: new Date().toISOString(), entries: {} };
  }
}

export function save(ledger: Ledger): string {
  mkdirSync(ledgerDir(), { recursive: true });
  const file = fileFor(ledger.folder);
  writeFileSync(file, JSON.stringify({ ...ledger, updatedAt: new Date().toISOString() }, null, 2));
  return file;
}

/**
 * Drops entries whose last sighting is older than the retention window — the
 * rotation. A job nobody reposted in three months is not coming back, and an
 * unbounded ledger would eventually cost more to load than it saves.
 *
 * `applied` entries are kept regardless: forgetting that you already wrote to
 * someone is the one mistake this file exists to prevent.
 */
export function rotate(ledger: Ledger, retentionDays: number): { kept: number; pruned: number } {
  const cutoff = Date.now() - retentionDays * 86400_000;
  let pruned = 0;
  for (const [key, entry] of Object.entries(ledger.entries)) {
    if (entry.status === "applied") continue;
    if (new Date(entry.lastSeen).getTime() < cutoff) {
      delete ledger.entries[key];
      pruned += 1;
    }
  }
  return { kept: Object.keys(ledger.entries).length, pruned };
}

export function isKnown(ledger: Ledger, text: string): boolean {
  return Boolean(ledger.entries[fingerprint(text)]);
}

/** Records a sighting. Existing entries keep their status and firstSeen. */
export function record(
  ledger: Ledger,
  item: { text: string; title: string; link: string; categories: string[]; contact?: string },
  status: EntryStatus = "seen",
): LedgerEntry {
  const fp = fingerprint(item.text);
  const now = new Date().toISOString();
  const existing = ledger.entries[fp];
  const entry: LedgerEntry = existing
    ? { ...existing, lastSeen: now }
    : {
        fingerprint: fp,
        status,
        title: item.title,
        link: item.link,
        contact: item.contact,
        categories: item.categories,
        firstSeen: now,
        lastSeen: now,
      };
  ledger.entries[fp] = entry;
  return entry;
}

export function markApplied(ledger: Ledger, text: string, note?: string): LedgerEntry | undefined {
  const entry = ledger.entries[fingerprint(text)];
  if (!entry) return undefined;
  entry.status = "applied";
  entry.appliedAt = new Date().toISOString();
  if (note) entry.note = note;
  return entry;
}

/** Marks by fingerprint when the original text is not at hand. */
export function markAppliedByFingerprint(ledger: Ledger, fp: string, note?: string): LedgerEntry | undefined {
  const entry = ledger.entries[fp];
  if (!entry) return undefined;
  entry.status = "applied";
  entry.appliedAt = new Date().toISOString();
  if (note) entry.note = note;
  return entry;
}
