// test/node/statsLog.test.ts — the reading log (lib/stats/): what each preset keeps of what a
// page's recorder sends, what the worker takes from the browser rather than the page, the
// lenses, the summaries the statistics page shows, the export's layers and pseudonyms, the
// message a page may send, and the kind of page.
//
// IndexedDB itself is not here (vitest has none): the worker writes to lib/stats/store.ts's
// in-memory store, whose merging rules are the database's (mergeUnit, mergeTotal); the browser
// suites (test/pw/stats.spec.mjs) run the real database.
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { addDays, datesBetween, monthRange, emptyTally, type UnitRow } from "../../lib/stats/model";
import { createStatsKeeper, type StatsKeeperDeps, type StatsSender, type TabFacts } from "../../lib/stats/worker";
import { memoryStatsStore } from "../../lib/stats/store";
import { presetConfig, type Preset, type RecordingConfig } from "../../lib/stats/config";
import { DEFAULT_KIND_RULE, DEFAULT_LENS, headlineOf, sharesUnder, tallyUnder, type Lens } from "../../lib/stats/lens";
import { summarize } from "../../lib/stats/summary";
import { buildExport, exportCsvFiles, preview, type ExportOptions } from "../../lib/stats/export";
import { sketchSimilarity } from "../../lib/stats/hash";
import { coarseTime } from "../../lib/stats/coarsen";
import { kindFrom, kindSignals, pageKindOf } from "../../lib/stats/pageKind";
import { parseWorkerMessage, permitsMessage, type AccessSender } from "../../lib/access/messages";
import { ACTIONS } from "../../lib/messaging/protocol";
import type { StatsWire, WireUnit } from "../../lib/stats/wire";
import type { Unit } from "../../lib/types";

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const AI = [0, 0, 0.1, 0.9];
const HUMAN = [0.9, 0.1, 0, 0];
const VISIT = "0123456789abcdef0123456789abcdef";
const START = new Date(2026, 9, 4, 9, 15, 30, 250).getTime();
const TEXT = "The survey of the old harbour began in the spring, when the water was low enough to show the stones along the northern wall. Three of us walked the length of it every morning with a notebook and a measuring tape, writing down every crack and every loose block we could find.";

const expo = (bandMs: number) => ({ any: [bandMs + 500, 0, 0, 0] as [number, number, number, number], half: [bandMs, 0, 0, 0] as [number, number, number, number], band: [bandMs, bandMs, 0, 0] as [number, number, number, number], sightings: 1, first: 120, last: 120 + bandMs, readAt: bandMs >= 1000 ? 1120 : undefined });

function unit(n: number, over: Partial<WireUnit> = {}): WireUnit {
  return {
    n, status: "scored", found: 100 + n, text: n === 0 ? TEXT : `${TEXT} Paragraph ${n} says something else entirely about boats and tides.`,
    len: { words: 52 + n, chars: 300, tokens: 70, sentences: 2 }, lang: { label: "en", prob: 0.98, script: "Latin" },
    struct: { unit: "paragraph", tag: "p", landmark: "main", order: n, paragraphs: 1 }, geom: { x: 10, y: 200 + 50 * n, w: 600, h: 40, share: 0.1 },
    verdict: { p: n % 2 ? HUMAN : AI, score: n % 2 ? 0.0333 : 0.9667, flagged: n % 2 === 0, truncated: false },
    timing: { cached: false, answered: 900 }, expo: expo(1500), ...over,
  };
}

