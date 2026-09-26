import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
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
 *
 * Keyed, not global. It started as one shared clock across every action on
 * every account, which was correct while there was one account doing
 * everything. It stopped being correct the moment two accounts needed
 * independent pacing (leads outreach, one send per account per tick) that
 * should not be able to starve each other or the ad campaigns of their turn.
 * Each key gets its own clock; "global" is the default for anything that
 * does not care, and is what every caller used before this changed, so
 * existing behaviour (ad campaigns, joins, file sends) is unaffected.
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

interface KeyState {
  lastActionAt?: string;
  lastKind?: string;
  count?: number;
}

/** Old format was one KeyState at the file root. Read it as key "global". */
type StateFile = { [key: string]: KeyState };

/**
 * Several processes (cron ticks, ad-hoc scripts) share this file. A read that
 * failed to parse used to count as "no state", so a reader catching another
 * process mid-write would skip the wait and then overwrite every other key
 * with its own — which is how the per-account DM clocks got wiped. Only a
 * missing file means no state; anything else is retried.
 */
function readAll(): StateFile {
  const path = stateFile();
  if (!existsSync(path)) return {};
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const raw = JSON.parse(readFileSync(path, "utf8")) as StateFile | KeyState;
      if ("lastActionAt" in raw || "lastKind" in raw || "count" in raw) {
        return { global: raw as KeyState };
      }
      return raw as StateFile;
    } catch (err) {
      lastError = err;
      sleepSync(25);
    }
  }
  throw new Error(`Rate gate state at ${path} is unreadable: ${(lastError as Error)?.message}`);
}

/** Write-then-rename, so a concurrent reader sees the old file or the new one, never half of one. */
function writeAll(all: StateFile): void {
  const file = stateFile();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(all, null, 2));
  renameSync(tmp, file);
}

export function status(key = "global", intervalMsOverride?: number) {
  const state = readAll()[key] ?? {};
  const interval = intervalMsOverride ?? minIntervalMs();
  const last = state.lastActionAt ? new Date(state.lastActionAt).getTime() : 0;
  const waitMs = Math.max(0, last + interval - Date.now());
  return {
    key,
    minIntervalMs: interval,
    lastActionAt: state.lastActionAt ?? null,
    lastKind: state.lastKind ?? null,
    actionsRecorded: state.count ?? 0,
    readyIn: waitMs,
    ready: waitMs === 0,
  };
}

/**
 * Blocks until the gap has elapsed for this key, then records this action.
 * Callers get told how long they waited so it shows up in the tool result
 * rather than looking like a hang. Pass a per-account key (e.g. "leads:default")
 * to pace that account independently of everything else on the shared "global"
 * key.
 */
export async function gate(kind: string, key = "global", intervalMsOverride?: number): Promise<{ waitedMs: number }> {
  const interval = intervalMsOverride ?? minIntervalMs();
  const state = readAll()[key] ?? {};
  const last = state.lastActionAt ? new Date(state.lastActionAt).getTime() : 0;
  const waitMs = Math.max(0, last + interval - Date.now());
  if (waitMs > maxWaitMs()) {
    throw new Error(
      `Rate gate (${key}): the next ${kind} is not allowed for ${Math.ceil(waitMs / 1000)}s, which exceeds the ${Math.ceil(maxWaitMs() / 1000)}s cap. Try later, or lower TELEGRAM_MIN_ACTION_INTERVAL_MS.`,
    );
  }
  let waited = 0;
  let remaining = waitMs;
  for (;;) {
    if (remaining > 0) {
      await new Promise((r) => setTimeout(r, remaining));
      waited += remaining;
    }
    // Check-and-claim under the lock: sleepers from several processes wake at the same deadline,
    // and without it they all see the slot free and all take it.
    remaining = withLock(() => {
      const all = readAll();
      const current = all[key] ?? {};
      const at = current.lastActionAt ? new Date(current.lastActionAt).getTime() : 0;
      const left = Math.max(0, at + interval - Date.now());
      if (left > 0) return left;
      all[key] = { lastActionAt: new Date().toISOString(), lastKind: kind, count: (current.count ?? 0) + 1 };
      writeAll(all);
      return 0;
    });
    if (remaining === 0) return { waitedMs: waited };
    if (waited + remaining > maxWaitMs()) {
      throw new Error(`Rate gate (${key}): another process keeps taking the ${kind} slot; gave up after ${Math.ceil(waited / 1000)}s.`);
    }
  }
}

const sleepSync = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** A lock file held only for the few milliseconds of a read-check-write; stale ones (a crashed holder) are broken after 10s. */
function withLock<T>(fn: () => T): T {
  const lock = `${stateFile()}.lock`;
  mkdirSync(dirname(lock), { recursive: true });
  for (let attempt = 0; ; attempt++) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock);
      } catch {
        // someone else released or broke it first
      }
      if (attempt > 800) throw new Error(`Rate gate lock ${lock} stayed busy for 20s.`);
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    try { unlinkSync(lock); } catch { /* already gone */ }
  }
}

/** Used by tests and by an explicit operator reset. */
export function reset(key?: string): void {
  if (!existsSync(stateFile())) return;
  withLock(() => {
    if (!key) return writeAll({});
    const all = readAll();
    delete all[key];
    writeAll(all);
  });
}
