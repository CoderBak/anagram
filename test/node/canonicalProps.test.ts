// test/node/canonicalProps.test.ts — properties of the canonical scoring text.
//
// canonicalForScoring() decides what the model reads and what the caches are keyed on,
// so its promises are absolute: the same visible sentence must reach the daemon as the
// same bytes wherever it was rendered, and canonicalizing an already-canonical text must
// change nothing. These run over a few hundred seeded texts each — words, CJK, emoji,
// invisibles, NBSP, LaTeX residue, curly quotes, digit ranges, newlines — instead of the
// handful of examples a fixture can carry. A failure names the seed to reproduce it.
import { describe, expect, it } from "vitest";
import { canonicalForScoring, normalizeText } from "../../lib/dom/text";
import {
  INVISIBLES,
  makeText,
  rng,
  seeds,
  withCurlyQuotes,
  withNbsp,
  withSoftHyphens,
  type Rng,
  type TextOpts,
} from "./random";

/** Every invisible the doc comment promises to remove, as a class. */
const INVISIBLE_RE = /[​-‏­﻿‪-‮⁠-⁤⁦-⁩]/;

function forSeeds(count: number, check: (r: Rng, seed: number) => void): void {
  for (const seed of seeds(count)) {
    try {
      check(rng(seed), seed);
    } catch (e) {
      throw new Error(`seed ${seed}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** The shapes the canonical form has to survive, drawn one per case. */
const SHAPES: TextOpts[] = [
  { noise: 0.35, quotes: 0.15, newlines: true },
  { noise: 0.2, cjk: 0.5, newlines: true },
  { noise: 0.5, parts: 3, targetChars: 600, newlines: true },
  { noise: 0.15, latex: 0.6 },
  { noise: 0.6, unpunctuated: true, targetChars: 120 },
  { noise: 0.25, hugeToken: 300 },
];
const shapeFor = (r: Rng): TextOpts => ({ ...r.pick(SHAPES), quotes: 0.1 });

describe("canonicalForScoring", () => {
  it("is a fixed point: canonicalizing a canonical text changes nothing", () => {
    forSeeds(300, (r) => {
      const text = makeText(r, shapeFor(r));
      const once = canonicalForScoring(text);
      expect(canonicalForScoring(once)).toBe(once);
    });
  });

  it("never grows beyond what NFKC alone expands it to", () => {
    forSeeds(300, (r) => {
      const text = makeText(r, shapeFor(r));
      // Compatibility mappings are the only step that may add characters ("…" → "...");
      // every other step drops or replaces one-for-one.
      expect(canonicalForScoring(text).length).toBeLessThanOrEqual(text.normalize("NFKC").length);
    });
  });

  it("returns no edge whitespace, no double space and no newline", () => {
    forSeeds(300, (r) => {
      const out = canonicalForScoring(makeText(r, shapeFor(r)));
      expect(out).toBe(out.trim());
      expect(/\s\s/.test(out)).toBe(false);
      expect(/[\n\r\t]/.test(out)).toBe(false);
    });
  });

  it("removes every invisible it promises to", () => {
    forSeeds(300, (r) => {
      const text = makeText(r, { ...shapeFor(r), noise: 0.8 });
      expect(INVISIBLE_RE.test(canonicalForScoring(text))).toBe(false);
    });
  });

  it("is insensitive to the presentation variants it folds", () => {
    forSeeds(300, (r) => {
      // No LaTeX residue in this one: `` '' and \% are content the fold is allowed to
      // change, while these three variants are pure presentation.
      const text = makeText(r, { noise: 0.25, quotes: 0.3, cjk: r.chance(0.3) ? 0.4 : 0, newlines: true });
      const plain = normalizeText(text);
      expect(normalizeText(withSoftHyphens(r, text))).toBe(plain);
      expect(normalizeText(withNbsp(r, text))).toBe(plain);
      expect(normalizeText(withCurlyQuotes(text))).toBe(normalizeText(text));
    });
  });

  it("gives soft-hyphenated and curly-quoted renderings of one sentence the same cache key", () => {
    const straight = `The editor's note said "run it twice" before the deadline.`;
    const curly = `The editor’s note said “run it twice” before the deadline.`;
    const hyphenated = "The edi­tor's note said \"run it twice\" be­fore the dead­line.";
    const nbsp = straight.replace(/ /g, " ");
    expect(normalizeText(curly)).toBe(normalizeText(straight));
    expect(normalizeText(hyphenated)).toBe(normalizeText(straight));
    expect(normalizeText(nbsp)).toBe(normalizeText(straight));
  });

  // KNOWN DEFECT (lib/dom/text.ts, canonicalForScoring — left alone here, that file has
  // another owner). Un-rendered LaTeX is removed AFTER the digraph folds, so removing a
  // span can weld two quote characters into a `` or '' that only the NEXT pass folds:
  // "the constant '$\alpha$' is" canonicalizes to a text that is not itself canonical.
  // The generators above never write a quote tight against a span, which is why the
  // fixed-point property passes; this case was built by hand. The fold belongs after the
  // removal. Flip this test to a plain `it` once that is done.
  it.fails("is NOT yet a fixed point when removing a LaTeX span welds two quotes together", () => {
    const once = canonicalForScoring("the constant '$\\alpha$' is");
    expect(canonicalForScoring(once)).toBe(once);
  });
});
