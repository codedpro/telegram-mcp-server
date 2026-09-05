import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * A hard minimum gap between outward actions — sending a message or a file,
 * joining a chat.
 *
 * This exists because pacing inside a script is not pacing: every batch script
 * has its own loop, its own sleep, and its own idea of what is safe, and the
 * account pays for the most reckless one. Telegram scores the ACCOUNT, not the
 * script. Twenty joins and ten cold messages inside two days is what earned a
 * PEER_FLOOD here, so the gate lives next to the client where every caller has
 * to pass through it.
 *
 * The timestamp is on disk, so a fresh process cannot start over with a clean
 * slate — which is exactly how the limit got tripped the first time.
 */
const stateFile = () =>
  process.env.TELEGRAM_THROTTLE_FILE ?? join(process.cwd(), "data", "throttle.json");

/** Default 10 minutes. Override with TELEGRAM_MIN_ACTION_INTERVAL_MS. */
export const minIntervalMs = (): number => {
  const raw = Number(process.env.TELEGRAM_MIN_ACTION_INTERVAL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 600_000;
};

/** Refuse rather than block forever if the wait is absurd. */
const maxWaitMs = (): number => {
  const raw = Number(process.env.TELEGRAM_MAX_THROTTLE_WAIT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 1_800_000;
};

interface State {
  lastActionAt?: string;
  lastKind?: string;
  count?: number;
}

function read(): State {
  try {
    return JSON.parse(readFileSync(stateFile(), "utf8")) as State;
  } catch {
    return {};
  }
}

function write(state: State): void {
  const file = stateFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(state, null, 2));
}

export function status() {
  const state = read();
  const interval = minIntervalMs();
  const last = state.lastActionAt ? new Date(state.lastActionAt).getTime() : 0;
  const waitMs = Math.max(0, last + interval - Date.now());
  return {
    minIntervalMs: interval,
    lastActionAt: state.lastActionAt ?? null,
    lastKind: state.lastKind ?? null,
    actionsRecorded: state.count ?? 0,
    readyIn: waitMs,
    ready: waitMs === 0,
  };
}

/**
 * Blocks until the gap has elapsed, then records this action. Callers get told
 * how long they waited so it shows up in the tool result rather than looking
 * like a hang.
 */
export async function gate(kind: string): Promise<{ waitedMs: number }> {
  const interval = minIntervalMs();
  if (interval === 0) {
    write({ lastActionAt: new Date().toISOString(), lastKind: kind, count: (read().count ?? 0) + 1 });
    return { waitedMs: 0 };
  }
  const state = read();
  const last = state.lastActionAt ? new Date(state.lastActionAt).getTime() : 0;
  const waitMs = Math.max(0, last + interval - Date.now());
  if (waitMs > maxWaitMs()) {
    throw new Error(
      `Rate gate: the next ${kind} is not allowed for ${Math.ceil(waitMs / 1000)}s, which exceeds the ${Math.ceil(maxWaitMs() / 1000)}s cap. Try later, or lower TELEGRAM_MIN_ACTION_INTERVAL_MS.`,
    );
  }
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  write({ lastActionAt: new Date().toISOString(), lastKind: kind, count: (state.count ?? 0) + 1 });
  return { waitedMs: waitMs };
}

/** Used by tests and by an explicit operator reset. */
export function reset(): void {
  if (existsSync(stateFile())) write({});
}
