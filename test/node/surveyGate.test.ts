// test/node/surveyGate.test.ts — the survey gate's pure comparison.
//
// test/survey-gate.mjs turns two live-site survey reports into a verdict, and the whole
// point of it is what it does NOT call a regression: a site that was walled, a site that
// served different content, a defect that was already there, a number that wobbles. Those
// are impossible to exercise against the real web, so they are exercised here, on reports
// of two or three synthetic pages whose every field is deliberate.
import { describe, expect, it } from "vitest";
import { compare, render, renderReach, T, toolOf, type SurveyReport } from "../survey-gate.mjs";

// ---- builders ---------------------------------------------------------------------

/** A coverage page row: a page that segments its prose and has nothing wrong with it. */
const covPage = (over: Record<string, unknown> = {}) => ({
  name: "a-site",
  kind: "news",
  reach: "ok",
  units: 20,
  merged: 4,
  wordsJudged: 800,
  wordsJudgedProse: 800,
  wordsJudgedChrome: 0,
  wordsProse: 1000,
  silent: [],
  fragmented: [],
  splitParagraphs: 0,
  crossing: [],
  crossingScopes: 0,
  chromeUnits: 0,
  chromeByCat: {},
  ...over,
});
const cov = (pages: Record<string, unknown>[], label = "run"): SurveyReport => ({ label, at: "2026-09-19T00:00:00.000Z", jobs: 4, pages });

/** A dynamics page row: one session with its control, nothing wrong with it. */
const dynPage = (over: Record<string, unknown> = {}, ext: Record<string, unknown> = {}, control: Record<string, unknown> = {}) => ({
  name: "a-site",
  kind: "feed",
  reach: "ok",
  ext: {
    hostsAtEnd: 10,
    hostsMax: 10,
    sameUnitChipsMax: 0,
    pileUpChipsMax: 0,
    flickerGone: 0,
    flickerReappear: 0,
    stuckPending: 0,
    clippedOutMax: 0,
    orphanMax: 0,
    daemon: { resentBlocks: 0 },
    pageErrors: [],
    domErrors: [],
    cdp: { scriptDuration: 0.5 },
    ...ext,
  },
  control: { pageErrors: [], domErrors: [], cdp: { scriptDuration: 0.4 }, ...control },
  ...over,
});
const dyn = (pages: Record<string, unknown>[], label = "run"): SurveyReport => ({ label, at: "2026-09-19T00:00:00.000Z", minutes: 1.5, pages });

const statusOf = (result: ReturnType<typeof compare>, name = "a-site") => result.sites.find((s) => s.name === name)!;

// ---- which tool -------------------------------------------------------------------

describe("survey gate — which report is it", () => {
  it("tells a coverage report from a dynamics one, even when every page was unreachable", () => {
    expect(toolOf(cov([covPage()]))).toBe("coverage");
    expect(toolOf(dyn([dynPage()]))).toBe("dynamics");
    expect(toolOf({ label: "x", minutes: 1.5, pages: [{ name: "a", reach: "bot check" }] })).toBe("dynamics");
    expect(toolOf({ label: "x", pages: [{ name: "a", reach: "bot check" }] })).toBe("coverage");
  });
});

// ---- coverage ---------------------------------------------------------------------

