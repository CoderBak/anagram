// lib/backend/swCache.ts — SW-side score cache: in-memory map in front of a persistent
// IndexedDB store (via `idb`, the thin promise wrapper).
//
// Why persistent: an MV3 service worker is killed after ~30 s idle, so a memory-only
// cache evaporates constantly and every tab re-scores paragraphs the model already
// judged. The model is deterministic, so a hash of the normalized text plus the model
// identity ("id@ver") is a complete key — stored rows hold buckets and probabilities
// only, never text. A different daemon model or checkpoint changes the key dimension, so
// stale verdicts are never served across models.
//
// Why IndexedDB rather than storage.local: rows are read in one transaction instead of
// a JSON round-trip, writes are structured clones, the store is not bounded by the
// 10 MB storage.local quota, and pruning walks a timestamp index cursor to drop the
// oldest rows instead of loading every key in the extension's storage.
//
// WHAT NEVER REACHES THE DISK. A verdict that exists only because somebody read something
// in a private window stays in this worker's memory and goes when the worker does — see
// `persist` below. And nothing is kept forever: a row is thirty days old at the most,
// counted from when it was written, because a cache with no end to it is a record of what
// somebody has been reading.
import { browser } from "#imports";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ScoreResult } from "../contract";
import { normalizeText } from "../dom/text";
import { cyrb53 } from "../hash";
import { createLogger } from "../log";

const log = createLogger("swcache");

export interface SwCache {
  /** Sync key: `<dim>:<hash of normalizeText(text)>` — `dim` is the backend identity
   *  ("id@ver") the caller snapshotted for this request (router.ts modelDim). */
  keyOf(text: string, dim: string): string;
  /**
   * Resolve many keys at once: memory first, then one IndexedDB transaction for the misses.
   * `persist` false — the reader is a private tab — means the lookup itself writes nothing,
   * not even to move a memory-only verdict onto the disk.
   */
  getMany(keys: string[], persist?: boolean): Promise<Map<string, ScoreResult>>;
  /** Store a REAL result under the identity that produced it. `persist` false keeps it in
   *  memory alone: it exists only because of a private tab. */
  set(text: string, r: ScoreResult, dim: string, persist?: boolean): void;
  /** Forget every verdict: the memory layer, the writes still waiting for their flush, and
   *  the persistent store (options → "Clear cached verdicts"). */
  clear(): Promise<void>;
  /** How many verdicts are on the disk — the number the options page shows. */
  count(): Promise<number>;
}

/** Compact stored row (short field names — tens of thousands of these live in the store). */
export interface Stored {
  /** Cache key ("model@ver:hash") — the object store's keyPath. */
  key: string;
  b: number;
  p: number[];
  s: number;
  k?: number;
  x?: 1;
  l?: string;
  lp?: number;
  u?: 1;
  t: number;
}

interface ScoreDB extends DBSchema {
  scores: { key: string; value: Stored; indexes: { byTime: number } };
}

const DB_NAME = "anagram-scores";
const STORE = "scores";
/** Cap of the in-memory layer in front of the store. A worker that survives a long
 *  reading session answers for every tab, so without a bound the map holds every
 *  paragraph the browser has ever shown; the persistent layer below has its own, larger
 *  cap and is what actually remembers. */
export const MEMORY_MAX_ENTRIES = 5000;
const MAX_ENTRIES = 20_000;
const PRUNE_TO = 15_000;
const PRUNE_EVERY_WRITES = 500;
const FLUSH_MS = 250;
/**
 * How long a verdict is kept. The model is deterministic, so a stored verdict does not go
 * stale by itself — this is retention, not freshness: a cache nothing ever leaves is a
 * record of what somebody has read, growing for as long as the extension is installed.
 * Thirty days covers the revisits the cache exists for and leaves nothing older behind.
 *
 * The clock starts when a row is WRITTEN and a hit does not restart it, which is how the
 * store already behaved (`t` is set in toStored and never touched again). It is also the
 * only version of the rule that can hold: refreshing a row on every hit would mean a
 * lookup writes to the disk, and a lookup from a private tab must write nothing at all.
 */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Key prefix of the pre-IndexedDB storage.local cache; swept once on first open. */
const LEGACY_PREFIX = "sc:";
const LEGACY_SWEPT_FLAG = "scLegacySwept";

function toStored(key: string, r: ScoreResult): Stored {
  const s: Stored = {
    key,
    b: r.bucket,
    p: r.probs.map((p) => Math.round(p * 1000) / 1000),
    s: Math.round(r.score * 1000) / 1000,
    t: Date.now(),
  };
  if (typeof r.tokens === "number") s.k = r.tokens;
  if (r.truncated) s.x = 1;
  if (r.lang) s.l = r.lang;
  if (typeof r.lang_prob === "number") s.lp = r.lang_prob;
  if (r.unsupported) s.u = 1;
  return s;
}

