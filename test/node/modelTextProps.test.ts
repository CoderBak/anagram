// test/node/modelTextProps.test.ts — properties of the text the model reads.
//
// modelText() decides what the model reads and what the caches are keyed on. The model was
// trained on text as it was written, so the promises cut both ways: what an author typed —
// curly quotes, dashes, "…", line breaks — must reach the engine untouched, while what a
// page leaves behind that nobody typed (soft hyphens, zero-width spaces, a PDF's ligature
// glyphs) must not. Putting a text in the model form twice must change nothing. These run
// over a few hundred seeded texts each — words, CJK, emoji, invisibles, NBSP, LaTeX residue,
// curly quotes, digit ranges, newlines — instead of the handful of examples a fixture can
// carry. A failure names the seed to reproduce it.
import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { modelText } from "../../lib/dom/text";
import { createScoreCache } from "../../lib/capture/cache";
import { blockText, wordsOf } from "../../lib/capture/windows";
import { createSwCache } from "../../lib/backend/swCache";
import { fakeScoreStore } from "./scoreStore";
import {
  makeText,
  rng,
  withCurlyQuotes,
  withNbsp,
  withSoftHyphens,
  type Rng,
  type TextOpts,
} from "./random";

/** Every invisible the doc comment promises to remove, as a class. The joiner is not one. */
const INVISIBLE_RE = /[\u00AD\u200B\u200C\u200E\u200F\uFEFF\u202A-\u202E\u2060-\u2064\u2066-\u2069]/g;

function forSeeds(count: number, check: (r: Rng, seed: number) => void): void {
  fc.assert(fc.property(fc.integer({ min: 0, max: 0xffffffff }), (seed) => {
    check(rng(seed), seed);
  }), { numRuns: count, seed: 0xA6A6 });
}

/** The shapes the model form has to survive, drawn one per case. */
const SHAPES: TextOpts[] = [
  { noise: 0.35, quotes: 0.15, newlines: true },
  { noise: 0.2, cjk: 0.5, newlines: true },
  { noise: 0.5, parts: 3, targetChars: 600, newlines: true },
  { noise: 0.15, latex: 0.6 },
  { noise: 0.1, latex: 0.3, latexTight: 0.7, newlines: true },
  { noise: 0.6, unpunctuated: true, targetChars: 120 },
  { noise: 0.25, hugeToken: 300 },
];
const shapeFor = (r: Rng): TextOpts => ({ ...r.pick(SHAPES), quotes: 0.1 });
/** No LaTeX residue: every character left is one somebody wrote. */
const writtenFor = (r: Rng): TextOpts =>
  ({ noise: 0.3, quotes: 0.3, cjk: r.chance(0.3) ? 0.4 : 0, newlines: true, parts: r.int(1, 3) });

