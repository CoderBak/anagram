// test/node/confidence.test.ts — the chance a verdict's word is right, against the model it
// was fitted as. test/fixtures/confidence-vectors.json holds the fitting script's own inputs
// and outputs (EditLens test rows spanning every word and length, points outside the
// fitting data's range, and hand-made verdicts), so the port must match it to the last digit.
import { describe, expect, it } from "vitest";
import { confidence, verdictConfidence } from "../../lib/render/confidence";
import { levelOf } from "../../lib/render/scale";
import { unitVerdict } from "../../lib/capture/windows";
import type { ScoreResult } from "../../lib/contract";
import vectors from "../fixtures/confidence-vectors.json";

const result = (probs: number[], tokens?: number): ScoreResult => ({
  id: "r",
  bucket: probs.indexOf(Math.max(...probs)),
  probs,
  score: (probs[1] + 2 * probs[2] + 3 * probs[3]) / 3,
  ...(tokens === undefined ? {} : { tokens }),
});

describe("confidence", () => {
  it("is the fitted model, to the last digit, inside and outside the range it was fitted on", () => {
    for (const v of vectors) {
      const r = result(v.probs, v.tokens_read + 2);
      expect(levelOf(r.score), v.note).toBe(v.level);
      expect(Math.abs(confidence(r) - v.expected), v.note).toBeLessThan(1e-9);
    }
  });

  it("rates a sure AI-generated verdict well, and a split one far lower", () => {
    expect(confidence(result([0, 0, 0.02, 0.98], 302))).toBeGreaterThan(0.8);
    expect(confidence(result([0.55, 0.4, 0.04, 0.01], 122))).toBeLessThan(0.5);
  });

  it("counts the text a long paragraph's passes read, less two special tokens a pass", () => {
    const pass = (start: number, end: number): ScoreResult => ({ ...result([0.1, 0.55, 0.3, 0.05], 400), id: `${start}` });
    const v = unitVerdict("u", 3000, [
      { start: 0, end: 2000, result: pass(0, 2000) },
      { start: 1000, end: 3000, result: pass(1000, 3000) },
    ]);
    // Two passes of 400 tokens with their special tokens: 796 read.
    expect(verdictConfidence(v)).toBeCloseTo(confidence({ ...v.result, tokens: 798 }, 1), 12);
  });
});