describe("survey gate — coverage", () => {
  it("passes a run compared with itself", () => {
    const r = compare(cov([covPage()]), cov([covPage()]));
    expect(r.totals.regressions).toBe(0);
    expect(statusOf(r).status).toBe("ok");
  });

  it("fails a page that stopped segmenting while it still shows prose", () => {
    const r = compare(cov([covPage()]), cov([covPage({ units: 0, wordsJudged: 0, wordsJudgedProse: 0 })]));
    expect(statusOf(r).status).toBe("regression");
    expect(statusOf(r).findings[0]).toMatch(/units 20 → 0/);
  });

  it("does not fail a page that has almost no prose left to segment", () => {
    const r = compare(
      cov([covPage()]),
      cov([covPage({ units: 0, wordsJudged: 0, wordsJudgedProse: 0, wordsProse: 120 })]),
    );
    // 1000 → 120 words is the page serving something else entirely, not a segmenter fault.
    expect(statusOf(r).status).toBe("skipped");
    expect(statusOf(r).note).toMatch(/different content/);
  });

  it("fails a big coverage drop and forgives a small one", () => {
    const big = compare(cov([covPage()]), cov([covPage({ wordsJudged: 300, wordsJudgedProse: 300 })]));
    expect(statusOf(big).status).toBe("regression");
    expect(statusOf(big).findings[0]).toMatch(/coverage 80 % → 30 %/);
    // 80 → 70 is ten points, under both the 15-point and the 30 %-relative bar.
    const small = compare(cov([covPage()]), cov([covPage({ wordsJudged: 700, wordsJudgedProse: 700 })]));
    expect(statusOf(small).status).toBe("ok");
  });

  it("reads coverage from the total when a report predates the chrome split", () => {
    const old = covPage({ wordsJudgedProse: undefined, wordsJudgedChrome: undefined });
    const r = compare(cov([old]), cov([old]));
    expect(statusOf(r).status).toBe("ok");
    // …and a unit found in page chrome no longer counts towards coverage.
    const now = covPage({ wordsJudged: 800, wordsJudgedProse: 200, wordsJudgedChrome: 600 });
    expect(statusOf(compare(cov([old]), cov([now]))).status).toBe("regression");
  });

  it("refuses to judge a page that served different content", () => {
    const r = compare(cov([covPage()]), cov([covPage({ wordsProse: 400, wordsJudged: 100, wordsJudgedProse: 100 })]));
    expect(statusOf(r).status).toBe("skipped");
    expect(statusOf(r).note).toMatch(/1000 → 400 words of prose/);
    expect(r.totals.regressions).toBe(0);
  });

  it("wants two new fragmented containers, but only one new crossing unit", () => {
    const oneFrag = compare(cov([covPage()]), cov([covPage({ fragmented: [{ i: 1 }] })]));
    expect(statusOf(oneFrag).status).toBe("ok");
    const twoFrag = compare(cov([covPage()]), cov([covPage({ fragmented: [{ i: 1 }, { i: 2 }] })]));
    expect(statusOf(twoFrag).status).toBe("regression");
    const oneCross = compare(cov([covPage()]), cov([covPage({ crossing: [{ unit: 1 }] })]));
    expect(statusOf(oneCross).status).toBe("regression");
    expect(T.FRAG_RISE_FROM_ZERO).toBe(2);
    expect(T.CROSS_RISE_FROM_ZERO).toBe(1);
  });

  it("fails a new kind of chrome unit and celebrates one that went away", () => {
    const fresh = compare(cov([covPage()]), cov([covPage({ chromeUnits: 3, chromeByCat: { sidebar: 3 } })]));
    expect(statusOf(fresh).status).toBe("regression");
    expect(statusOf(fresh).findings[0]).toMatch(/sidebar/);
    const gone = compare(cov([covPage({ chromeUnits: 3, chromeByCat: { sidebar: 3 } })]), cov([covPage()]));
    expect(statusOf(gone).status).toBe("improvement");
  });

  it("skips a site that was walled in either run, and one that is new or gone", () => {
    const walled = compare(cov([covPage()]), cov([covPage({ reach: "bot check", units: undefined })]));
    expect(statusOf(walled).status).toBe("skipped");
    expect(statusOf(walled).note).toMatch(/bot check/);
    expect(walled.totals.regressions).toBe(0);

    const added = compare(cov([covPage()]), cov([covPage(), covPage({ name: "b-site" })]));
    expect(statusOf(added, "b-site").status).toBe("skipped");
    expect(statusOf(added, "b-site").note).toMatch(/new in this run/);

    const removed = compare(cov([covPage(), covPage({ name: "b-site" })]), cov([covPage()]));
    expect(statusOf(removed, "b-site").note).toMatch(/gone from this run/);
  });
});

// ---- dynamics ---------------------------------------------------------------------

