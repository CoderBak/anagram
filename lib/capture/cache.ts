// lib/capture/cache.ts — per-tab L1 content-hash cache.
// Keyed by hash(modelText(text)) so a paragraph's badge stays stable across
// re-scroll / re-entry (virtualized lists). Request-level dedup lives in the
// orchestrator's scoreBlocks() and the SW router. An entry answers for one BLOCK's text —
// a whole unit, or one window of a long one; a unit's aggregate is never stored, it is
// derived again from its windows' entries.
//
// The layer belongs to ONE backend identity: the orchestrator clears it whenever the
// producing model changes (a reply names a different model) and on every Rescan, so a
// verdict from a previous backend can never be served as the current one. The
// service-worker cache behind it is model-keyed and answers a cleared L1 in a few ms.
import type { ScoreResult } from "../contract";
import { modelText, SCORING_NORMALIZATION_VERSION } from "../dom/text";
import { cyrb53 } from "../hash";
import { SCORE_CACHE_MAX_AGE_MS } from "../cachePolicy";

/** Cap of the layer. A tab lives as long as the reader keeps it open and an infinite feed
 *  scrolls past far more paragraphs than it ever shows again, so the map is bounded and
 *  the least recently used entries go first; the model-keyed worker cache behind it
 *  answers an evicted paragraph in a few ms. */
export const L1_MAX_ENTRIES = 2000;

export interface ScoreCache {
  get(text: string): ScoreResult | undefined;
  set(text: string, r: ScoreResult): void;
  keyOf(text: string): string; // sync 53-bit hash of modelText(text)
  /** Drop every entry (backend identity changed, or a full rescan). */
  clear(): void;
  size(): number;
}

export function createScoreCache(): ScoreCache {
  const l1 = new Map<string, { result: ScoreResult; at: number }>();

  function keyOf(text: string): string {
    return `n${SCORING_NORMALIZATION_VERSION}:${cyrb53(modelText(text)).toString(36)}`;
  }

  return {
    keyOf,
    get(text: string): ScoreResult | undefined {
      const key = keyOf(text);
      const hit = l1.get(key);
      if (!hit) return undefined;
      if (Date.now() - hit.at >= SCORE_CACHE_MAX_AGE_MS) { l1.delete(key); return undefined; }
      // Re-insert so Map iteration order stays least-recently-used first.
      l1.delete(key);
      l1.set(key, hit);
      return hit.result;
    },
    set(text: string, r: ScoreResult): void {
      if (r.degraded) return;
      const key = keyOf(text);
      l1.delete(key);
      l1.set(key, { result: r, at: Date.now() });
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
