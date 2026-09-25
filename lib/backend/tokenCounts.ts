// lib/backend/tokenCounts.ts — model token counts for planning passes, remembered.
//
// A long text is read in passes as full as the model allows, planned on how many tokens
// each of its pieces is (lib/capture/windows.ts). The same pieces come round again —
// the page is read again, a unit is re-read after a clear — so the worker remembers
// counts. Like the score cache it keeps no text: counts are keyed by a hash of the
// piece and the model that counted it.
import { cyrb53 } from "../hash";
import type { ModelInfo } from "../contract";

const MAX_COUNTS = 20_000;

export interface TokenCountSource {
  countTokens(texts: string[], signal?: AbortSignal): Promise<number[] | null>;
  model(): ModelInfo;
}

export function createTokenCounter(source: TokenCountSource) {
  const known = new Map<string, number>();
  const keyOf = (text: string) => `${source.model().id}:${text.length}:${cyrb53(text)}`;
  return {
    /** One count per text, in order, or null when the engine cannot count. */
    async count(texts: string[], signal?: AbortSignal): Promise<number[] | null> {
      // Before the engine has said which model it runs, there is nothing to key counts by.
      if (source.model().id === "none") return source.countTokens(texts, signal);
      const keys = texts.map(keyOf);
      const missing = [...new Set(texts.filter((_, i) => !known.has(keys[i])))];
      if (missing.length > 0) {
        const counts = await source.countTokens(missing, signal);
        if (!counts) return null;
        missing.forEach((text, i) => {
          const key = keyOf(text);
          known.delete(key);
          known.set(key, counts[i]);
        });
        while (known.size > MAX_COUNTS) known.delete(known.keys().next().value!);
      }
      const out: number[] = [];
      for (const key of keys) {
        const n = known.get(key);
        if (n === undefined) return null;
        out.push(n);
      }
      return out;
    },
  };
}