function wire(over: Partial<StatsWire> = {}, visit: Partial<StatsWire["visit"]> = {}): StatsWire {
  return {
    seq: 0,
    visit: {
      id: VISIT, start: START, frame: "top", surface: "web", kind: "article", href: "https://www.example.com/news/story-12345?ref=top#c",
      referrer: "https://search.example/?q=boats", shown: 61_234, active: 50_000, focused: 40_000, dwell: 61_234,
      scroll: { depth: 0.5, distance: 3000 }, idle: [[130_000, 250_000]], display: { chips: "all", underlines: "flagged", flagFrom: "heavy" },
      found: { units: 12, words: 900 }, signals: { feedHost: false, feedRole: false, forumPath: false, declared: "article", posts: 0, inPosts: 0, sample: 12, largestShare: 0, mainShare: 1 },
      ...visit,
    },
    units: [unit(0), unit(1)],
    reads: [{ n: 0, w: 52, p: AI }, { n: 1, w: 53, p: HUMAN }],
    events: {
      steps: { t: [120, 1640], unit: [0, 0], obs: [0, 0], ratio: [0.5, 1], top: [600, 300], h: [40, 40] },
      intervals: { unit: [0], kind: [1], start: [120], end: [1620], peak: [1] },
      scroll: { t: [100, 140, 1000], box: [0, 0, 0], x: [0, 0, 0], y: [0, 40, 400], vw: [1280, 1280, 1280], vh: [800, 800, 800], ph: [5000, 5000, 5000] },
      input: { t: [50, 60, 70], kind: [0, 1, 8], x: [10, 10, 30], y: [20, 20, 40], n: [-1, -1, -1] },
      state: { t: [300], kind: [3] },
    },
    ...over,
  };
}

const sender = (over: Partial<StatsSender> = {}): StatsSender => ({ url: "https://www.example.com/news/story-12345?ref=top#c", frameId: 0, documentId: "doc1", tab: { id: 7, windowId: 2, url: "https://www.example.com/next-page", title: "  A Story About Boats  ", incognito: false }, ...over });

function tabs(): TabFacts {
  const tops = new Map<number, string[]>();
  return {
    tabId: (n) => `tab${n}`, windowId: (n) => `win${n}`, arrival: () => "link",
    topVisit: (t) => tops.get(t)?.at(-1), previousVisit: (t, v) => { const l = tops.get(t) ?? []; const i = l.indexOf(v); return i > 0 ? l[i - 1] : undefined; },
    openerVisit: () => undefined, noteTopVisit: (t, v) => { const l = tops.get(t) ?? []; l.push(v); tops.set(t, l); }, covered: () => undefined,
  };
}

function keeper(config: RecordingConfig, over: Partial<StatsKeeperDeps> = {}) {
  const store = memoryStatsStore();
  const deps: StatsKeeperDeps = {
    store, config: async () => config, enabledFor: async () => true,
    model: () => ({ id: "fake-editlens", ver: "test", calibration: "none" }),
    engine: async () => ({ kind: "inbrowser", backend: "webgpu", tier: "fp32" }),
    secret: async () => new Uint8Array(32).fill(7), tabs: tabs(), now: () => new Date(START), ...over,
  };
  return { store, keep: createStatsKeeper(deps) };
}

const preset = (p: Preset): RecordingConfig => presetConfig(p);

