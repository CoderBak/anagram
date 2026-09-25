// lib/backend/tokenCounts.ts — model token counts for planning passes, remembered.
//
// A long text is read in passes as full as the model allows, planned on how many tokens
// each of its words is (lib/capture/windows.ts). Words repeat within a page and across
// pages, and the same text comes round again — the page is read again, a unit is re-read
// after a clear — so the worker remembers counts. Like the score cache it keeps no text:
// counts are keyed by a hash of the word and the model that counted it.
import { cyrb53 } from "../hash";
import type { ModelInfo, TokenCounts } from "../contract";

const MAX_COUNTS = 50_000;

export interface TokenCountSource {
  countTokens(texts: string[], signal?: AbortSignal): Promise<TokenCounts | null>;
  model(): ModelInfo;
}

export function createTokenCounter(source: TokenCountSource) {
  /** [alone, following] per key. */
  const known = new Map<string, readonly [number, number]>();
  const keyOf = (text: string) => `${source.model().id}:${text.length}:${cyrb53(text)}`;
  return {
    /** Both counts of every text, in order, or null when the engine did not answer. */
    async count(texts: string[], signal?: AbortSignal): Promise<TokenCounts | null> {
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
          known.set(key, [counts.alone[i], counts.following[i]]);
        });
        while (known.size > MAX_COUNTS) known.delete(known.keys().next().value!);
      }
      const out: TokenCounts = { alone: [], following: [] };
      for (const key of keys) {
        const pair = known.get(key);
        if (!pair) return null;
        out.alone.push(pair[0]);
        out.following.push(pair[1]);
      }
      return out;
    },
  };
}
