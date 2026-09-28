// lib/webengine/scoring.ts — anagramd/scoring.py and the two contract operations, in the browser.
//
// The same cleaning, tokenization, truncation, order, batching and rounding as the native
// engine: texts are tokenized once, sorted by length, cut to the model's window with the
// end-of-sequence token kept, padded on the right per batch, and the logits go through a
// softmax to four probabilities rounded to four places. The forward pass itself is behind
// the `Backend` interface (lib/webengine/session.ts); everything else is here so that the
// unit tests can drive it with a fake.
import { BUCKET_COUNT } from "../contract";
import { cleanText } from "./clean";
import type { Tokenizer } from "./tokenizer";

/** The model's window in tokens, its two special tokens included (config.json's 512). */
export const MAX_LENGTH = 512;
/** Texts per forward pass when the backend does not say: the native engine's default. */
export const BATCH_SIZE = 32;
export const N_BUCKETS = BUCKET_COUNT;

export interface Backend {
  /** The logits of one padded batch: `rows` × N_BUCKETS, row-major. */
  logits(inputIds: number[][], attentionMask: number[][], signal?: AbortSignal): Promise<Float32Array>;
  /** Texts per forward pass, when the backend bounds them (its memory grows with the batch). */
  batchSize?: number;
}

export interface Scored {
  bucket: number;
  probs: number[];
  score: number;
  tokens: number;
  truncated: boolean;
}

/**
 * Python's round(x, digits): the decimal expansion of the double, rounded half to even.
 * JavaScript's toFixed rounds an exact tie up, and the native host rounds with Python.
 */
export function pyRound(x: number, digits: number): number {
  if (!Number.isFinite(x)) return x;
  const fixed = Math.abs(x).toFixed(digits + 30);
  const dot = fixed.indexOf(".");
  const kept = fixed.slice(0, dot + 1 + digits);
  const rest = fixed.slice(dot + 1 + digits);
  let value = Number(kept);
  const unit = 10 ** -digits;
  if (rest > "5".padEnd(rest.length, "0")) value = Number((value + unit).toFixed(digits));
  else if (rest === "5".padEnd(rest.length, "0")) {
    const lastDigit = Number(kept.replace(".", "").slice(-1));
    if (lastDigit % 2 === 1) value = Number((value + unit).toFixed(digits));
  }
  return x < 0 ? -value : value;
}

/** Right padding, as scoring.Tokenizer.pad: ids and mask, both `rows` × longest. */
export function pad(rows: number[][], padId: number): { inputIds: number[][]; attentionMask: number[][] } {
  const width = Math.max(...rows.map((r) => r.length));
  const inputIds = rows.map((r) => [...r, ...new Array<number>(width - r.length).fill(padId)]);
  const attentionMask = rows.map((r) => [...new Array<number>(r.length).fill(1), ...new Array<number>(width - r.length).fill(0)]);
  return { inputIds, attentionMask };
}

/** scoring.score_texts: one result per text, in the order given. */
export async function scoreTexts(backend: Backend, tokenizer: Tokenizer, texts: string[], signal?: AbortSignal): Promise<Scored[]> {
  const cleaned = texts.map(cleanText);
  if (cleaned.length === 0) return [];
  const allIds = cleaned.map((text) => tokenizer.encode(text, true));
  const lengths = allIds.map((ids) => ids.length);
  const eos = tokenizer.sepId;
  const order = [...allIds.keys()].sort((a, b) => lengths[a]! - lengths[b]!);
  const out: Scored[] = new Array(texts.length);
  const batch = backend.batchSize ?? BATCH_SIZE;
  for (let start = 0; start < order.length; start += batch) {
    if (signal?.aborted) throw new Error("cancelled");
    const chunk = order.slice(start, start + batch);
    // `order`, and so every `i` below, holds the indices of `allIds` and `lengths`.
    const rows = chunk.map((i) => {
      const ids = allIds[i]!;
      return ids.length <= MAX_LENGTH ? ids : [...ids.slice(0, MAX_LENGTH - 1), eos];
    });
    const { inputIds, attentionMask } = pad(rows, tokenizer.padId);
    const logits = await backend.logits(inputIds, attentionMask, signal);
    if (logits.length !== chunk.length * N_BUCKETS || !logits.every(Number.isFinite)) throw new Error("runtime returned invalid EditLens logits");
    chunk.forEach((i, row) => {
      const p = softmax(logits.subarray(row * N_BUCKETS, (row + 1) * N_BUCKETS));
      const length = lengths[i]!;
      let bucket = 0;
      for (let k = 1; k < N_BUCKETS; k++) if (p[k]! > p[bucket]!) bucket = k;
      let weighted = 0;
      for (let k = 0; k < N_BUCKETS; k++) weighted += p[k]! * k;
      out[i] = {
        bucket,
        probs: p.map((x) => pyRound(x, 4)),
        score: pyRound(weighted / (N_BUCKETS - 1), 4),
        tokens: Math.min(length, MAX_LENGTH),
        truncated: length > MAX_LENGTH,
      };
    });
  }
  return out;
}

/** numpy's max-subtracted softmax of one float32 row, in single precision as numpy keeps it. */
function softmax(row: Float32Array): number[] {
  let max = Number.NEGATIVE_INFINITY;
  for (const x of row) max = Math.max(max, x);
  const exp = Array.from(row, (x) => Math.fround(Math.exp(Math.fround(x - max))));
  let sum = 0;
  for (const x of exp) sum = Math.fround(sum + x);
  return exp.map((x) => Math.fround(x / sum));
}

/** engine.tokens_with_engine: each text's tokens alone and following a space, and the window. */
export function countTokens(tokenizer: Tokenizer, texts: string[]): { alone: number[]; following: number[]; window: number } {
  const window = MAX_LENGTH - 2;
  const cleaned = texts.map(cleanText);
  const alone = cleaned.map((text) => tokenizer.encode(text, false).length);
  const following = cleaned.map((text) => (text ? tokenizer.encode(" " + text, false).length : 0));
  return { alone, following, window };
}
