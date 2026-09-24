// lib/backend/swCache.ts — SW-side score cache: in-memory map in front of a persistent
// IndexedDB store (via `idb`, the thin promise wrapper).
//
// Why persistent: an MV3 service worker is killed after ~30 s idle, so a memory-only
// cache evaporates constantly and every tab re-scores paragraphs the model already
// judged. The model is deterministic, so a hash of the normalized text plus the model
// identity and normalization version define the key — stored rows hold buckets and probabilities
// only, never text. A different model, checkpoint or calibration changes the key dimension, so
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
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ScoreResult } from "../contract";
import { normalizeText, SCORING_NORMALIZATION_VERSION } from "../dom/text";
import { cyrb53 } from "../hash";
import { SCORE_CACHE_MAX_AGE_MS, type ScoreCacheMode } from "../cachePolicy";
import { createLogger } from "../log";

const log = createLogger("swcache");

export interface SwCache {
  /** Sync key: `<normalization version>:<dim>:<hash of normalizeText(text)>`;
   * `dim` is the complete backend identity snapshotted by router.ts modelDim. */
  keyOf(text: string, dim: string): string;
  /**
   * Resolve many keys at once: memory first, then one IndexedDB transaction for the misses.
   * `persist` false — the reader is a private tab — means the lookup itself writes nothing,
   * not even to move a memory-only verdict onto the disk.
   */
  getMany(keys: string[], persist?: boolean): Promise<Map<string, ScoreResult>>;
  /** Store a REAL result under the identity that produced it. `persist` false keeps it in
   *  memory alone: it exists only because of a private tab. */
  set(text: string, r: ScoreResult, dim: string, persist?: boolean, epoch?: number): void;
  /** Forget every verdict: the memory layer, the writes still waiting for their flush, and
   *  the persistent store (options → "Clear cached verdicts"). */
  clear(): Promise<void>;
  /** Current invalidation epoch; writes from an earlier epoch are discarded. */
  epoch(): number;
  /** Switch persistence, deleting what the disk holds. `restored` adopts the mode a worker
   *  slept in instead, which deletes nothing. */
  setMode(mode: ScoreCacheMode, restored?: boolean): Promise<void>;
  /** How many verdicts are on the disk — the number the options page shows. */
  count(): Promise<number>;
}

