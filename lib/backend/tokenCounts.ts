// lib/backend/tokenCounts.ts — model token counts for planning passes, remembered.
//
// A long text is read in passes as full as the model allows, planned on how many tokens
// each of its words is (lib/capture/windows.ts). Words repeat within a page and across
// pages, and the same text comes round again — the page is read again, a unit is re-read
// after a clear — so the worker remembers counts. Like the score cache it keeps no text:
// counts are keyed by a hash of the word and the model that counted it.
import { digest128 } from "../hash";
import { modelDim, type ModelInfo, type TokenCounts } from "../contract";

const MAX_COUNTS = 50_000;

export interface TokenCountSource {
  countTokens(texts: string[], signal?: AbortSignal): Promise<TokenCounts | null>;
  model(): ModelInfo;
  revision?(): number;
}

export function createTokenCounter(source: TokenCountSource) {
  /** [alone, following] per key. */
  const known = new Map<string, readonly [number, number]>();
  return {
    /** Both counts of every text, in order, or null when the engine did not answer. */
    async count(texts: string[], signal?: AbortSignal, partition = ""): Promise<TokenCounts | null> {
      if (signal?.aborted) return null;
      const model = source.model();
      if (model.id === "none") return source.countTokens(texts, signal);
      const dimension = modelDim(model);
      const revision = source.revision?.();
      const prefix = `${dimension}:${digest128(partition)}:`;
      // Raw words live only for this request. Keep its hits even if concurrent work evicts them.
      const answers = new Map<string, readonly [number, number]>();
      const missing: { text: string; key: string }[] = [];
      for (const text of new Set(texts)) {
        const key = prefix + digest128(text);
        const pair = known.get(key);
        if (pair) answers.set(text, pair);
        else missing.push({ text, key });
      }
      if (missing.length) {
        const counts = await source.countTokens(missing.map(item => item.text), signal);
        if (!counts || signal?.aborted || source.revision?.() !== revision || modelDim(source.model()) !== dimension) return null;
        missing.forEach(({ text, key }, i) => {
          const pair = [counts.alone[i]!, counts.following[i]!] as const;
          answers.set(text, pair);
          known.set(key, pair);
        });
        while (known.size > MAX_COUNTS) known.delete(known.keys().next().value!);
      }
      const out: TokenCounts = { alone: [], following: [] };
      for (const text of texts) {
        const pair = answers.get(text)!;
        out.alone.push(pair[0]);
        out.following.push(pair[1]);
      }
      return out;
    },
  };
}
