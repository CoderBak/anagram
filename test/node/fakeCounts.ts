// test/node/fakeCounts.ts — token counts from the fixtures' pretend tokenizer
// (test/fakeTokens.mjs), and a pass plan made with them the way readInWindows makes one.
import type { TokenCounts } from "../../lib/contract";
import { planPasses, wordsOf, MAX_WINDOWS, type TextSpan } from "../../lib/capture/windows";
import { fakeTokens } from "../fakeTokens.mjs";

/** Both counts of every text; the pretend tokenizer, like a real one, ignores a space in front. */
export function fakeCounts(texts: readonly string[]): TokenCounts {
  return { alone: texts.map((t) => fakeTokens(t)), following: texts.map((t) => fakeTokens(t)) };
}

/** The passes readInWindows reads a text in, with fakeCounts for the engine. */
export function planText(text: string): TextSpan[] {
  const { chunks, words } = wordsOf(text);
  return planPasses(text, chunks, fakeCounts(words)).slice(0, MAX_WINDOWS);
}

/** The pretend tokens of a span of text. */
export function spanTokens(text: string, span: TextSpan): number {
  return fakeTokens(text.slice(span.start, span.end));
}
