// lib/capture/keptLedger.ts — verdicts on the paragraphs of a paged document that are not drawn.
//
// The PDF reader's viewer draws a few pages at a time and lets the rest go, and a unit goes with
// its page; the reader also reads pages it has not drawn (Orchestrator.scoreDetached). Both
// verdicts are kept here, by the paragraph's text, and counted and listed as long as no live
// unit has that text: the report is the document read so far, not the two pages on screen. A
// paragraph on screen counts by its live unit, and when its page is let go once more its kept
// verdict is replaced.
import type { ScoreResult } from "../contract";

/** A verdict on a paragraph of a paged document that is not drawn now (Unit.page). */
export interface KeptVerdict {
  /** "k…": an id of its own, for the report's list. */
  id: string;
  page: number;
  order: number;
  text: string;
  wordCount: number;
  result: ScoreResult;
}

export interface KeptLedger {
  keep(paragraph: { page: number; order: number; text: string; wordCount: number }, result: ScoreResult): void;
  /** What is kept of the paragraphs no live unit has now, and, where the document's paragraphs
   *  are known (`documentTexts`), of those it still has: a verdict on any other text is of a
   *  paragraph read differently since. */
  now(liveTexts: Iterable<string>, documentTexts: ReadonlySet<string> | null): KeptVerdict[];
  /** The pages anything is kept of. */
  pages(): Iterable<number>;
  has(text: string): boolean;
  clear(): void;
}

export function createKeptLedger(): KeptLedger {
  let kept = new Map<string, KeptVerdict>();
  let seq = 0;
  return {
    keep(p, result) {
      kept.set(p.text, { id: `k${(seq++).toString(36)}`, page: p.page, order: p.order, text: p.text, wordCount: p.wordCount, result });
    },
    now(liveTexts, documentTexts) {
      if (kept.size === 0) return [];
      const live = new Set(liveTexts);
      return [...kept.values()].filter((k) => !live.has(k.text) && (!documentTexts || documentTexts.has(k.text)));
    },
    *pages() {
      for (const k of kept.values()) yield k.page;
    },
    has: (text) => kept.has(text),
    clear() { kept = new Map(); },
  };
}
