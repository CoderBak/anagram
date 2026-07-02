// lib/capture/cache.ts — per-tab L1 content-hash cache.
// Keyed by hash(normalizeText(text)) so a paragraph's badge stays stable across
// re-scroll / re-entry (virtualized lists). Request-level dedup lives in the
// orchestrator's send() and the SW router.
import type { ScoreResult } from "../contract";
import { normalizeText } from "../dom/text";

export interface ScoreCache {
  get(text: string): ScoreResult | undefined;
  set(text: string, r: ScoreResult): void;
  keyOf(text: string): string; // sync 53-bit hash of normalizeText(text)
}

/**
 * cyrb53 — a small synchronous 53-bit string hash. No crypto needed for a per-tab
 * cache key; collisions are astronomically unlikely at page scale.
 */
function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

export function createScoreCache(): ScoreCache {
  const l1 = new Map<string, ScoreResult>();

  function keyOf(text: string): string {
    return cyrb53(normalizeText(text)).toString(36);
  }

  return {
    keyOf,
    get(text: string): ScoreResult | undefined {
      return l1.get(keyOf(text));
    },
    set(text: string, r: ScoreResult): void {
      l1.set(keyOf(text), r);
    },
  };
}
