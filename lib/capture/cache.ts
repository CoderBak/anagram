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
      return l1.get(keyOf(text));
    },
    set(text: string, r: ScoreResult): void {
      l1.set(keyOf(text), r);
    },
    clear(): void {
      l1.clear();
    },
    size(): number {
      return l1.size;
    },
  };
}