describe("survey gate — dynamics", () => {
  it("passes a run compared with itself", () => {
    const r = compare(dyn([dynPage()]), dyn([dynPage()]));
    expect(r.totals.regressions).toBe(0);
  });

  it("fails the first piled chip, the first chip for a unit already chipped, the first resend", () => {
    for (const [what, ext] of [
      ["piled", { pileUpChipsMax: 1 }],
      ["2× unit", { sameUnitChipsMax: 1 }],
      ["resend", { daemon: { resentBlocks: 1 } }],
    ] as const) {
      const r = compare(dyn([dynPage()]), dyn([dynPage({}, ext)]));
      expect(statusOf(r).status, what).toBe("regression");
    }
  });

  it("does not fail a standing defect that wobbled by a few chips", () => {
    // steam-reviews: 49 and 52 piled chips in two runs of one build, over 138 chips.
    const before = dynPage({}, { hostsMax: 138, pileUpChipsMax: 49 });
    const after = dynPage({}, { hostsMax: 138, pileUpChipsMax: 52 });
    expect(statusOf(compare(dyn([before]), dyn([after]))).status).toBe("ok");
    // …but the same defect doubling is a change.
    const doubled = dynPage({}, { hostsMax: 138, pileUpChipsMax: 98 });
    expect(statusOf(compare(dyn([before]), dyn([doubled]))).status).toBe("regression");
    // …and it going away is an improvement.
    expect(statusOf(compare(dyn([before]), dyn([dynPage({}, { hostsMax: 138 })]))).status).toBe("improvement");
  });

  it("allows flicker and stuck chips in proportion to the chips a page carries", () => {
    // A page with ten chips gets the floor of three.
    expect(statusOf(compare(dyn([dynPage()]), dyn([dynPage({}, { flickerGone: 3 })]))).status).toBe("ok");
    expect(statusOf(compare(dyn([dynPage()]), dyn([dynPage({}, { flickerGone: 4 })]))).status).toBe("regression");
    // tumblr-explore's feed of ~50 chips flickered 7 times in one of six runs of one build.
    const feed = (over: Record<string, unknown>) => dynPage({}, { hostsMax: 50, ...over });
    expect(statusOf(compare(dyn([feed({})]), dyn([feed({ flickerGone: 7 })]))).status).toBe("ok");
    expect(statusOf(compare(dyn([feed({})]), dyn([feed({ stuckPending: 6 })]))).status).toBe("ok");
    expect(statusOf(compare(dyn([feed({})]), dyn([feed({ stuckPending: 20 })]))).status).toBe("regression");
    expect(T.CHIP_NOISE_FLOOR).toBe(3);
  });

  it("wants more than three new chips out of sight with nothing parked after their box", () => {
    const base = dynPage({}, { clippedOutMax: 1 });
    expect(statusOf(compare(dyn([base]), dyn([dynPage({}, { clippedOutMax: 4 })]))).status).toBe("ok");
    expect(statusOf(compare(dyn([base]), dyn([dynPage({}, { clippedOutMax: 5 })]))).status).toBe("regression");
  });

  it("blames us for a DOM-surgery error the control run did not have, and not for ad noise", () => {
    const hydration = "Error: Minified React error #418; Text content does not match";
    const ours = compare(dyn([dynPage()]), dyn([dynPage({}, { domErrors: [hydration], pageErrors: [hydration] })]));
    expect(statusOf(ours).status).toBe("regression");
    expect(statusOf(ours).findings[0]).toMatch(/DOM-surgery/);

    // The same error in the control run: the page does that to itself.
    const theirs = compare(
      dyn([dynPage()]),
      dyn([dynPage({}, { domErrors: [hydration], pageErrors: [hydration] }, { domErrors: [hydration], pageErrors: [hydration] })]),
    );
    expect(statusOf(theirs).status).toBe("ok");

    // Third-party scripts failing differently on two loads is not a regression, but it is
    // said out loud.
    const ads = compare(
      dyn([dynPage({}, { pageErrors: ["Failed to load resource: 404"] })]),
      dyn([dynPage({}, { pageErrors: ["Failed to load resource: 404", "ConcertAds: Error loading Rubicon script"] })]),
    );
    expect(statusOf(ads).status).toBe("ok");
    expect(statusOf(ads).note).toMatch(/other console errors/);
  });

  it("cannot attribute errors without a control run, and says so instead of guessing", () => {
    const noControl = compare(dyn([dynPage()]), dyn([dynPage({ control: { error: "nav failed" } }, { domErrors: ["boom"] })]));
    expect(statusOf(noControl).status).toBe("ok");
    expect(statusOf(noControl).note).toMatch(/could not be attributed/);
  });

  it("fails script time that explodes against the control, and forgives a cheap control", () => {
    // dev.to: 22.9 s of script against a control's 0.5 s, from 0.1 s in the baseline.
    const explosion = compare(
      dyn([dynPage({}, { cdp: { scriptDuration: 0.1 } }, { cdp: { scriptDuration: 0.4 } })]),
      dyn([dynPage({}, { cdp: { scriptDuration: 22.9 } }, { cdp: { scriptDuration: 0.5 } })]),
    );
    expect(statusOf(explosion).status).toBe("regression");
    expect(statusOf(explosion).findings[0]).toMatch(/22\.9 s/);

    // youtube-watch: our own cost unchanged, the control merely cheaper this time.
    const cheapControl = compare(
      dyn([dynPage({}, { cdp: { scriptDuration: 9.9 } }, { cdp: { scriptDuration: 5.7 } })]),
      dyn([dynPage({}, { cdp: { scriptDuration: 10.3 } }, { cdp: { scriptDuration: 1.9 } })]),
    );
    expect(statusOf(cheapControl).status).toBe("ok");

    // An expensive page that got cheap again is an improvement.
    const fixed = compare(
      dyn([dynPage({}, { cdp: { scriptDuration: 22.9 } }, { cdp: { scriptDuration: 0.5 } })]),
      dyn([dynPage({}, { cdp: { scriptDuration: 0.1 } }, { cdp: { scriptDuration: 0.4 } })]),
    );
    expect(statusOf(fixed).status).toBe("improvement");
  });

  it("skips a page whose session never happened", () => {
    const r = compare(dyn([dynPage()]), dyn([{ name: "a-site", kind: "feed", reach: "ok" }]));
    expect(statusOf(r).status).toBe("skipped");
  });
});