describe("modelText", () => {
  it("is a fixed point: putting a text in the model form twice changes nothing", () => {
    forSeeds(300, (r) => {
      const once = modelText(makeText(r, shapeFor(r)));
      expect(modelText(once)).toBe(once);
    });
    fc.assert(fc.property(fc.array(fc.constantFrom("1", "–", "\\", "%", "&", "$", "'", "`", "\u200b", "\u200d",
      "\ufe0f", "\u00ad", "\u00a0", "A", "\u0301", "ﬁ", " ", "\n", "\r", "\t", "\\alpha", "𠮷", "👩"), { maxLength: 100 }), (parts) => {
      const once = modelText(parts.join(""));
      expect(modelText(once)).toBe(once);
    }), { numRuns: 1000, seed: 0xCACE });
  });

  it("changes nothing an author wrote but whitespace", () => {
    forSeeds(300, (r) => {
      const text = makeText(r, writtenFor(r));
      const written = (s: string): string => s.replace(INVISIBLE_RE, "").replace(/\\+([%&_#$])/g, "$1").replace(/\s+/g, "");
      expect(modelText(text).replace(/\s+/g, "")).toBe(written(text));
    });
  });

  it("counts every word in the form a pass sends it, so the counts add up to the pass", () => {
    forSeeds(300, (r) => {
      // Latin text: a CJK sentence or a run too long for one word is counted glued on.
      const text = makeText(r, { ...writtenFor(r), cjk: 0 });
      const whole = { start: 0, end: text.length };
      expect(wordsOf(text).words.filter(Boolean).join(" ")).toBe(blockText(text, whole).replace(/\n/g, " "));
    });
  });

  it("keeps a single space between words and one line break where a line broke, nothing at the edges", () => {
    forSeeds(300, (r) => {
      const text = makeText(r, shapeFor(r));
      const out = modelText(text);
      expect(out).toBe(out.trim());
      expect(/\s\s/.test(out)).toBe(false);
      expect(/[^\S \n]/.test(out)).toBe(false);
      // No LaTeX span reaches across a line, so none is removed across one either.
      expect(out.split("\n").length).toBe(text.replace(INVISIBLE_RE, "").trim().split(/\s*\n\s*/).length);
    });
  });

  it("removes every invisible it promises to", () => {
    forSeeds(300, (r) => {
      const text = makeText(r, { ...shapeFor(r), noise: 0.8 });
      const out = modelText(text);
      expect(out.replace(INVISIBLE_RE, "")).toBe(out);
    });
  });

  it("reads soft hyphens and non-breaking spaces as the page shows them, and typographic quotes as written", () => {
    forSeeds(300, (r) => {
      const text = makeText(r, writtenFor(r));
      const plain = modelText(text);
      expect(modelText(withSoftHyphens(r, text))).toBe(plain);
      expect(modelText(withNbsp(r, text))).toBe(plain);
      expect(modelText(withCurlyQuotes(text))).toBe(withCurlyQuotes(plain));
    });
  });

  it("sends typography untouched: quotes, dashes, ellipses, double hyphens, symbols", () => {
    for (const text of [
      "The editor’s note said “run it twice” before the deadline.",
      "Steps—prompting, then pages 1–5 and 10‑12, a digression -- and `quoted'' text.",
      "It was… fine™, at ½ the price, in ｆｕｌｌ width.",
    ]) expect(modelText(text)).toBe(text);
  });

  it("removes soft hyphens, zero-width spaces and bidi controls, and keeps emoji sequences whole", () => {
    expect(modelText("news\u00ADpaper zero\u200Bwidth \u202Ebidi\u202C \u2066iso\u2069 \uFEFFbom")).toBe("newspaper zerowidth bidi iso bom");
    for (const emoji of ["👨\u200D👩\u200D👧", "❤\uFE0F", "👩\u200D💻", "🏳\uFE0F\u200D🌈", "#\uFE0F\u20E3"]) {
      expect(modelText(`A family ${emoji} here.`)).toBe(`A family ${emoji} here.`);
    }
  });

  it("spells out a PDF's ligature glyphs and nothing else", () => {
    expect(modelText("the ﬁnal ﬂow of ﬀ, ﬃ and ﬄ")).toBe("the final flow of ff, ffi and ffl");
  });

  it("keeps paragraph breaks as one line break and collapses every other run of whitespace", () => {
    expect(modelText("  Sure! Here is the essay.\n\nFirst paragraph.\r\n \n\tSecond\u00A0 one.  ")).toBe(
      "Sure! Here is the essay.\nFirst paragraph.\nSecond one.");
    expect(modelText("one\t two  three")).toBe("one two three");
  });

  it("drops escapes and un-rendered LaTeX, and what their removal joins, in the same pass", () => {
    for (const [text, want] of [
      ["74.1\\% and \\\\& and \\_x", "74.1% and & and _x"],
      ["on the $\\tau^{2}$-bench costs $5 and $10", "on the -bench costs $5 and $10"],
      ["the constant '$\\alpha$' is", "the constant '' is"],
      ["a \\$\\alpha$ b", "a b"],
      ["x \\$\\alpha$% y", "x % y"],
      ["$\\ﬁ$ x", "x"],
      ["\\\u200b%", "%"],
    ] as const) {
      const once = modelText(text);
      expect(once).toBe(want);
      expect(modelText(once)).toBe(once);
    }
  });

  it("gives texts the model reads differently different cache keys, and page variants of one text the same", async () => {
    const straight = `The editor's note said "run it twice" -- before the deadline.`;
    const curly = `The editor’s note said “run it twice” – before the deadline.`;
    const hyphenated = "The edi\u00ADtor's note said \"run it twice\" -- be\u00ADfore the dead\u00ADline.";
    const nbsp = straight.replace(/ /g, "\u00a0");
    const l1 = createScoreCache(), sw = createSwCache(fakeScoreStore()), dim = '["model","1","none"]';
    expect(l1.keyOf(curly)).not.toBe(l1.keyOf(straight));
    expect(sw.keyOf(curly, dim)).not.toBe(sw.keyOf(straight, dim));
    for (const variant of [hyphenated, nbsp]) {
      expect(l1.keyOf(variant)).toBe(l1.keyOf(straight));
      expect(sw.keyOf(variant, dim)).toBe(sw.keyOf(straight, dim));
    }
    expect(l1.keyOf("one\ntwo")).not.toBe(l1.keyOf("one two"));
  });
});
