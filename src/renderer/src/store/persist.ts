/**
 * Slice persistence to localStorage, with a priority order for what survives when the
 * origin's storage runs out.
 *
 * Two separate problems are solved here.
 *
 * **A write must never abort the state change.** Every slice persists itself from INSIDE
 * its Immer reducer, so a throwing `localStorage.setItem` aborts the whole `produce` and
 * RTK discards the action — the setting silently does not apply. That is how a full quota
 * once froze the MIDI follow chip in the "on" position and stopped the open show from
 * being remembered, both at once and with no error anywhere.
 *
 * **Not everything stored is equally important.** In priority order:
 *
 *   1. Settings, the open show, musician settings — small, irreplaceable, never evicted.
 *   2. Offline data for the songs in the CURRENT SHOW — the minimum needed to present
 *      without a server. Given up only when nothing else is left.
 *   3. Everything else: songs from other shows, cached styles. Re-fetchable, so these go
 *      first and are also capped proactively (see `registerEvictor` callers).
 *
 * Tier 3 is trimmed on a budget as it grows, so in practice the quota is never reached;
 * the eviction below is the safety net for when it is anyway.
 */

/** Must match settingsSlice's SETTINGS_KEY — inlined to avoid importing the slice that imports us. */
export const SETTINGS_KEY = 'presenter_settings';

/**
 * Frees storage and reports whether it actually managed to. Registered by the slice that
 * owns the data, so this module never needs to know a cache's shape.
 */
export interface Evictor {
  /** For the log line — says what was given up. */
  name: string;
  /** Lower runs first. Use the tier numbers documented above. */
  priority: number;
  /** Returns true only if something was actually freed. */
  run: () => boolean;
}

const evictors: Evictor[] = [];

/** Register a way to free space. Called once at slice module load. */
export function registerEvictor(evictor: Evictor): void {
  evictors.push(evictor);
  evictors.sort((a, b) => a.priority - b.priority);
}

/** Eviction tiers, so callers name their priority instead of guessing a number. */
export const EVICT_PRIORITY = {
  /** Styles, songs from other shows — always re-fetchable. */
  OPTIONAL_CACHE: 10,
  /** Offline songs for the current show — the last thing to go. */
  CURRENT_SHOW_CACHE: 90,
} as const;

let warnedAboutQuota = false;

/**
 * A storage failure caused by being full, as opposed to a serialization bug. Browsers
 * disagree on the name and the legacy code, so check every spelling.
 */
function isQuotaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    (err as { code?: number }).code === 22 ||
    (err as { code?: number }).code === 1014
  );
}

/**
 * Tell the UI that storage filled up, so the operator finds out from a notification
 * rather than from a setting that quietly forgets itself. `freed` distinguishes "we made
 * room by dropping offline data" from "nothing could be saved at all".
 */
function announce(detail: { key: string; freed: string[]; saved: boolean }): void {
  window.dispatchEvent(new CustomEvent('presenter:storage-full', { detail }));
}

/**
 * Write `value` under `key`. Never throws, so a storage failure can never discard the
 * state change that triggered it.
 *
 * On a full quota the registered evictors run in priority order, retrying after each, so
 * the least valuable data is given up first and only as much as is actually needed.
 *
 * Returns false when the value could not be stored — the change still applies for this
 * session, it just will not survive a restart.
 */
export function persistState(key: string, value: unknown): boolean {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (err) {
    console.error(`[persist] could not serialize "${key}" — not saved`, err);
    return false;
  }

  try {
    localStorage.setItem(key, serialized);
    requestDiskFlush();
    return true;
  } catch (err) {
    if (!isQuotaError(err)) {
      console.error(`[persist] could not save "${key}"`, err);
      return false;
    }

    // Out of room. Give up the cheapest data first and retry after each step, so a small
    // overflow costs only the styles rather than the whole offline cache.
    const freed: string[] = [];
    for (const evictor of evictors) {
      if (!evictor.run()) continue;
      freed.push(evictor.name);
      try {
        localStorage.setItem(key, serialized);
        requestDiskFlush();
        console.warn(`[persist] storage was full — freed ${freed.join(', ')} to save "${key}"`);
        announce({ key, freed, saved: true });
        return true;
      } catch {
        // Still not enough — carry on to the next tier.
      }
    }

    if (!warnedAboutQuota) {
      warnedAboutQuota = true;
      console.error(`[persist] storage is full and could not be freed — "${key}" will not survive a restart.`);
    }
    announce({ key, freed, saved: false });
    return false;
  }
}

/**
 * How long a burst of writes may gather before the desktop app forces them to disk.
 *
 * A successful `setItem` is not yet on disk. Chromium keeps localStorage changes in memory
 * and commits them lazily — 5 s after a change at best, stretched further once 60 commits
 * an hour are used up. A process that ends before then loses them, and the ways it ends
 * that way are the ones that skip the orderly shutdown which would flush: a Windows update
 * restart or log-off, a crash, a force-kill. So every write asks the main process for an
 * immediate commit, at most once per interval.
 */
const FLUSH_INTERVAL_MS = 1000;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function requestDiskFlush(): void {
  if (flushTimer !== null) return;
  const api = (window as { api?: { flushStorage?: () => void } }).api;
  // The browser build has no main process to ask; the browser flushes on its own schedule.
  if (!api?.flushStorage) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    api.flushStorage?.();
  }, FLUSH_INTERVAL_MS);
}