function fromStored(s: Stored | undefined): ScoreResult | null {
  if (!s || !Array.isArray(s.p) || typeof s.b !== "number") return null;
  const r: ScoreResult = { id: "", bucket: s.b, probs: s.p, score: s.s };
  if (typeof s.k === "number") r.tokens = s.k;
  if (s.x) r.truncated = true;
  if (s.l) r.lang = s.l;
  if (typeof s.lp === "number") r.lang_prob = s.lp;
  if (s.u) r.unsupported = true;
  return r;
}

/**
 * The persistent half, behind an interface of five operations. It is separate from the
 * cache for two reasons: a browser that will not open an IndexedDB (or a test environment
 * that has none) leaves the memory layer working exactly as before, and the rules the
 * layer above enforces — what may be written, what expires, what a private tab leaves
 * behind — can be proved against a store that is not a database.
 */
export interface ScoreStore {
  get(keys: string[]): Promise<Array<Stored | undefined>>;
  put(rows: Stored[]): Promise<void>;
  clear(): Promise<void>;
  count(): Promise<number>;
  /** Drop every row written before `cutoff`; answers with how many went. */
  dropOlderThan(cutoff: number): Promise<number>;
  /** Over `max` rows, drop the oldest until `keep` remain; answers with how many went. */
  dropOldest(max: number, keep: number): Promise<number>;
}

let _db: Promise<IDBPDatabase<ScoreDB> | null> | null = null;

/** Open (once per worker lifetime); null when IndexedDB is unavailable → memory-only. */
function db(): Promise<IDBPDatabase<ScoreDB> | null> {
  if (!_db) {
    _db = (async () => {
      try {
        const d = await openDB<ScoreDB>(DB_NAME, 1, {
          upgrade(u) {
            u.createObjectStore(STORE, { keyPath: "key" }).createIndex("byTime", "t");
          },
        });
        void sweepLegacyStore();
        return d;
      } catch (e) {
        log.warn("IndexedDB unavailable — score cache is memory-only this session", e);
        return null;
      }
    })();
  }
  return _db;
}

/** Delete rows from the oldest end of the timestamp index; `while` decides how far. */
async function dropFromOldest(
  d: IDBPDatabase<ScoreDB>,
  range: IDBKeyRange | null,
  limit: number,
): Promise<number> {
  const tx = d.transaction(STORE, "readwrite");
  let cursor = await tx.store.index("byTime").openCursor(range);
  let dropped = 0;
  while (cursor && dropped < limit) {
    await cursor.delete();
    dropped++;
    cursor = await cursor.continue();
  }
  await tx.done;
  return dropped;
}

/**
 * The real store. Every operation answers quietly when there is no database at all — a
 * browser that refuses one, a private window in a browser that keeps extensions out of
 * IndexedDB — so a missing store never keeps the memory layer from working.
 */
export function indexedDbStore(): ScoreStore {
  return {
    async get(keys) {
      const d = await db();
      if (!d) return keys.map(() => undefined);
      try {
        const tx = d.transaction(STORE, "readonly");
        const rows = await Promise.all(keys.map((k) => tx.store.get(k)));
        await tx.done;
        return rows;
      } catch (e) {
        log.warn("persistent cache read failed", e);
        return keys.map(() => undefined);
      }
    },
    async put(rows) {
      const d = await db();
      if (!d) return;
      try {
        const tx = d.transaction(STORE, "readwrite");
        for (const row of rows) void tx.store.put(row);
        await tx.done;
      } catch (e) {
        log.warn("persistent cache write failed", e);
      }
    },
    async clear() {
      try {
        const d = await db();
        if (!d) return; // memory-only session: there is nothing persistent to empty
        await d.clear(STORE);
      } catch (e) {
        log.warn("persistent cache clear failed", e);
      }
    },
    async count() {
      try {
        const d = await db();
        return d ? await d.count(STORE) : 0;
      } catch (e) {
        log.warn("persistent cache count failed", e);
        return 0;
      }
    },
    async dropOlderThan(cutoff) {
      try {
        const d = await db();
        if (!d) return 0;
        return await dropFromOldest(d, IDBKeyRange.upperBound(cutoff, true), Number.POSITIVE_INFINITY);
      } catch (e) {
        log.warn("expiring old verdicts failed", e);
        return 0;
      }
    },
    async dropOldest(max, keep) {
      try {
        const d = await db();
        if (!d) return 0;
        const total = await d.count(STORE);
        if (total <= max) return 0;
        return await dropFromOldest(d, null, total - keep);
      } catch (e) {
        log.warn("pruning the cache failed", e);
        return 0;
      }
    },
  };
}

/** One-time removal of rows the previous storage.local-backed cache left behind. */
async function sweepLegacyStore(): Promise<void> {
  try {
    const flag = await browser.storage.local.get(LEGACY_SWEPT_FLAG);
    if (flag[LEGACY_SWEPT_FLAG]) return;
    const all = await browser.storage.local.get(null);
    const stale = Object.keys(all).filter((k) => k.startsWith(LEGACY_PREFIX));
    if (stale.length > 0) await browser.storage.local.remove(stale);
    await browser.storage.local.set({ [LEGACY_SWEPT_FLAG]: true });
    if (stale.length > 0) log.log("swept", stale.length, "legacy cache rows from storage.local");
  } catch {
    /* storage unavailable — nothing to sweep */
  }
}

