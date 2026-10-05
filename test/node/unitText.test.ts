// test/node/unitText.test.ts — a unit's text is cut at the storage cap, and its words are the
// words of the text kept: the model reads no further, and the statistics count words scored.
import { describe, expect, it } from "vitest";
import { countWords, MAX_UNIT_TEXT_CHARS, unitTextOf } from "../../lib/dom/text";

describe("unitTextOf", () => {
  it("joins the paragraphs and keeps the caller's count when nothing is cut", () => {
    let asked = 0;
    const out = unitTextOf(["one two three", "four five"], () => { asked++; return 5; });
    expect(out).toEqual({ text: "one two three\n\nfour five", wordCount: 5 });
    expect(asked).toBe(1);
  });

  it("counts only the words kept when the cap cuts the text", () => {
    const paragraph = "word ".repeat(30_000).trim(); // 149,999 characters, 30,000 words
    const out = unitTextOf([paragraph, paragraph], () => 60_000);
    expect(out.text.length).toBe(MAX_UNIT_TEXT_CHARS);
    expect(out.wordCount).toBe(countWords(out.text));
    expect(out.wordCount).toBeLessThan(60_000);
    expect(out.wordCount).toBeGreaterThan(39_000);
  });
});
