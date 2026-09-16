import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { leadsDir } from "./leads.js";

/**
 * A hand-picked send queue with an escalating per-account backoff.
 *
 * This is not the tier-ranked CRM query from before — that produces a list
 * for a person to read. This is the short list of leads a person actually
 * read and decided to contact, in the order to contact them, each carrying
 * the specific message written for them. Nothing goes in here by a formula.
 *
 * The backoff ladder is the operator's own design, in their words: every 10
 * minutes while healthy; on a block, retry after 1 hour; still blocked,
 * after 1 day; still blocked, after 1 more day; blocked for 3 days straight,
 * drop to weekly; four weekly attempts still blocked, stop entirely until
 * someone clears it by hand. Every step resets to normal on the first
 * success — a block is the account's current state, not a permanent mark
 * against it.
 */
const queuePath = () => join(leadsDir(), "queue.json");
const backoffPath = (account: string) => join(leadsDir(), `queue-backoff-${account}.json`);

export interface QueueItem {
  username: string;
  priority: number; // lower sends first
  message: string;
  reason: string; // why this lead, for the log
  status: "pending" | "sent" | "failed" | "skipped";
  addedAt: string;
  sentAt?: string;
  messageId?: number;
  account?: string;
}

export interface Queue {
  items: QueueItem[];
}

export function loadQueue(): Queue {
  try {
    return JSON.parse(readFileSync(queuePath(), "utf8")) as Queue;
  } catch {
    return { items: [] };
  }
}

export function saveQueue(q: Queue): string {
  mkdirSync(leadsDir(), { recursive: true });
  writeFileSync(queuePath(), JSON.stringify(q, null, 2));
  return queuePath();
}

export function enqueue(items: Omit<QueueItem, "status" | "addedAt">[]): number {
  const q = loadQueue();
  const existing = new Set(q.items.map((i) => i.username.toLowerCase()));
  let added = 0;
  for (const it of items) {
    if (existing.has(it.username.toLowerCase())) continue;
    q.items.push({ ...it, status: "pending", addedAt: new Date().toISOString() });
    existing.add(it.username.toLowerCase());
    added += 1;
  }
  q.items.sort((a, b) => a.priority - b.priority);
  saveQueue(q);
  return added;
}

/** Highest-priority item still waiting to go out. */
export function nextPending(q: Queue): QueueItem | undefined {
  return [...q.items].filter((i) => i.status === "pending").sort((a, b) => a.priority - b.priority)[0];
}

export type BackoffStage = "normal" | "wait1h" | "wait1d_a" | "wait1d_b" | "weekly" | "stopped";

export interface BackoffState {
  stage: BackoffStage;
  nextAttemptAt: string; // ISO; "now or earlier" means eligible
  weeklyFailCount: number;
  lastError?: string;
  stoppedAt?: string;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const fresh = (): BackoffState => ({ stage: "normal", nextAttemptAt: new Date(0).toISOString(), weeklyFailCount: 0 });

export function loadBackoff(account: string): BackoffState {
  try {
    return JSON.parse(readFileSync(backoffPath(account), "utf8")) as BackoffState;
  } catch {
    return fresh();
  }
}

export function saveBackoff(account: string, state: BackoffState): void {
  mkdirSync(leadsDir(), { recursive: true });
  writeFileSync(backoffPath(account), JSON.stringify(state, null, 2));
}

export function isEligibleNow(state: BackoffState): boolean {
  if (state.stage === "stopped") return false;
  return new Date(state.nextAttemptAt).getTime() <= Date.now();
}

/** Any success returns straight to normal — a lock is a current state, not a strike. */
export function onSuccess(): BackoffState {
  return fresh();
}

/**
 * The ladder, one step per consecutive block: 1h -> 1d -> 1d -> weekly, then
 * up to 4 weekly attempts before giving up on the account until a person
 * clears the backoff file by hand.
 */
export function onFailure(prev: BackoffState, error: string): BackoffState {
  const now = Date.now();
  switch (prev.stage) {
    case "normal":
      return { stage: "wait1h", nextAttemptAt: new Date(now + HOUR).toISOString(), weeklyFailCount: 0, lastError: error };
    case "wait1h":
      return { stage: "wait1d_a", nextAttemptAt: new Date(now + DAY).toISOString(), weeklyFailCount: 0, lastError: error };
    case "wait1d_a":
      return { stage: "wait1d_b", nextAttemptAt: new Date(now + DAY).toISOString(), weeklyFailCount: 0, lastError: error };
    case "wait1d_b":
    case "weekly": {
      const failCount = (prev.stage === "weekly" ? prev.weeklyFailCount : 0) + 1;
      if (failCount >= 4) {
        return { stage: "stopped", nextAttemptAt: prev.nextAttemptAt, weeklyFailCount: failCount, lastError: error, stoppedAt: new Date(now).toISOString() };
      }
      return { stage: "weekly", nextAttemptAt: new Date(now + WEEK).toISOString(), weeklyFailCount: failCount, lastError: error };
    }
    case "stopped":
    default:
      return prev; // stays stopped; needs a human to clear the file
  }
}

export const queueExists = () => existsSync(queuePath());
