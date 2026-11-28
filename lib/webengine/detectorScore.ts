import { labeledCharacterBucket } from "../detectorFormat";
import type { Tokenizer } from "./tokenizer";
import type { DetectorMeta, Crf } from "../detectorFormat";
export { checkDetector, type DetectorMeta, type Crf } from "../detectorFormat";
export interface Heads {
  token: Float32Array;
  segment: Float32Array;
  mixed: Float32Array;
}
export function normalizeDetector(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[‘’‚′]/gu, "'")
    .replace(/[“”„″]/gu, '"')
    .replace(/\s*—\s*/gu, " -- ")
    .replace(/(?<=[\p{L}\p{N}_])–(?=[\p{L}\p{N}_])/gu, "-")
    .replace(/\s*–\s*/gu, " - ")
    .replace(/…/gu, "...")
    .replace(/[\u00a0\u2009\u202f]/gu, " ")
    .replace(/[\u200b-\u200d\ufeff]/gu, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
const maxIndex = (v: ArrayLike<number>) => (v[1]! > v[0]! ? (v[2]! > v[1]! ? 2 : 1) : v[2]! > v[0]! ? 2 : 0);
/** Stop counting as soon as the passage meets the release's minimum. */
export function enoughDetectorWords(text: string, minimum: number): boolean {
  if (!/\p{L}/u.test(text)) return false;
  const words = /[\p{L}\p{N}_]+(?:['’][\p{L}\p{N}_]+)*/gu;
  for (let count = 0; count < minimum; count++) if (!words.test(text)) return false;
  return true;
}

export async function detectorScore(
  raw: string,
  tok: Pick<Tokenizer, "clsId" | "sepId" | "encodeWithOffsets">,
  meta: Pick<DetectorMeta, "min_words" | "window" | "stride" | "architecture" | "document_fraction_basis">,
  crf: Crf,
  run: (ids: number[]) => Promise<Heads>,
) {
  if (!enoughDetectorWords(raw, meta.min_words))
    return {
      bucket: 0,
      probs: [1 / 3, 1 / 3, 1 / 3],
      score: 0,
      tokens: 0,
      truncated: false,
      insufficient: true,
    };
  const text = normalizeDetector(raw),
    { ids, offsets } = tok.encodeWithOffsets(text);
  const n = ids.length,
    last = Math.max(0, n - meta.window);
  const features = new Float64Array(n * 6),
    counts = new Uint32Array(n),
    mix = new Float64Array(n),
    weights = new Float64Array(n);
  for (let start = 0; ; start = Math.min(last, start + meta.stride)) {
    const end = Math.min(n, start + meta.window),
      len = end - start;
    const input = ids.slice(start, end);
    const qwen = meta.architecture === "qwen3_5_text";
    const { token, segment, mixed } = await run(qwen ? input : [tok.clsId, ...input, tok.sepId]);
    if (!token.every(Number.isFinite) || !segment.every(Number.isFinite) || !mixed.every(Number.isFinite))
      throw new Error("Detector produced invalid logits");
    const prior = [0, 0, 0],
      max = Math.max(...segment);
    segment.forEach((value, i) => {
      const weight = Math.exp(value - max);
      for (let k = 0; k < 3; k++)
        prior[k]! += weight * Math.max(0, 1 - 2 * Math.abs(i / 14 - k / 2));
    });
    const sum = prior.reduce((a, b) => a + b);
    const logPrior = prior.map(p => Math.log(Math.max(1e-6, p / sum)));
    const mixedDelta = mixed[1]! - mixed[0]!;
    for (let i = start; i < end; i++) {
      for (let k = 0; k < 3; k++) {
        features[i * 6 + k]! += token[(i - start + (qwen ? 0 : 1)) * 3 + k]!;
        features[i * 6 + 3 + k]! += logPrior[k]!;
      }
      const centre = 1 - Math.abs(i - start - (len - 1) / 2) / ((len + 1) / 2);
      weights[i]! += centre;
      mix[i]! += centre * mixedDelta;
      counts[i]!++;
    }
    if (start === last) break;
  }
  const back = new Uint8Array(n * 3);
  let score = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    mix[i]! /= weights[i]!;
    const cost = i ? Math.min(0, -crf.lambda + (crf.gamma * (mix[i - 1]! + mix[i]!)) / 2) : 0;
    score = crf.W.map((w, k) => {
      let best = k,
        previous = score[k]!;
      for (let j = 0; j < 3; j++)
        if (j !== k && score[j]! + cost > previous) {
          best = j;
          previous = score[j]! + cost;
        }
      back[i * 3 + k] = best;
      return (
        previous +
        crf.alpha[k]! +
        crf.delta[k]! +
        w.reduce((v, a, j) => v + (a * features[i * 6 + j]!) / counts[i]!, 0)
      );
    });
  }
  let label = maxIndex(score);
  const labels = new Uint8Array(n);
  for (let i = n - 1; i >= 0; i--) {
    labels[i] = label;
    label = back[i * 3 + label]!;
  }
  const ends: number[] = [];
  let units = 0,
    scalars = 0;
  for (const m of text.matchAll(/[.!?…]+["'”’)\]]*(?=\s|$)|\n\s*\n/gu)) {
    const end = m.index + m[0].length;
    scalars += Array.from(text.slice(units, end)).length;
    units = end;
    ends.push(scalars);
  }
  const sentenceStarts: number[] = [];
  let start = 0;
  for (const end of [...ends, Infinity]) {
    let i = start;
    const votes = [0, 0, 0];
    while (i < n) {
      const [a, b] = offsets[i]!;
      if (Math.floor((a + Math.max(a, b - 1)) / 2) >= end) break;
      votes[labels[i]!]!++;
      i++;
    }
    if (start < i) sentenceStarts.push(start);
    labels.fill(maxIndex(votes), start, i);
    start = i;
  }
  if (crf.l_min > 1) {
    const runs: { label: number; length: number }[] = [];
    for (const label of labels) {
      const last = runs.at(-1);
      if (last?.label === label) last.length++;
      else runs.push({ label, length: 1 });
    }
    while (runs.length > 1) {
      const i = runs.findIndex((r) => r.length < crf.l_min);
      if (i < 0) break;
      const left = runs[i - 1],
        right = runs[i + 1];
      const into =
        left && (!right || left.label === right.label || left.length >= right.length) ? left : right!;
      into.length += runs[i]!.length;
      runs.splice(i, 1);
      if (left && right && left.label === right.label) {
        left.length += right.length;
        runs.splice(i, 1);
      }
    }
    let offset = 0;
    for (const run of runs) {
      labels.fill(run.label, offset, offset + run.length);
      offset += run.length;
    }
  }
  const countsByLabel = [0, 0, 0];
  const allChars = meta.document_fraction_basis === "all_labeled_characters";
  let tokenIndex = 0, position = 0, total = 0;
  for (const character of text) {
    while (tokenIndex + 1 < n && offsets[tokenIndex + 1]![0] <= position) tokenIndex++;
    if (allChars || !/[\p{White_Space}\u001c-\u001f]/u.test(character)) {
      countsByLabel[labels[tokenIndex]!]!++;
      total++;
    }
    position++;
  }
  const probs = countsByLabel.map(v => v / Math.max(1, total));
  const bucket = allChars ? labeledCharacterBucket(countsByLabel, total) : maxIndex(probs);
  return { documentFractionBasis: meta.document_fraction_basis, sentenceLabels:sentenceStarts.map(start=>labels[start]!), bucket, probs, score: probs[2]! + probs[1]! / 2, tokens: n, truncated: false };
}
