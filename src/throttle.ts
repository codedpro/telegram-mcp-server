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

function readAll(): StateFile {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as StateFile | KeyState;
    if ("lastActionAt" in raw || "lastKind" in raw || "count" in raw) {
      return { global: raw as KeyState };
    }
    return raw as StateFile;
  } catch {
    return {};
  }
}

function writeAll(all: StateFile): void {
  const file = stateFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(all, null, 2));
}

export function status(key = "global") {
  const state = readAll()[key] ?? {};
  const interval = minIntervalMs();
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
export async function gate(kind: string, key = "global"): Promise<{ waitedMs: number }> {
  const interval = minIntervalMs();
  const all = readAll();
  const state = all[key] ?? {};
  if (interval === 0) {
    all[key] = { lastActionAt: new Date().toISOString(), lastKind: kind, count: (state.count ?? 0) + 1 };
    writeAll(all);
    return { waitedMs: 0 };
  }
  const last = state.lastActionAt ? new Date(state.lastActionAt).getTime() : 0;
  const waitMs = Math.max(0, last + interval - Date.now());
  if (waitMs > maxWaitMs()) {
    throw new Error(
      `Rate gate (${key}): the next ${kind} is not allowed for ${Math.ceil(waitMs / 1000)}s, which exceeds the ${Math.ceil(maxWaitMs() / 1000)}s cap. Try later, or lower TELEGRAM_MIN_ACTION_INTERVAL_MS.`,
    );
  }
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));
  const fresh = readAll();
  const freshState = fresh[key] ?? {};
  fresh[key] = { lastActionAt: new Date().toISOString(), lastKind: kind, count: (freshState.count ?? 0) + 1 };
  writeAll(fresh);
  return { waitedMs: waitMs };
}

/** Used by tests and by an explicit operator reset. */
export function reset(key?: string): void {
  if (!existsSync(stateFile())) return;
  if (!key) {
    writeAll({});
    return;
  }
  const all = readAll();
  delete all[key];
  writeAll(all);
}
