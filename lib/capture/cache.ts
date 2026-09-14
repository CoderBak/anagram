// lib/capture/cache.ts — per-tab L1 content-hash cache.
// Keyed by hash(normalizeText(text)) so a paragraph's badge stays stable across
// re-scroll / re-entry (virtualized lists). Request-level dedup lives in the
// orchestrator's send() and the SW router.
import type { ScoreResult } from "../contract";
import { normalizeText } from "../dom/text";
import { cyrb53 } from "../hash";

export interface ScoreCache {
  get(text: string): ScoreResult | undefined;
  set(text: string, r: ScoreResult): void;
  keyOf(text: string): string; // sync 53-bit hash of normalizeText(text)
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