describe("what each preset keeps", () => {
  it("off: nothing at all", async () => {
    const { store, keep } = keeper({ ...preset("daily"), on: false });
    expect(await keep.record(wire(), sender(), "content")).toBe(false);
    expect(store.dump().totals).toEqual([]);
  });

  it("daily totals: the day's and each kind's tallies, and no visit, paragraph, site or page", async () => {
    const { store, keep } = keeper(preset("daily"));
    expect(await keep.record(wire(), sender(), "content")).toBe(true);
    const d = store.dump();
    expect(d.visits).toEqual([]);
    expect(d.units).toEqual([]);
    expect(d.events).toEqual([]);
    expect(d.totals.map((t) => `${t.scope}:${t.key}`).sort()).toEqual(["day:", "kind:article"]);
    const day = d.totals.find((t) => t.scope === "day")!;
    expect(day.tally.scored).toBe(105);
    expect(day.tally.expected[3]).toBeCloseTo(52 * 0.9);
    expect(day.tally.units).toEqual([1, 0, 0, 1]);
    expect(day.tally.argmax).toEqual([1, 0, 0, 1]);
    expect(day.models).toEqual([{ id: "fake-editlens", ver: "test", calibration: "none" }]);
  });

  it("a visit over midnight: filed under the day it began, its reading under the day it came in", async () => {
    const nextMorning = new Date(2026, 9, 5, 0, 5).getTime();
    const { store, keep } = keeper(preset("paragraphs"), { now: () => new Date(nextMorning) });
    await keep.record(wire({}, { start: new Date(2026, 9, 4, 23, 50).getTime() }), sender(), "content");
    const d = store.dump();
    expect(d.visits.map((v) => v.date)).toEqual(["2026-10-04"]);
    expect([...new Set(d.totals.map((t) => t.date))]).toEqual(["2026-10-05"]);
    // A start the page says is still to come is now's.
    const late = keeper(preset("paragraphs"), { now: () => new Date(START) });
    await late.keep.record(wire({}, { start: START + 3 * 86_400_000 }), sender(), "content");
    expect(late.store.dump().visits.map((v) => v.date)).toEqual(["2026-10-04"]);
  });

  it("sites: each registered domain's tallies", async () => {
    const { store, keep } = keeper(preset("sites"));
    await keep.record(wire(), sender(), "content");
    expect(store.dump().totals.filter((t) => t.scope === "site").map((t) => t.key)).toEqual(["example.com"]);
  });

  it("pages: the address the visit began at, without query or fragment, its title, the minute it was first read and how long it was shown", async () => {
    const { store, keep } = keeper(preset("pages"));
    await keep.record(wire(), sender(), "content");
    const page = store.dump().totals.find((t) => t.scope === "page")!;
    // The tab shows another address already (a route change): the recorder's, of the same origin, is the visit's.
    expect(page.key).toBe("https://www.example.com/news/story-12345");
    expect(page.title).toBe("A Story About Boats");
    expect(page.start).toBe("09:15");
    expect(page.dwell).toBe(61);
    expect(store.dump().visits).toEqual([]);
  });

  it("paragraphs: visits without an address, and each paragraph with a salted hash, its length, verdict and time on screen", async () => {
    const { store, keep } = keeper(preset("paragraphs"));
    await keep.record(wire(), sender(), "content");
    const d = store.dump();
    const v = d.visits[0]!;
    expect(v.url).toBeUndefined();
    expect(v.places).toBeUndefined();
    expect(v.start % 60_000).toBe(0);
    expect(v.shown).toBe(61_000);
    expect(v.arrival).toBe("link");
    expect(v.tally.scored).toBe(105);
    const u = d.units.find((x) => x.n === 0)!;
    expect(u.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(u.sketch).toBeUndefined();
    expect(u.head).toBeUndefined();
    expect(u.verdict).toMatchObject({ p: AI, band: 3, argmax: 3, flagged: true, doubt: true });
    expect(u.expo?.band).toEqual([2000, 2000, 0, 0]);
    expect(u.struct).toEqual({ unit: "paragraph", post: undefined, order: 0, paragraphs: 1 });
    expect(d.events).toEqual([]);
    expect(d.texts).toEqual([]);
  });

  it("study: an event log at tenths of a second, domains, sketches and no text", async () => {
    const { store, keep } = keeper(preset("study"));
    await keep.record(wire(), sender(), "content");
    const d = store.dump();
    expect(d.visits[0]!.url).toBeUndefined();
    expect(d.visits[0]!.site).toBe("example.com");
    expect(d.units[0]!.sketch).toHaveLength(86);
    expect(d.units[0]!.head).toBeUndefined();
    expect(d.events[0]!.streams.steps?.t).toEqual([100, 1600]);
    expect(d.texts).toEqual([]);
  });

  it("full trace with text: the address with its fragment, the first words and the text itself", async () => {
    const { store, keep } = keeper(preset("fullText"));
    await keep.record(wire(), sender(), "content");
    const d = store.dump();
    expect(d.visits[0]!.url).toBe("https://www.example.com/news/story-12345?ref=top#c");
    expect(d.visits[0]!.referrer).toBe("https://search.example/?q=boats");
    expect(d.units[0]!.head).toBe("The survey of the old harbour began in the spring, when the");
    expect(d.texts.map((t) => t.text)).toContain(TEXT);
    expect(d.events[0]!.streams.input?.x).toEqual([10, 10, 30]);
  });

  it("keeps a paragraph's hash when a later message carries no text", async () => {
    const { store, keep } = keeper(preset("paragraphs"));
    await keep.record(wire(), sender(), "content");
    const first = store.dump().units.find((u) => u.n === 0)!.hash;
    await keep.record(wire({ seq: 1, units: [unit(0, { text: undefined, expo: expo(5000) })], reads: [] }), sender(), "content");
    const again = store.dump().units.find((u) => u.n === 0)!;
    expect(again.hash).toBe(first);
    expect(again.expo?.band[0]).toBe(5000);
  });

  it("hashes addresses and titles where asked, totals' keys included", async () => {
    const { store, keep } = keeper({ ...preset("pages"), hashed: ["place", "title"] });
    await keep.record(wire(), sender(), "content");
    const page = store.dump().totals.find((t) => t.scope === "page")!;
    expect(page.key).toMatch(/^[0-9a-f]{16}$/);
    expect(page.title).toMatch(/^[0-9a-f]{16}$/);
    expect(page.hashed).toBe(true);
  });
});

describe("what the worker takes from the browser", () => {
  it("keeps nothing from a private window or a site switched off", async () => {
    const a = keeper(preset("daily"));
    expect(await a.keep.record(wire(), sender({ tab: { ...sender().tab, incognito: true } }), "content")).toBe(false);
    const b = keeper(preset("daily"), { enabledFor: async () => false });
    expect(await b.keep.record(wire(), sender(), "content")).toBe(false);
    expect([...a.store.dump().totals, ...b.store.dump().totals]).toEqual([]);
  });

  it("takes the tab's address where the recorder names another origin's", async () => {
    const { store, keep } = keeper(preset("pages"));
    await keep.record(wire({}, { href: "https://elsewhere.example/claimed" }), sender(), "content");
    expect(store.dump().totals.find((t) => t.scope === "page")!.key).toBe("https://www.example.com/news/story-12345");
  });

  it("files a frame's words under the page it is in, and links its visit to the page's", async () => {
    const { store, keep } = keeper(preset("study"));
    await keep.record(wire(), sender(), "content");
    const frameVisit = "fedcba9876543210fedcba9876543210";
    await keep.record(wire({}, { id: frameVisit, frame: "frame", href: "https://embed.example/post/1" }),
      sender({ url: "https://embed.example/post/1", frameId: 3, documentId: "doc2" }), "content");
    const d = store.dump();
    expect(d.visits.find((v) => v.id === frameVisit)!.parent).toBe(VISIT);
    expect(d.visits.find((v) => v.id === frameVisit)!.site).toBe("embed.example");
  });

  it("lets only the document that began a visit add to it", async () => {
    const { keep } = keeper(preset("daily"));
    expect(await keep.record(wire(), sender(), "content")).toBe(true);
    expect(await keep.record(wire({ seq: 1 }), sender({ documentId: "another" }), "content")).toBe(false);
  });

  it("files the PDF reader's words under its document, and a file from this computer under no site", async () => {
    const { store, keep } = keeper(preset("pages"));
    await keep.record(wire({}, { surface: "pdf", kind: "other" }), { url: "chrome-extension://x/reader.html?src=https%3A%2F%2Farxiv.org%2Fpdf%2F2401.1", tab: { id: 1, title: "Paper" } }, "reader");
    await keep.record(wire({}, { id: "abababababababababababababababab", surface: "pdf" }), { url: "chrome-extension://x/reader.html", tab: { id: 2, title: "local.pdf" } }, "reader");
    const keys = store.dump().totals.filter((t) => t.scope === "page").map((t) => t.key).sort();
    expect(keys).toEqual(["file:local.pdf", "https://arxiv.org/pdf/2401.1"]);
    expect(store.dump().totals.filter((t) => t.scope === "kind").map((t) => t.key)).toEqual(["document"]);
  });
});

describe("lenses", () => {
  const u = (n: number, bandMs: number, p: number[] | null, over: Partial<UnitRow> = {}): UnitRow => ({
    visit: "v", n, date: "2026-10-04", status: p ? "scored" : "short", found: 0, len: { words: 100 },
    verdict: p ? { p } : undefined, expo: { any: [bandMs, bandMs, 0, 0], half: [bandMs / 2, 0, 0, 0], band: [bandMs, bandMs / 2, bandMs / 4, 0], sightings: 1 }, ...over,
  });
  const units = [u(0, 4000, AI), u(1, 900, HUMAN), u(2, 1500, null), u(3, 1200, AI, { hash: "h", date: "2026-10-04" }), u(4, 1200, AI, { hash: "h", date: "2026-10-05" })];

  // In the middle band: 4,000, 900, 1,500, 1,200 and 1,200 ms, a quarter of each flung past, half
  // of each in a focused window.
  it("count what was on screen long enough by the rule chosen", () => {
    expect(tallyUnder(units, DEFAULT_LENS)).toMatchObject({ scored: 100, short: 100 }); // 3,000 and 1,125 ms, the flung quarter left out
    expect(tallyUnder(units, { ...DEFAULT_LENS, readMs: 500 }).scored).toBe(400);
    expect(tallyUnder(units, { ...DEFAULT_LENS, excludeFling: false }).scored).toBe(300);
    expect(tallyUnder(units, { ...DEFAULT_LENS, focusedOnly: true }).scored).toBe(100);
    expect(tallyUnder(units, { ...DEFAULT_LENS, visibility: "half" }).scored).toBe(100);
    expect(tallyUnder(units, { ...DEFAULT_LENS, visibility: "any", excludeFling: false }).scored).toBe(300);
  });

  it("count a paragraph read again once a day, or once ever, where its text was hashed", () => {
    const flung: Lens = { ...DEFAULT_LENS, excludeFling: false };
    expect(tallyUnder(units, { ...flung, once: "day" }).scored).toBe(300);
    expect(tallyUnder(units, { ...flung, once: "ever" }).scored).toBe(200);
  });

  it("weigh and estimate as asked", () => {
    const lens: Lens = { ...DEFAULT_LENS, excludeFling: false, weight: "paragraphs" };
    expect(tallyUnder(units, lens).scored).toBe(3);
    const t = tallyUnder(units, DEFAULT_LENS);
    expect(headlineOf(t, DEFAULT_LENS)).toBeCloseTo(0.9);
    expect(headlineOf(t, { headline: "heavyAndAi", estimator: "expected" })).toBeCloseTo(1);
    expect(headlineOf(t, { headline: "ai", estimator: "chip" })).toBe(1);
    expect(sharesUnder(t, { estimator: "argmax" })).toEqual([0, 0, 0, 1]);
  });

  it("count a paragraph under a floor of 75 as short", () => {
    const short = [u(0, 4000, AI, { len: { words: 60 } })];
    expect(tallyUnder(short, { ...DEFAULT_LENS, minWords: 75 })).toMatchObject({ scored: 0, short: 60 });
  });
});

describe("the summaries the statistics page shows", () => {
  it("are the kept totals under the default lens, and the paragraphs' under another", async () => {
    const { store, keep } = keeper(preset("paragraphs"));
    await keep.record(wire(), sender(), "content");
    const range = await store.read("2026-10-04", "2026-10-04", { units: true });
    const plain = summarize(range, "2026-10-04", "2026-10-04", DEFAULT_LENS);
    expect(plain.fromParagraphs).toBe(false);
    expect(plain.total.scored).toBe(105);
    // 1.5 s in the band, kept as 2 s at a second's precision.
    const strict = summarize(range, "2026-10-04", "2026-10-04", { ...DEFAULT_LENS, readMs: 3000 });
    expect(strict.fromParagraphs).toBe(true);
    expect(strict.total.scored).toBe(0);
    expect(strict.visits).toHaveLength(1);
    expect(plain.trend).toEqual([{ date: "2026-10-04", tally: plain.total }]);
    expect(plain.kinds.map((k) => k.kind)).toEqual(["article"]);
  });
});

describe("the export", () => {
  async function recorded(p: Preset) {
    const { store, keep } = keeper(preset(p));
    await keep.record(wire(), sender(), "content");
    await store.context({ at: START, date: "2026-10-04", extension: "0.9.0", browser: "Google Chrome 141.0", os: "macOS 26.0 arm", recording: { layers: {}, hashed: [], retention: {} } });
    const d = store.dump();
    return { visits: d.visits, units: d.units, events: d.events, texts: d.texts, totals: d.totals, tabs: d.tabs, contexts: d.context };
  }
  const opts = (p: Preset, over: Partial<ExportOptions> = {}): ExportOptions => ({
    from: "2026-10-04", to: "2026-10-04", layers: presetConfig(p).layers, hashed: [], link: "file", lens: DEFAULT_LENS,
    generatedAt: "2026-10-05T10:00:00Z", extensionVersion: "0.9.0", ...over,
  });
  const key = (n: number) => new Uint8Array(32).fill(n);

  it("says what it is, what it holds and what each column means", async () => {
    const file = buildExport(await recorded("fullText"), opts("fullText"), key(1));
    expect(file.manifest).toMatchObject({ schema: "anagram-stats", version: 1, link: "file", rows: { visits: 1, units: 2, texts: 2 } });
    expect(Object.keys(file.tables).sort()).toEqual(["context", "input", "intervals", "lens", "scroll", "state", "steps", "texts", "totals", "units", "visits"]);
    expect((file.manifest.dictionary as Record<string, unknown>).units).toBeDefined();
    expect(file.tables.visits!.columns.slice(0, 3)).toEqual(["id", "date", "start"]);
  });

  it("holds each dimension at the layer chosen, and nothing finer", async () => {
    const source = await recorded("fullText");
    const file = buildExport(source, opts("fullText", { layers: { ...presetConfig("fullText").layers, place: "domain", title: "none", text: "hash", time: "hour", input: "events", scroll: "second" } }), key(1));
    const visits = file.tables.visits!;
    expect(visits.columns).not.toContain("url");
    expect(visits.columns).not.toContain("title");
    expect(visits.rows[0]![visits.columns.indexOf("site")]).toBe("example.com");
    expect(visits.rows[0]![visits.columns.indexOf("start")]).toBe(coarseTime(START, "hour"));
    expect(file.tables.texts).toBeUndefined();
    expect(file.tables.units!.columns).not.toContain("head");
    expect(file.tables.input!.columns).not.toContain("x");
    expect(file.tables.scroll!.rows).toHaveLength(1); // at a second: 140 and 1,000 are less than a second after 100
    const daily = buildExport(source, opts("daily"), key(1));
    expect(Object.keys(daily.tables).sort()).toEqual(["context", "totals"]);
    expect(daily.tables.context!.rows[0]![daily.tables.context!.columns.indexOf("browser")]).toBe("Google");
  });

  it("keys ids and hashes for the file: two files cannot be joined by them, a stable key's can", async () => {
    const source = await recorded("study");
    const a = buildExport(source, opts("study"), key(1)), b = buildExport(source, opts("study"), key(2)), c = buildExport(source, opts("study"), key(1));
    const col = (f: typeof a, t: string, c2: string) => f.tables[t]!.rows.map((r) => r[f.tables[t]!.columns.indexOf(c2)]);
    expect(col(a, "units", "hash")).not.toEqual(col(b, "units", "hash"));
    expect(col(a, "visits", "id")).not.toEqual(col(b, "visits", "id"));
    expect(col(a, "units", "hash")).toEqual(col(c, "units", "hash"));
    // Sketches keep their likeness within a file, and are another file's strangers.
    const [s0, s1] = col(a, "units", "sketch") as string[];
    const [t0] = col(b, "units", "sketch") as string[];
    expect(sketchSimilarity(s0!, s1!)).toBeGreaterThan(0.5);
    expect(sketchSimilarity(s0!, t0!)).toBeLessThan(0.2);
  });

  it("writes every table as CSV beside its manifest, and previews it", async () => {
    const file = buildExport(await recorded("paragraphs"), opts("paragraphs"), key(1));
    const files = exportCsvFiles(file);
    expect(files.map((f) => f.name)).toContain("manifest.json");
    expect(files.find((f) => f.name === "units.csv")!.text.split("\n")[0]).toMatch(/^visit,n,status/);
    const p = preview(file);
    expect(p.bytes).toBeGreaterThan(100);
    expect(p.tables.find((t) => t.name === "units")!.rows).toBe(2);
  });
});

describe("the message a page sends", () => {
  const content: AccessSender = { id: "ext", url: "https://example.com/", origin: "https://example.com", frameId: 0, tab: { id: 3, url: "https://example.com/" } };
  const msg = (w: unknown) => ({ action: ACTIONS.STATS_RECORD, session: SESSION, wire: w });

  it("takes what the recorder sends, in its bounds, and nothing else", () => {
    expect(parseWorkerMessage(msg(wire()))).not.toBeNull();
    for (const bad of [
      msg({ ...wire(), site: "elsewhere.example" }),
      msg(wire({}, { id: "not-hex" })),
      msg(wire({ units: [unit(0, { verdict: { p: [0.5, 0.5, 0.5, 0.5] } })] })),
      msg(wire({ units: [unit(0, { status: "great" as never })] })),
      msg(wire({}, { kind: "shop" as never })),
      msg(wire({ reads: [{ n: 0, w: -1 }] })),
      msg(wire({ units: Array.from({ length: 257 }, (_, i) => unit(i, { text: undefined })) })),
      msg(wire({ events: { state: { t: [1, 2], kind: [3] } } })),
      msg(wire({ units: [unit(0, { text: "x".repeat(200_001) })] })),
    ]) expect(parseWorkerMessage(bad), JSON.stringify(bad).slice(0, 160)).toBeNull();
  });

  it("is taken from a page and from the PDF reader, never from Analyze text or the extension's other pages", () => {
    const m = parseWorkerMessage(msg(wire()))!;
    expect(permitsMessage("content", m, content)).toBe(true);
    expect(permitsMessage("reader", m, content)).toBe(true);
    for (const role of ["paste", "popup", "options", "onboarding", "stats"] as const) expect(permitsMessage(role, m, content), role).toBe(false);
  });

  it("takes a use of Anagram's pages from them, and not from a page", () => {
    const m = parseWorkerMessage({ action: ACTIONS.STATS_UI, kind: "menu", tabId: 4 })!;
    expect(m).not.toBeNull();
    expect(permitsMessage("popup", m, content)).toBe(true);
    expect(permitsMessage("content", m, content)).toBe(false);
    expect(parseWorkerMessage({ action: ACTIONS.STATS_UI, kind: "dance" })).toBeNull();
  });
});

describe("dates", () => {
  it("counts days on the calendar across a change of the clocks", () => {
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
    expect(datesBetween("2026-02-27", "2026-03-02")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
    expect(emptyTally().removed).toBe(0);
  });
});

describe("the kind of page", () => {
  const unitsIn = (doc: Document, selector: string): Unit[] =>
    [...doc.querySelectorAll(selector)].map((el, i) => ({ id: `u${i}`, topElement: el, wordCount: 80 }) as unknown as Unit);
  const at = (url: string) => new URL(url);

  it("tells a thread by its markup or its address, before anything else", () => {
    const { document } = parseHTML(`<html><body><script type="application/ld+json">{"@type":"QAPage"}</script><p>q</p></body></html>`);
    expect(pageKindOf(document, at("https://example.com/x"), unitsIn(document, "p"))).toBe("forum");
    const plain = parseHTML("<html><body><p>a</p></body></html>").document;
    expect(pageKindOf(plain, at("https://www.reddit.com/r/a/comments/xyz/title/"), [])).toBe("forum");
    expect(pageKindOf(plain, at("https://news.ycombinator.com/item"), [])).toBe("forum");
  });

  it("tells a feed by its host, by role=feed, or by many posts", () => {
    const plain = parseHTML("<html><body><p>a</p></body></html>").document;
    expect(pageKindOf(plain, at("https://mobile.x.com/home"), [])).toBe("feed");
    const feed = parseHTML(`<html><body><div role="feed"><p>a</p></div></body></html>`).document;
    expect(pageKindOf(feed, at("https://example.com/"), [])).toBe("feed");
    const posts = parseHTML(`<html><body>${Array.from({ length: 6 }, () => "<article><p>post</p></article>").join("")}</body></html>`).document;
    expect(pageKindOf(posts, at("https://example.com/"), unitsIn(posts, "p"))).toBe("feed");
  });

  it("tells an article by what it declares or by one article holding the text, comments and all", () => {
    const og = parseHTML(`<html><head><meta property="og:type" content="article"></head><body><article><p>a</p><p>b</p></article>${Array.from({ length: 6 }, () => "<article><p>c</p></article>").join("")}</body></html>`).document;
    expect(pageKindOf(og, at("https://example.com/2026/story"), unitsIn(og, "p"))).toBe("article");
    // Declared in og:type alone, with no body of text: a page of comment cards is not an article.
    const cards = parseHTML(`<html><head><meta property="og:type" content="article"></head><body>${Array.from({ length: 6 }, () => "<article><p>c</p></article>").join("")}</body></html>`).document;
    expect(pageKindOf(cards, at("https://example.com/"), unitsIn(cards, "p"))).toBe("feed");
    const one = parseHTML(`<html><body><main><p>a</p><p>b</p><p>c</p><p>d</p></main><aside><p>e</p></aside></body></html>`).document;
    expect(pageKindOf(one, at("https://example.com/essay"), unitsIn(one, "p"))).toBe("article");
    const shop = parseHTML(`<html><body><div><p>a</p></div><div><p>b</p></div></body></html>`).document;
    expect(pageKindOf(shop, at("https://shop.example/item/1"), unitsIn(shop, "p"))).toBe("other");
    expect(pageKindOf(shop, at("https://shop.example/"), [])).toBe("other");
    // A <main> of a few short paragraphs (a product's landing page) has no body of text …
    const landing = parseHTML(`<html><body><main><div><p>a</p></div><div><p>b</p></div></main></body></html>`).document;
    expect(pageKindOf(landing, at("https://vercel.example/"), unitsIn(landing, "p"))).toBe("other");
    // … where a page with no landmark at all but one has an article.
    const bare = parseHTML(`<html><body><div class="post"><p>a</p><p>b</p><p>c</p><p>d</p></div></body></html>`).document;
    expect(pageKindOf(bare, at("https://blog.example/notes"), unitsIn(bare, "p"))).toBe("article");
    // A product page is not an article, whatever share of its text one box holds.
    const product = parseHTML(`<html><head><meta property="og:type" content="product"></head><body><article><p>a</p><p>b</p><p>c</p><p>d</p></article></body></html>`).document;
    expect(pageKindOf(product, at("https://shop.example/boots"), unitsIn(product, "p"))).toBe("other");
  });

  it("tells a forum by its address with its query, its software, or its host", () => {
    const plain = parseHTML("<html><body><p>a</p></body></html>").document;
    for (const url of ["https://example.org/index.php?threads/a-question.123/", "https://example.org/viewtopic.php?t=1658", "https://example.org/index.php?/topic/201820-ai/", "https://example.org/forum/general-chat", "https://example.org/archive/t-921.html"])
      expect(pageKindOf(plain, at(url), []), url).toBe("forum");
    const discourse = parseHTML(`<html><head><meta name="generator" content="Discourse 3.4.0 - https://github.com/discourse/discourse"></head><body><p>a</p></body></html>`).document;
    expect(pageKindOf(discourse, at("https://talk.example.com/latest"), [])).toBe("forum");
    expect(pageKindOf(plain, at("https://community.example.com/x/1"), [])).toBe("forum");
    expect(pageKindOf(plain, at("https://example.org/topics"), [])).toBe("other");
  });

  it("does not take an article with a few related-post cards for a feed", () => {
    const related = parseHTML(`<html><body><article><p>a</p><p>b</p><p>c</p><p>d</p><p>e</p></article>${Array.from({ length: 5 }, () => "<article><p>card</p></article>").join("")}</body></html>`).document;
    expect(pageKindOf(related, at("https://example.com/story"), unitsIn(related, "p"))).toBe("article");
  });

  it("files a visit kept before the text body was measured as it was then", () => {
    const old = { feedHost: false, feedRole: false, forumPath: false, declared: null, posts: 0, inPosts: 0, sample: 3, largestShare: 0, mainShare: 0.8 };
    expect(kindFrom(old)).toBe("article");
    expect(kindFrom({ ...old, mainShare: 0.2 })).toBe("other");
  });

  it("keeps what it looked at, so another rule can be applied to it afterwards", () => {
    const posts = parseHTML(`<html><body>${Array.from({ length: 4 }, () => "<article><p>post</p></article>").join("")}</body></html>`).document;
    const s = kindSignals(posts, at("https://example.com/"), unitsIn(posts, "p"));
    expect(s).toMatchObject({ posts: 4, inPosts: 4, sample: 4 });
    expect(kindFrom(s)).toBe("other");
    expect(kindFrom(s, { ...DEFAULT_KIND_RULE, manyVoices: 4 })).toBe("feed");
  });
});
