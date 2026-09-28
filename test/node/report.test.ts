// test/node/report.test.ts — the copied report's rules that need no page: what the verdicts
// add up to, when a flagged paragraph gets a link, and how that link is written. Generating
// the fragment itself needs a real DOM and is checked in test/unit.mjs; opening it, in
// test/pw/scenarios-report.spec.mjs.
import { describe, expect, it } from "vitest";
import type { ScoreResult } from "../../lib/contract";
import { unitVerdict, type UnitVerdict } from "../../lib/capture/windows";
import { t } from "../../lib/i18n";
import { isCloseCall, mayLinkParagraphs, reportState } from "../../lib/render/report";
import { textDirective, withTextDirective } from "../../lib/render/textFragment";

const verdict = (probs: number[], extra: Partial<ScoreResult> = {}, tokens = 200): UnitVerdict => {
  const result: ScoreResult = {
    id: "u",
    bucket: probs.indexOf(Math.max(...probs)),
    probs,
    score: (probs[1]! + 2 * probs[2]! + 3 * probs[3]!) / 3,
    tokens,
    ...extra,
  };
  return unitVerdict("u", 1000, [{ start: 0, end: 1000, result }]);
};

describe("close calls", () => {
  it("are not the verdicts the model is sure of, at either end", () => {
    expect(isCloseCall(verdict([0, 0.01, 0.05, 0.94]))).toBe(false); // .98, AI-generated
    expect(isCloseCall(verdict([0.92, 0.07, 0.01, 0]))).toBe(false); // .03, human
  });

  it("are scores within a step of the colour scale of a place where the word changes", () => {
    // .85 — AI-generated, two points above the cut at 5/6, however sure the model says it is.
    const near = verdict([0, 0.05, 0.35, 0.6]);
    expect(near.result.score).toBeGreaterThan(5 / 6);
    expect(near.result.score - 5 / 6).toBeLessThan(0.05);
    expect(isCloseCall(near)).toBe(true);
  });

  it("are words more likely wrong than right, by the dot's own model", () => {
    // .32, lightly edited, its probabilities spread over three words.
    const spread = verdict([0.3, 0.45, 0.2, 0.05]);
    expect(Math.min(...[1 / 6, 1 / 2, 5 / 6].map((c) => Math.abs(spread.result.score - c)))).toBeGreaterThan(0.05);
    expect(isCloseCall(spread)).toBe(true);
  });

  it("are never a paragraph that has no verdict", () => {
    expect(isCloseCall(verdict([0.25, 0.25, 0.25, 0.25], { unsupported: true, lang: "zh" }))).toBe(false);
    expect(isCloseCall(verdict([0.25, 0.25, 0.25, 0.25], { degraded: true }))).toBe(false);
  });
});

describe("what the report says the verdicts add up to", () => {
  const counts = { analyzed: 0, unavailable: 0, skipped: 0, pending: 0 };

  it("says plainly that there was too little text when nothing reached the floor", () => {
    expect(reportState(counts, 0)).toBe(
      "Too little text to judge: no passage reached the 75 words the model needs for a verdict.",
    );
  });

  it("gives the reason there is no verdict when there was text", () => {
    expect(reportState({ ...counts, skipped: 3 }, 0)).toMatch(/^No verdict: .*not in English/);
    expect(reportState({ ...counts, skipped: 3, unavailable: 2 }, 0)).toMatch(/^No verdict: the local engine did not answer/);
    expect(reportState({ ...counts, unavailable: 2, pending: 4 }, 0)).toMatch(/^No verdict yet: /);
  });

  it("calls the verdicts mixed or uncertain when half or more of them are close calls", () => {
    expect(reportState({ ...counts, analyzed: 4 }, 2)).toBe(
      "Mixed or uncertain: 2 of 4 verdicts are close calls, next to the line between two verdicts or more likely wrong than right. Read them as estimates, not labels.",
    );
    expect(reportState({ ...counts, analyzed: 2 }, 1)).toMatch(/^Mixed or uncertain: 1 of 2 verdicts is a close call, .* Read it as an estimate, not a label\.$/);
    expect(reportState({ ...counts, analyzed: 5 }, 2)).toBeNull();
    expect(reportState({ ...counts, analyzed: 5, pending: 9 }, 0)).toBeNull();
  });

  it("carries the fixed caveat in the words the product uses elsewhere", () => {
    expect(t("reportCaveat")).toBe(
      "Scores are estimates, not proof of authorship. Do not use them for disciplinary or other high-stakes decisions.",
    );
  });
});

describe("links to flagged paragraphs", () => {
  const page = "https://example.com/post";

  it("are given only when the report carries both the address and passage text", () => {
    expect(mayLinkParagraphs({ includeUrl: true, includeText: true, pageUrl: page })).toBe(true);
    // The link IS the address, so without it there is nothing to link.
    expect(mayLinkParagraphs({ includeUrl: false, includeText: true, pageUrl: page })).toBe(false);
    // … and it carries words of the paragraph, which the reader asked to keep out.
    expect(mayLinkParagraphs({ includeUrl: true, includeText: false, pageUrl: page })).toBe(false);
    expect(mayLinkParagraphs({ includeUrl: false, includeText: false, pageUrl: page })).toBe(false);
  });

  it("are given only on pages somebody else could open", () => {
    const ok = (pageUrl: string) => mayLinkParagraphs({ includeUrl: true, includeText: true, pageUrl });
    expect(ok("http://example.com/a")).toBe(true);
    expect(ok("file:///Users/me/notes.html")).toBe(false);
    expect(ok("chrome-extension://abcdef/reader.html?src=x")).toBe(false);
    expect(ok("moz-extension://abcdef/reader.html")).toBe(false);
    expect(ok("about:blank")).toBe(false);
    expect(ok("not a url")).toBe(false);
  });

  it("encode what the directive's own syntax and a Markdown link would read as punctuation", () => {
    expect(textDirective({ textStart: "self-attention, in (short)", textEnd: "R&D costs" })).toBe(
      "text=self%2Dattention%2C%20in%20%28short%29,R%26D%20costs",
    );
    expect(textDirective({ prefix: "as noted", textStart: "the model", suffix: "and so" })).toBe(
      "text=as%20noted-,the%20model,-and%20so",
    );
    expect(textDirective({ textStart: "café's 100% “quoted” text*!" })).toBe(
      "text=caf%C3%A9%27s%20100%25%20%E2%80%9Cquoted%E2%80%9D%20text%2A%21",
    );
  });

  it("keep the page's own fragment and replace a directive already on the address", () => {
    const f = { textStart: "first words", textEnd: "last words" };
    expect(withTextDirective(page, f)).toBe(`${page}#:~:text=first%20words,last%20words`);
    // An anchor stays: it is where the browser goes if the words are not found.
    expect(withTextDirective(`${page}#methods`, f)).toBe(`${page}#methods:~:text=first%20words,last%20words`);
    // A hash route decides what the page shows at all.
    expect(withTextDirective("https://app.example.com/#/thread/42?sort=new", f)).toBe(
      "https://app.example.com/#/thread/42?sort=new:~:text=first%20words,last%20words",
    );
    expect(withTextDirective(`${page}#:~:text=old`, f)).toBe(`${page}#:~:text=first%20words,last%20words`);
    expect(withTextDirective(`${page}?q=a#top:~:text=old&text=older`, f)).toBe(`${page}?q=a#top:~:text=first%20words,last%20words`);
  });
});
