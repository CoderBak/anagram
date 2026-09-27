// test/node/webengineFasttext.test.ts — the fastText port on a small model of lid.176's format.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FastText } from "../../lib/webengine/fasttext";
import { pyRound } from "../../lib/webengine/scoring";

const FIXTURES = join(__dirname, "..", "fixtures", "webengine");

describe("fastText language identification", () => {
  const model = new FastText(new Uint8Array(readFileSync(join(FIXTURES, "tiny-lid.bin"))));
  const expected = JSON.parse(readFileSync(join(FIXTURES, "tiny-lid.expected.json"), "utf8")) as Array<{ text: string; label: string; prob: number }>;

  it("predicts what the real fastText predicts, probability included", () => {
    for (const row of expected) {
      const got = model.predict(row.text.replace(/\n/g, " ")) ?? { label: "und", prob: 0 };
      expect(got.label, row.text).toBe(row.label);
      expect(pyRound(got.prob, 3), row.text).toBe(pyRound(row.prob, 3));
      expect(Math.abs(got.prob - row.prob), row.text).toBeLessThan(1e-6);
    }
  });

  it("refuses what is not a supervised fastText model", () => {
    expect(() => new FastText(new Uint8Array(64))).toThrow(/not a fastText model/);
  });
});