export function createSwCache(store: ScoreStore = indexedDbStore()): SwCache {
  const memory = new Map<string, ScoreResult>();
  const pendingWrites = new Map<string, Stored>();
  /**
   * Verdicts that are in memory and on no disk: they exist only because a private tab
   * asked for them. A normal tab asking for the same text later moves one across — it
   * would have produced the identical verdict itself, so persisting it then reveals
   * nothing about the private window that happened to get there first.
   */
  const memoryOnly = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let writesSincePrune = 0;
  /** Bumped by clear(): a flush that took its batch before the clear must not put those
   *  rows back into the store that was just emptied. */
  let generation = 0;
  /** The thirty-day sweep, once per worker lifetime. */
  let expired: Promise<void> | null = null;

  const keyOf = (text: string, dim: string): string =>
    `${dim}:${cyrb53(normalizeText(text)).toString(36)}`;

  /**
   * Drop what has aged out. This runs on the first thing the cache is asked to do rather
   * than when the worker starts: an MV3 worker is woken by a badge message as readily as
   * by a batch, and opening a database for one is a cost with nothing behind it.
   */
  function expireOnce(): void {
    expired ??= store
      .dropOlderThan(Date.now() - MAX_AGE_MS)
      .then((dropped) => {
        if (dropped > 0) log.log("dropped", dropped, "verdicts older than 30 days");
      })
      .catch(() => undefined);
  }

  /** Read the memory layer, moving a hit to the young end: Map iteration order is the
   *  recency order the eviction below walks. */
  function recall(key: string): ScoreResult | undefined {
    const hit = memory.get(key);
    if (!hit) return undefined;
    memory.delete(key);
    memory.set(key, hit);
    return hit;
  }

  /** Write the memory layer and drop the least recently used entries over the cap. */
  function remember(key: string, r: ScoreResult): void {
    memory.delete(key);
    memory.set(key, r);
    while (memory.size > MEMORY_MAX_ENTRIES) {
      const oldest = memory.keys().next();
      if (oldest.done) break;
      memory.delete(oldest.value);
      memoryOnly.delete(oldest.value);
    }
  }

  /** Queue a row for the disk. The only path to the persistent store there is. */
  function queueWrite(key: string, r: ScoreResult): void {
    memoryOnly.delete(key);
    pendingWrites.set(key, toStored(key, r));
    if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  async function getMany(keys: string[], persist = true): Promise<Map<string, ScoreResult>> {
    expireOnce();
    const out = new Map<string, ScoreResult>();
    const misses: string[] = [];
    for (const k of keys) {
      const hit = recall(k);
      if (hit) {
        out.set(k, hit);
        // A normal tab has asked for a verdict a private one produced: it would have
        // produced the same, so from here on it may live on the disk like any other.
        if (persist && memoryOnly.has(k)) queueWrite(k, hit);
      } else misses.push(k);
    }
    if (misses.length === 0) return out;
    const rows = await store.get(misses);
    rows.forEach((row, i) => {
      const r = fromStored(row);
      if (r) {
        remember(misses[i], r);
        out.set(misses[i], r);
      }
    });
    return out;
  }

  function set(text: string, r: ScoreResult, dim: string, persist = true): void {
    if (r.degraded) return; // fallbacks must never outlive the outage
    expireOnce();
    const k = keyOf(text, dim);
    remember(k, r);
    if (persist) queueWrite(k, r);
    else if (!pendingWrites.has(k)) memoryOnly.add(k);
  }

  async function flush(): Promise<void> {
    flushTimer = null;
    if (pendingWrites.size === 0) return;
    const batch = [...pendingWrites.values()];
    const seq = generation;
    pendingWrites.clear();
    await store.put(batch);
    if (seq !== generation) {
      // A clear landed while this batch was in the air. These rows describe verdicts it
      // asked to be dropped, so they go with them rather than reappearing behind it.
      await store.clear();
      return;
    }
    writesSincePrune += batch.length;
    if (writesSincePrune >= PRUNE_EVERY_WRITES) {
      writesSincePrune = 0;
      const stale = await store.dropOlderThan(Date.now() - MAX_AGE_MS);
      const over = await store.dropOldest(MAX_ENTRIES, PRUNE_TO);
      if (stale + over > 0) log.log("pruned", stale + over, "cached scores");
    }
  }

  /**
   * Forget everything. Both layers go at once, pending writes included — they describe the
   * verdicts being dropped — so the next lookup for any paragraph reaches the daemon again.
   */
  async function clear(): Promise<void> {
    generation++;
    memory.clear();
    memoryOnly.clear();
    pendingWrites.clear();
    if (flushTimer !== null) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
    writesSincePrune = 0;
    await store.clear();
  }

  return { keyOf, getMany, set, clear, count: () => store.count() };
}
