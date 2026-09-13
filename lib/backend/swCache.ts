// lib/backend/swCache.ts — SW-side score cache: in-memory map in front of a persistent
// LRU-ish store in extension storage.
//
// Why persistent: an MV3 service worker is killed after ~30 s idle, so a memory-only
// cache evaporates constantly and every tab re-scores paragraphs the model already
// judged. The model is deterministic, so a hash of the normalized text plus the model
// identity ("id@ver") is a complete key — stored entries hold buckets and probabilities
// only, never text. Swapping backends (stub ↔ daemon, model upgrade) changes the key
// dimension, so stale verdicts are never served across models.
import { browser } from "#imports";
import type { ScoreResult } from "../contract";
import { normalizeText } from "../dom/text";
import { cyrb53 } from "../hash";
import { createLogger } from "../log";

const log = createLogger("swcache");

export interface SwCache {
  keyOf(text: string): string; // sync hash of normalizeText(text), incl. model-version dim
  /** Resolve many keys at once: memory first, then one storage read for the misses. */
  getMany(keys: string[]): Promise<Map<string, ScoreResult>>;
  set(text: string, r: ScoreResult): void;
}

/** Compact stored form (short keys — thousands of these live in storage.local). */
interface Stored {
  b: number;
  p: number[];
  s: number;
  k?: number;
  x?: 1;
  t: number;
}

const PREFIX = "sc:";
const MAX_ENTRIES = 20_000;
const PRUNE_TO = 15_000;
const PRUNE_EVERY_WRITES = 500;
const FLUSH_MS = 250;

function toStored(r: ScoreResult): Stored {
  const s: Stored = {
    b: r.bucket,
    p: r.probs.map((p) => Math.round(p * 1000) / 1000),
    s: Math.round(r.score * 1000) / 1000,
    t: Date.now(),
  };
  if (typeof r.tokens === "number") s.k = r.tokens;
  if (r.truncated) s.x = 1;
  return s;
}

function fromStored(id: string, s: Stored): ScoreResult | null {
  if (!s || !Array.isArray(s.p) || typeof s.b !== "number") return null;
  const r: ScoreResult = { id, bucket: s.b, probs: s.p, score: s.s };
  if (typeof s.k === "number") r.tokens = s.k;
  if (s.x) r.truncated = true;
  return r;
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

  // 53-bit key (shared cyrb53) — the 32-bit FNV-1a this used made wrong-badge
  // collisions realistic across a long browsing session.
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
    try {
      const stored = (await browser.storage.local.get(misses.map((k) => PREFIX + k))) as Record<string, Stored>;
      for (const k of misses) {
        const r = fromStored("", stored[PREFIX + k]);
        if (r) {
          memory.set(k, r);
          out.set(k, r);
        }
      }
    } catch (e) {
      log.warn("persistent cache read failed", e);
    }
    return out;
  }

  function set(text: string, r: ScoreResult): void {
    if (r.degraded) return; // fallbacks must never outlive the outage
    const k = keyOf(text);
    memory.set(k, r);
    pendingWrites.set(PREFIX + k, toStored(r));
    if (flushTimer === null) flushTimer = setTimeout(flush, FLUSH_MS);
  }

  async function flush(): Promise<void> {
    flushTimer = null;
    if (pendingWrites.size === 0) return;
    const batch = Object.fromEntries(pendingWrites);
    pendingWrites.clear();
    try {
      await browser.storage.local.set(batch);
      writesSincePrune += Object.keys(batch).length;
      if (writesSincePrune >= PRUNE_EVERY_WRITES) {
        writesSincePrune = 0;
        await prune();
      }
    } catch (e) {
      log.warn("persistent cache write failed", e);
    }
  }

  /** Keep the store bounded: drop the oldest entries once past MAX_ENTRIES. */
  async function prune(): Promise<void> {
    const all = (await browser.storage.local.get(null)) as Record<string, unknown>;
    const entries: Array<[string, number]> = [];
    for (const [k, v] of Object.entries(all)) {
      if (k.startsWith(PREFIX)) entries.push([k, (v as Stored)?.t ?? 0]);
    }
    if (entries.length <= MAX_ENTRIES) return;
    entries.sort((a, b) => a[1] - b[1]);
    const drop = entries.slice(0, entries.length - PRUNE_TO).map(([k]) => k);
    await browser.storage.local.remove(drop);
    log.log("pruned", drop.length, "cached scores");
  }

  return { keyOf, getMany, set };
}
