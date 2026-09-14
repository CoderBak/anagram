// lib/backend/swCache.ts — SW-side score cache: in-memory map in front of a persistent
// IndexedDB store (via `idb`, the thin promise wrapper).
//
// Why persistent: an MV3 service worker is killed after ~30 s idle, so a memory-only
// cache evaporates constantly and every tab re-scores paragraphs the model already
// judged. The model is deterministic, so a hash of the normalized text plus the model
// identity ("id@ver") is a complete key — stored rows hold buckets and probabilities
// only, never text. Swapping backends (stub ↔ daemon, model upgrade) changes the key
// dimension, so stale verdicts are never served across models.
//
// Why IndexedDB rather than storage.local: rows are read in one transaction instead of
// a JSON round-trip, writes are structured clones, the store is not bounded by the
// 10 MB storage.local quota, and pruning walks a timestamp index cursor to drop the
// oldest rows instead of loading every key in the extension's storage.
import { browser } from "#imports";
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { ScoreResult } from "../contract";
import { normalizeText } from "../dom/text";
import { cyrb53 } from "../hash";
import { createLogger } from "../log";

const log = createLogger("swcache");

export interface SwCache {
  keyOf(text: string): string; // sync hash of normalizeText(text), incl. model-version dim
  /** Resolve many keys at once: memory first, then one IndexedDB transaction for the misses. */
  getMany(keys: string[]): Promise<Map<string, ScoreResult>>;
  set(text: string, r: ScoreResult): void;
}

/** Compact stored row (short field names — tens of thousands of these live in the store). */
interface Stored {
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
const MAX_ENTRIES = 20_000;
const PRUNE_TO = 15_000;
const PRUNE_EVERY_WRITES = 500;
const FLUSH_MS = 250;
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

/**
 * @param modelDim current backend identity ("id@ver") — evaluated per call, because
 *   the active backend can change mid-session (daemon started/stopped, mode switched).
 */
export function createSwCache(modelDim: () => string): SwCache {
  const memory = new Map<string, ScoreResult>();
  const pendingWrites = new Map<string, Stored>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let writesSincePrune = 0;

  const keyOf = (text: string): string =>
    `${modelDim()}:${cyrb53(normalizeText(text)).toString(36)}`;

  async function getMany(keys: string[]): Promise<Map<string, ScoreResult>> {
    const out = new Map<string, ScoreResult>();
    const misses: string[] = [];
    for (const k of keys) {
      const hit = memory.get(k);
      if (hit) out.set(k, hit);
      else if (!out.has(k)) misses.push(k);
    }
    if (misses.length === 0) return out;
    const d = await db();
    if (!d) return out;
    try {
      const tx = d.transaction(STORE, "readonly");
      const rows = await Promise.all(misses.map((k) => tx.store.get(k)));
      await tx.done;
      rows.forEach((row, i) => {
        const r = fromStored(row);
        if (r) {
          memory.set(misses[i], r);
          out.set(misses[i], r);
        }
      });
    } catch (e) {
      log.warn("persistent cache read failed", e);
    }
    return out;
  }

  function set(text: string, r: ScoreResult): void {
    if (r.degraded) return; // fallbacks must never outlive the outage
    const k = keyOf(text);
    memory.set(k, r);
    pendingWrites.set(k, toStored(k, r));
    if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  async function flush(): Promise<void> {
    flushTimer = null;
    if (pendingWrites.size === 0) return;
    const batch = [...pendingWrites.values()];
    pendingWrites.clear();
    const d = await db();
    if (!d) return;
    try {
      const tx = d.transaction(STORE, "readwrite");
      for (const row of batch) void tx.store.put(row);
      await tx.done;
      writesSincePrune += batch.length;
      if (writesSincePrune >= PRUNE_EVERY_WRITES) {
        writesSincePrune = 0;
        await prune(d);
      }
    } catch (e) {
      log.warn("persistent cache write failed", e);
    }
  }

  /** Keep the store bounded: walk the timestamp index and drop the oldest rows. */
  async function prune(d: IDBPDatabase<ScoreDB>): Promise<void> {
    const total = await d.count(STORE);
    if (total <= MAX_ENTRIES) return;
    let toDrop = total - PRUNE_TO;
    const tx = d.transaction(STORE, "readwrite");
    let cursor = await tx.store.index("byTime").openCursor();
    while (cursor && toDrop > 0) {
      await cursor.delete();
      toDrop--;
      cursor = await cursor.continue();
    }
    await tx.done;
    log.log("pruned", total - PRUNE_TO, "cached scores");
  }

  return { keyOf, getMany, set };
}