/** Compact stored row (short field names — tens of thousands of these live in the store). */
export interface Stored {
  /** Versioned normalized-text/model cache key — the object store's keyPath. */
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
const MAX_AGE_MS = SCORE_CACHE_MAX_AGE_MS;

function toStored(key: string, r: ScoreResult, at = Date.now()): Stored {
  const s: Stored = {
    key,
    b: r.bucket,
    p: r.probs.map((p) => Math.round(p * 1000) / 1000),
    s: Math.round(r.score * 1000) / 1000,
    t: at,
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
 * The real store. Reads may fall back to memory when storage is unavailable. Mutations
 * and counts reject on failure: an unavailable database is not proof of deletion.
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
      if (!d) throw new Error("Persistent score cache is unavailable");
      const tx = d.transaction(STORE, "readwrite");
      for (const row of rows) void tx.store.put(row);
      await tx.done;
    },
    async clear() {
      const d = await db();
      if (!d) throw new Error("Persistent score cache could not be opened; deletion was not verified");
      await d.clear(STORE);
    },
    async count() {
      const d = await db();
      if (!d) throw new Error("Persistent score cache is unavailable");
      return d.count(STORE);
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

export function createSwCache(store: ScoreStore = indexedDbStore()): SwCache {
  const memory = new Map<string, { result: ScoreResult; at: number }>();
  const memoryOnly = new Set<string>();
  const pendingWrites = new Map<string, Stored>();
  let mode: ScoreCacheMode = "persistent";
  let generation = 0;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let writesSincePrune = 0;
  let expired = false;
  let diskBlocked = false;
  let clearing: Promise<void> | undefined;
  // Every persistent mutation joins one chain. A clear is after already-started writes
  // and before new writes, so an old flush never needs a destructive follow-up clear.
  let writeTail: Promise<void> = Promise.resolve();
  function mutate(task: () => Promise<void>): Promise<void> {
    const operation = writeTail.then(task);
    writeTail = operation.catch(() => undefined);
    return operation;
  }
  const keyOf = (text: string, dim: string): string =>
    `n${SCORING_NORMALIZATION_VERSION}:${dim}:${cyrb53(normalizeText(text)).toString(36)}`;
  const current = (seq: number): boolean => seq === generation;
  const fresh = (at: number): boolean => Number.isFinite(at) && Date.now() - at < MAX_AGE_MS;

  function expireOnce(): void {
    if (expired || mode !== "persistent" || diskBlocked) return;
    expired = true;
    const seq = generation;
    void mutate(async () => {
      if (current(seq) && mode === "persistent" && !diskBlocked)
        await store.dropOlderThan(Date.now() - MAX_AGE_MS);
    }).catch((error) => log.warn("persistent expiration failed", error));
  }
  function remember(key: string, result: ScoreResult, at: number): void {
    memory.delete(key);
    memory.set(key, { result, at });
    while (memory.size > MEMORY_MAX_ENTRIES) {
      const oldest = memory.keys().next().value!;
      memory.delete(oldest); memoryOnly.delete(oldest); pendingWrites.delete(oldest);
    }
  }
  function recall(key: string): { result: ScoreResult; at: number } | undefined {
    const hit = memory.get(key);
    if (!hit) return;
    memory.delete(key);
    if (!fresh(hit.at)) { memoryOnly.delete(key); pendingWrites.delete(key); return; }
    memory.set(key, hit);
    return hit;
  }
  function queueWrite(key: string, result: ScoreResult, at: number): void {
    if (mode !== "persistent") return;
    pendingWrites.set(key, toStored(key, result, at));
    if (flushTimer === null) flushTimer = setTimeout(() => {
      void flush().catch((error) => log.warn("persistent cache write failed", error));
    }, FLUSH_MS);
  }
  async function getMany(keys: string[], persist = true): Promise<Map<string, ScoreResult>> {
    const seq = generation;
    // Private/session reads do not trigger pruning or any other persistent mutation.
    if (persist) expireOnce();
    const out = new Map<string, ScoreResult>(), misses: string[] = [];
    for (const key of keys) {
      const hit = recall(key);
      if (hit) {
        out.set(key, hit.result);
        if (persist && memoryOnly.has(key)) queueWrite(key, hit.result, hit.at);
      } else misses.push(key);
    }
    if (!misses.length || mode === "session") return out;
    // A read begun after clear must wait for its deletion, even if an older put is slow.
    await writeTail;
    if (!current(seq)) return new Map();
    if (diskBlocked) return out;
    const rows = await store.get(misses);
    if (!current(seq) || mode !== "persistent") return new Map();
    rows.forEach((row, index) => {
      if (!row || row.key !== misses[index] || !fresh(row.t)) return;
      const result = fromStored(row);
      if (!result) return;
      remember(row.key, result, row.t);
      memoryOnly.delete(row.key);
      out.set(row.key, result);
    });
    return out;
  }
  function set(text: string, result: ScoreResult, dim: string, persist = true, seq = generation): void {
    if (result.degraded || !current(seq)) return;
    if (persist) expireOnce();
    const key = keyOf(text, dim), at = Date.now();
    remember(key, result, at);
    memoryOnly.add(key);
    if (persist) queueWrite(key, result, at);
  }
  async function flush(): Promise<void> {
    flushTimer = null;
    const seq = generation, batch = [...pendingWrites.values()];
    pendingWrites.clear();
    if (!batch.length) return;
    await mutate(async () => {
      if (!current(seq) || mode !== "persistent" || diskBlocked) return;
      await store.put(batch);
      if (!current(seq)) return; // the queued clear owns deletion of these old writes
      for (const row of batch) if (memory.get(row.key)?.at === row.t) memoryOnly.delete(row.key);
      writesSincePrune += batch.length;
      if (writesSincePrune >= PRUNE_EVERY_WRITES) {
        writesSincePrune = 0;
        await store.dropOlderThan(Date.now() - MAX_AGE_MS);
        if (current(seq)) await store.dropOldest(MAX_ENTRIES, PRUNE_TO);
      }
    });
  }
  function invalidate(): number {
    generation++;
    memory.clear(); memoryOnly.clear(); pendingWrites.clear();
    if (flushTimer !== null) clearTimeout(flushTimer);
    flushTimer = null; writesSincePrune = 0;
    return generation;
  }
  function clear(): Promise<void> {
    const seq = invalidate();
    diskBlocked = true;
    const operation = mutate(async () => {
      await store.clear(); // failure is reported; old disk rows remain blocked from reads
      if (current(seq)) diskBlocked = false;
    });
    clearing = operation;
    const done = () => { if (clearing === operation) clearing = undefined; };
    void operation.then(done, done);
    return operation;
  }
  function setMode(next: ScoreCacheMode, restored = false): Promise<void> {
    // A worker wakes with nothing in memory. Session mode emptied the disk when it was
    // chosen (a deletion that failed then was reported, and the next clear repeats it), so
    // waking into it only has to keep the disk gate shut.
    if (restored) { mode = next; return Promise.resolve(); }
    if (next === mode) {
      if (clearing) return clearing;
      if (!diskBlocked) return Promise.resolve();
    }
    // Disable disk activity synchronously, before waiting for old writes/deletion.
    mode = next;
    return clear();
  }
  async function count(): Promise<number> {
    if (mode === "session") {
      if (clearing) await clearing;
      if (diskBlocked) throw new Error("Persistent cache deletion has not been verified");
      for (const key of [...memory.keys()]) recall(key);
      return memory.size;
    }
    await writeTail;
    return store.count();
  }
  return { keyOf, getMany, set, clear, epoch: () => generation, setMode, count };
}
