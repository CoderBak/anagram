// test/node/statsCoarsen.test.ts — each dimension's layers from a finer one
// (lib/stats/coarsen.ts), and the configuration's own rules (lib/stats/config.ts).
import { describe, expect, it } from "vitest";
import { coarseDur, coarseLen, coarseTime, coarseVerdict, lenBand, pathPattern, placeLadder } from "../../lib/stats/coarsen";
import { registrableDomain } from "../../lib/publicSuffixes";
import { configOf, normalize, presetConfig, presetOf, PRESET_IDS, PRESETS, DIMENSION_IDS, DIMENSIONS } from "../../lib/stats/config";

describe("time and durations", () => {
  const at = new Date(2026, 9, 5, 14, 37, 21, 456).getTime();
  it("cut a time down to its layer", () => {
    expect(coarseTime(at, "ms")).toBe(at);
    expect(new Date(coarseTime(at, "s")).getSeconds()).toBe(21);
    expect(new Date(coarseTime(at, "s")).getMilliseconds()).toBe(0);
    expect(new Date(coarseTime(at, "min")).getSeconds()).toBe(0);
    expect(new Date(coarseTime(at, "quarter")).getMinutes()).toBe(30);
    expect(new Date(coarseTime(at, "hour")).getMinutes()).toBe(0);
    expect(new Date(coarseTime(at, "day")).getHours()).toBe(0);
  });
  it("round a duration to its layer, or bin it", () => {
    expect(coarseDur(1234, "ms")).toBe(1234);
    expect(coarseDur(1234, "decis")).toBe(1200);
    expect(coarseDur(1634, "s")).toBe(2000);
    expect(coarseDur(1634, "bins")).toBe(1000);
    expect(coarseDur(100, "bins")).toBe(0);
    expect(coarseDur(999_999, "bins")).toBe(64_000);
    expect(coarseDur(5, "none")).toBeNull();
  });
});

describe("places", () => {
  it("make every layer from an address", () => {
    expect(placeLadder("https://www.bbc.co.uk/news/world-europe-12345678?ref=top&utm=x#comments")).toEqual({
      url: "https://www.bbc.co.uk/news/world-europe-12345678?ref=top&utm=x#comments",
      nofragment: "https://www.bbc.co.uk/news/world-europe-12345678?ref=top&utm=x",
      querynames: "https://www.bbc.co.uk/news/world-europe-12345678?ref&utm",
      path: "https://www.bbc.co.uk/news/world-europe-12345678",
      pattern: "https://www.bbc.co.uk/news/:id",
      host: "bbc.co.uk",
      domain: "bbc.co.uk",
    });
    expect(placeLadder("file:///Users/x/paper.pdf")).toBeNull();
  });
  it("name the registered domain under a public second level", () => {
    expect(registrableDomain("old.reddit.com")).toBe("reddit.com");
    expect(registrableDomain("news.bbc.co.uk")).toBe("bbc.co.uk");
    expect(registrableDomain("alice.github.io")).toBe("alice.github.io");
    expect(registrableDomain("127.0.0.1")).toBe("127.0.0.1");
  });
  it("leave out of a path what names one item among many", () => {
    expect(pathPattern("/r/programming/comments/1abc2d/why_rust_is_hard/")).toBe("/r/programming/comments/:id/:slug/");
    expect(pathPattern("/questions/12345/how-do-i-exit-vim")).toBe("/questions/:id/:slug");
    expect(pathPattern("/wiki/Main_Page")).toBe("/wiki/Main_Page");
  });
});

describe("lengths and verdicts", () => {
  it("band a length at the floor, the model's minimum and doubling", () => {
    expect([10, 50, 74, 75, 149, 150, 299, 300, 599, 600, 5000].map(lenBand)).toEqual(
      ["<50", "50-74", "50-74", "75-149", "75-149", "150-299", "150-299", "300-599", "300-599", "600+", "600+"]);
    expect(coarseLen({ chars: 400, words: 72, tokens: 90 }, "words")).toEqual({ words: 72, tokens: 90 });
    expect(coarseLen({ chars: 400, words: 72 }, "rounded")).toEqual({ words: 70 });
    expect(coarseLen({ chars: 400, words: 72 }, "bands")).toEqual({ words: 0, band: "50-74" });
  });
  it("keep of a verdict what its layer says", () => {
    const v = { p: [0.1234, 0.2345, 0.3456, 0.2965], score: 0.6018, band: 2, argmax: 2, flagged: true, doubt: false };
    expect(coarseVerdict(v, "probs2")?.p).toEqual([0.12, 0.23, 0.35, 0.3]);
    expect(coarseVerdict(v, "words")).toEqual({ band: 2, argmax: 2, flagged: true, doubt: false });
    expect(coarseVerdict(v, "flagged")).toEqual({ flagged: true });
    expect(coarseVerdict(v, "none")).toBeUndefined();
  });
});

describe("the configuration", () => {
  it("knows each preset as itself, and every preset is already normal", () => {
    for (const id of PRESET_IDS) {
      expect(presetOf(presetConfig(id))).toBe(id);
      expect(normalize(presetConfig(id)).moved, id).toEqual([]);
      for (const d of DIMENSION_IDS) expect(DIMENSIONS[d] as readonly string[]).toContain(PRESETS[id][d]);
    }
  });
  it("holds no more in a row than the row can: an event log's fields in paragraph rows are coarsened", () => {
    const c = presetConfig("full");
    const { config, moved } = normalize({ ...c, layers: { ...c.layers, rows: "paragraph" } });
    expect(config.layers.expo).toBe("totals");
    expect(config.layers.scroll).toBe("visit");
    expect(config.layers.input).toBe("idle");
    expect(moved).toEqual(expect.arrayContaining(["expo", "scroll", "input", "state", "tabs", "ui", "geom"]));
  });
  it("makes page rows site rows without an address, and kind rows without a site", () => {
    const c = presetConfig("pages");
    expect(normalize({ ...c, layers: { ...c.layers, place: "host" } }).config.layers.rows).toBe("site");
    expect(normalize({ ...c, layers: { ...c.layers, place: "none" } }).config.layers.rows).toBe("kind");
  });
  it("reads anything stored that is not a configuration as off, and fills what is missing", () => {
    expect(configOf(null).on).toBe(false);
    expect(configOf({ on: "yes" }).on).toBe(false);
    const c = configOf({ on: true, layers: { rows: "paragraph", text: "bogus" }, hashed: ["place", "nope"] });
    expect(c.on).toBe(true);
    expect(c.layers.rows).toBe("paragraph");
    expect(c.layers.text).toBe(PRESETS.daily.text);
    expect(c.hashed).toEqual(["place"]);
    expect(c.retention).toEqual({ fine: 7, detail: 90, totals: 0 });
  });
});
