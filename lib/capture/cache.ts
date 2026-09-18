// lib/capture/cache.ts — per-tab L1 content-hash cache.
// Keyed by hash(normalizeText(text)) so a paragraph's badge stays stable across
// re-scroll / re-entry (virtualized lists). Request-level dedup lives in the
// orchestrator's send() and the SW router.
//
// The layer belongs to ONE backend identity: the orchestrator clears it whenever the
// producing model changes (a reply names a different model) and on every Rescan, so a
// verdict from a previous backend can never be served as the current one. The
// service-worker cache behind it is model-keyed and answers a cleared L1 in a few ms.
import type { ScoreResult } from "../contract";
import { normalizeText } from "../dom/text";
import { cyrb53 } from "../hash";

/** Cap of the layer. A tab lives as long as the reader keeps it open and an infinite feed
 *  scrolls past far more paragraphs than it ever shows again, so the map is bounded and
 *  the least recently used entries go first; the model-keyed worker cache behind it
 *  answers an evicted paragraph in a few ms. */
export const L1_MAX_ENTRIES = 2000;

export interface ScoreCache {
  get(text: string): ScoreResult | undefined;
  set(text: string, r: ScoreResult): void;
  keyOf(text: string): string; // sync 53-bit hash of normalizeText(text)
  /** Drop every entry (backend identity changed, or a full rescan). */
  clear(): void;
  size(): number;
}

export function createScoreCache(): ScoreCache {
  const l1 = new Map<string, ScoreResult>();

  function keyOf(text: string): string {
    return cyrb53(normalizeText(text)).toString(36);
  }

  return {
    keyOf,
    get(text: string): ScoreResult | undefined {
      const key = keyOf(text);
      const hit = l1.get(key);
      if (!hit) return undefined;
      // Re-insert so Map iteration order stays least-recently-used first.
      l1.delete(key);
      l1.set(key, hit);
      return hit;
    },
    set(text: string, r: ScoreResult): void {
      const key = keyOf(text);
      l1.delete(key);
      l1.set(key, r);
      while (l1.size > L1_MAX_ENTRIES) {
        const oldest = l1.keys().next();
        if (oldest.done) break;
        l1.delete(oldest.value);
      }
    },
    clear(): void {
      l1.clear();
    },
    size(): number {
      return l1.size;
    },
  };
}