// ---- the summary --------------------------------------------------------------------

describe("survey gate — the summary", () => {
  it("puts regressions first, then improvements, then what it would not judge, then a total", () => {
    const baseline = cov([
      covPage({ name: "breaks" }),
      covPage({ name: "improves", chromeUnits: 2, chromeByCat: { sidebar: 2 } }),
      covPage({ name: "walled" }),
      covPage({ name: "steady" }),
    ]);
    const current = cov(
      [
        covPage({ name: "breaks", units: 0, wordsJudged: 0, wordsJudgedProse: 0 }),
        covPage({ name: "improves" }),
        covPage({ name: "walled", reach: "login wall" }),
        covPage({ name: "steady" }),
      ],
      "current",
    );
    const result = compare(baseline, current);
    expect(result.totals).toEqual({ compared: 3, regressions: 1, improvements: 1, skipped: 1 });
    const md = render(result);
    expect(md.indexOf("### Regressions")).toBeLessThan(md.indexOf("### Improvements"));
    expect(md.indexOf("### Improvements")).toBeLessThan(md.indexOf("### Not judged"));
    expect(md).toMatch(/\*\*3 of 4 sites compared: 1 regressions, 1 improvements, 1 not judged\*\*/);
    expect(md).toMatch(/^## coverage survey gate/);
  });

  it("says when the two runs opened a different number of pages at once", () => {
    const md = render(compare({ ...cov([covPage()]), jobs: 4 }, { ...cov([covPage()], "ci"), jobs: 2 }));
    expect(md).toMatch(/4 and 2 pages at a time/);
  });

  it("reports no regressions in words when there are none", () => {
    expect(render(compare(cov([covPage()]), cov([covPage()])))).toMatch(/### No regressions/);
  });

  it("counts who answered at all, for a run with nothing to compare with yet", () => {
    const md = renderReach(cov([covPage({ name: "a" }), covPage({ name: "b", reach: "bot check" }), covPage({ name: "c", reach: "login wall" })]));
    expect(md).toMatch(/1 of 3 pages answered/);
    expect(md).toMatch(/bot check ×1, login wall ×1/);
    expect(renderReach(cov([covPage()]))).toMatch(/Every page answered/);
  });
});
