// lib/capture/cache.ts — per-tab L1 content-hash cache (§4.4).
// Keyed by hash(normalizeText(text)) so a paragraph's badge stays stable across
// re-scroll / re-entry (virtualized lists). Plus an in-flight Promise map
// (reference's translationsInProgress) so duplicate paragraphs scrolling in
// together collapse to one request.
import type { ScoreResult } from "../contract";
import { normalizeText } from "../dom/text";

export interface ScoreCache {
  get(text: string): ScoreResult | undefined;
  set(text: string, r: ScoreResult): void;
  inFlight(text: string): Promise<ScoreResult> | undefined;
  setInFlight(text: string, p: Promise<ScoreResult>): void;
  keyOf(text: string): string; // sync 64-bit-ish hash of normalizeText(text)
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
  const flight = new Map<string, Promise<ScoreResult>>();

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
    inFlight(text: string): Promise<ScoreResult> | undefined {
      return flight.get(keyOf(text));
    },
    setInFlight(text: string, p: Promise<ScoreResult>): void {
      const k = keyOf(text);
      flight.set(k, p);
      // Self-clean once settled so the in-flight map never leaks. Only delete if it
      // is still the same promise — a newer setInFlight for the same key wins.
      const clear = () => {
        if (flight.get(k) === p) flight.delete(k);
      };
      void p.then(clear, clear);
    },
  };
}
