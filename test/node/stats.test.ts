// test/node/stats.test.ts — the reading statistics: what a message adds at each level, what
// the worker takes from the browser rather than the page, retention, the export's coarsening,
// and the message a page may send.
//
// IndexedDB itself is not here (vitest has none): the store's rules are applyReading's, which
// the in-memory store below applies exactly as lib/stats/store.ts does; the browser suites
// (test/pw/stats.spec.mjs) run the real database.
import { describe, expect, it } from "vitest";
import { parseHTML } from "linkedom";
import { addDays, aiShare, bandOf, datesBetween, emptyTally, monthRange, retentionOf, statsLevelOf, tallyOf, viewedWords } from "../../lib/stats/model";
import { applyReading, MAX_SITES_PER_DAY, pageKey, type DayRecord, type PageRecord, type Reading, type SiteRecord } from "../../lib/stats/record";
import { createStatsRecorder, type StatsRecorderDeps, type StatsSender } from "../../lib/stats/worker";
import type { StatsStore } from "../../lib/stats/store";
import { buildExport, dailyCsv, type ExportContext } from "../../lib/stats/export";
import { byKind, bySite, feedsAndRest, recordedLevel, sumDays, trend } from "../../lib/stats/summary";
import { pageKindOf } from "../../lib/stats/pageKind";
import { parseWorkerMessage, permitsMessage, type AccessSender, type WorkerMessage } from "../../lib/access/messages";
import { ACTIONS } from "../../lib/messaging/protocol";
import type { Unit } from "../../lib/types";

const SESSION = "0f8fad5b-d9cb-469f-a165-70867728950e";
const AI = [0, 0, 0.1, 0.9];
const HUMAN = [0.9, 0.1, 0, 0];

function reading(over: Partial<Reading> = {}): Reading {
  return {
    date: "2026-10-04", minute: "09:15", site: "example.com", url: "https://example.com/post", title: "A post", kind: "article", dwell: 0,
    units: [{ words: 100, probs: AI }], skipped: [], ...over,
  };
}

/** lib/stats/store.ts, in memory: the same reads, applyReading, the same writes. */
function memoryStore(): StatsStore & { days: Map<string, DayRecord>; sites: Map<string, SiteRecord>; pages: Map<string, PageRecord>; prunes: string[] } {
  const days = new Map<string, DayRecord>(), sites = new Map<string, SiteRecord>(), pages = new Map<string, PageRecord>();
  const meta = new Map<string, unknown>();
  const prunes: string[] = [];
  return {
    days, sites, pages, prunes,
    async record(level, r) {
      const next = applyReading(level, r, { day: days.get(r.date), site: sites.get(`${r.date} ${r.site}`), page: pages.get(`${r.date} ${pageKey(r.url, r.title)}`) });
      if (next.day) days.set(r.date, next.day);
      if (next.site) sites.set(`${r.date} ${r.site}`, next.site);
      if (next.page) pages.set(`${r.date} ${next.page.key}`, next.page);
    },
    async read(from, to) {
      const within = (d: string) => d >= from && d <= to;
      return { days: [...days.values()].filter((d) => within(d.date)), sites: [...sites.values()].filter((s) => within(s.date)), pages: [...pages.values()].filter((p) => within(p.date)) };
    },
    async day(date) { return days.get(date); },
    async first() { return [...days.keys()].sort()[0] ?? null; },
    async prune(before) {
      prunes.push(before);
      for (const map of [days, sites, pages] as Map<string, { date: string }>[]) for (const [k, v] of map) if (v.date < before) map.delete(k);
    },
    async clear() { days.clear(); sites.clear(); pages.clear(); meta.clear(); },
    async getMeta(key) { return meta.get(key); },
    async setMeta(key, value) { meta.set(key, value); },
  };
}

type StatsMessage = Extract<WorkerMessage, { action: "statsRecord" }>;
const message = (over: Partial<StatsMessage> = {}): StatsMessage => ({
  action: ACTIONS.STATS_RECORD, session: SESSION, kind: "article", dwell: 0, units: [{ w: 100, p: AI }], skipped: [], ...over,
});
const tab = (url: string, over: Partial<NonNullable<StatsSender["tab"]>> = {}): StatsSender => ({ url, frameId: 0, tab: { url, title: "Title", incognito: false, ...over } });

function recorder(over: Partial<StatsRecorderDeps> = {}) {
  const store = memoryStore();
  let clock = new Date(2026, 9, 4, 9, 15);
  const deps: StatsRecorderDeps = {
    store, level: async () => "pages", retention: async () => 90, enabledFor: async () => true,
    model: () => ({ id: "fake-editlens", ver: "test", calibration: "none" }), minWords: async () => 50,
    now: () => clock, ...over,
  };
  return { store, rec: createStatsRecorder(deps), setClock: (d: Date) => { clock = d; } };
}

describe("what a paragraph read adds", () => {
  it("adds its words to each band by the model's probabilities, and counts it under the word its chip shows", () => {
    // Most likely AI-generated (0.6), but the chip's word is the score's slice: (0.6·3)/3 = .60, heavily edited.
    const t = tallyOf([{ words: 200, probs: [0.4, 0, 0, 0.6] }, { words: 100, probs: HUMAN }], []);
    expect(t.scored).toBe(300);
    expect(t.expected.map((x) => Math.round(x))).toEqual([170, 10, 0, 120]);
    expect(t.units).toEqual([1, 0, 1, 0]);
    expect(bandOf([0.4, 0, 0, 0.6])).toBe(2);
    expect(aiShare(t)).toBeCloseTo(0.4);
  });

  it("keeps words without a verdict out of the bands, by why", () => {
    const t = tallyOf([], [{ words: 30, why: "short" }, { words: 80, why: "language" }, { words: 120, why: "unavailable" }]);
    expect(t.scored).toBe(0);
    expect(t.expected).toEqual([0, 0, 0, 0]);
    expect([t.short, t.language, t.unavailable]).toEqual([30, 80, 120]);
    expect(viewedWords(t)).toBe(230);
    expect(aiShare(t)).toBeNull();
  });
});

describe("what each level keeps", () => {
  it("keeps nothing when off, the day alone when daily, the site too, and the page last", () => {
    expect(applyReading("off", reading(), {})).toEqual({});
    const daily = applyReading("daily", reading(), {});
    expect(Object.keys(daily)).toEqual(["day"]);
    expect(daily.day!.kinds.article!.scored).toBe(100);
    expect(Object.keys(applyReading("sites", reading(), {})).sort()).toEqual(["day", "site"]);
    const pages = applyReading("pages", reading({ dwell: 12 }), {});
    expect(Object.keys(pages).sort()).toEqual(["day", "page", "site"]);
    expect(pages.page).toMatchObject({ url: "https://example.com/post", title: "A post", start: "09:15", dwell: 12, kind: "article" });
    expect(pages.day).toMatchObject({ level: "pages", siteCount: 1, pageCount: 1 });
  });

  it("lists a page only once something on it was read, and adds the time shown to a page already listed", () => {
    expect(applyReading("pages", reading({ units: [], dwell: 30 }), {})).toEqual({});
    const first = applyReading("pages", reading(), {});
    const later = applyReading("pages", reading({ units: [], dwell: 30, minute: "10:00", title: "A post (edited)" }), first);
    expect(later.day).toBeUndefined();
    expect(later.page).toMatchObject({ start: "09:15", dwell: 30, title: "A post (edited)" });
    expect(later.page!.tally.scored).toBe(100);
  });

  it("stops adding sites past the day's bound, while the day's totals still count", () => {
    const day = applyReading("sites", reading(), {}).day!;
    day.siteCount = MAX_SITES_PER_DAY;
    const next = applyReading("sites", reading({ site: "another.example" }), { day });
    expect(next.site).toBeUndefined();
    expect(next.day!.total.scored).toBe(200);
    // A site the day already has is still added to.
    expect(applyReading("sites", reading(), { day, site: { date: "2026-10-04", site: "example.com", tally: emptyTally() } }).site!.tally.scored).toBe(100);
  });

  it("notes the day's models and minimum lengths, each once", () => {
    let records = applyReading("daily", reading({ model: { id: "m", ver: "1", calibration: "c" }, minWords: 50 }), {});
    records = applyReading("daily", reading({ model: { id: "m", ver: "1", calibration: "c" }, minWords: 75 }), records);
    expect(records.day!.models).toEqual([{ id: "m", ver: "1", calibration: "c" }]);
    expect(records.day!.minWords).toEqual([50, 75]);
  });
});

describe("what the worker takes from the browser", () => {
  it("records the tab's site without www., the address without its query, and the date by its own clock", async () => {
    const { store, rec } = recorder();
    expect(await rec.record(message(), tab("https://www.example.com/a/post?utm=1#c"), "content")).toBe(true);
    expect([...store.sites.values()].map((s) => s.site)).toEqual(["example.com"]);
    expect([...store.pages.values()].map((p) => [p.date, p.url, p.title])).toEqual([["2026-10-04", "https://www.example.com/a/post", "Title"]]);
  });

  it("records nothing from a private window, while statistics are off, or on a site switched off", async () => {
    const off = recorder({ level: async () => "off" });
    expect(await off.rec.record(message(), tab("https://example.com/"), "content")).toBe(false);
    const priv = recorder();
    expect(await priv.rec.record(message(), tab("https://example.com/", { incognito: true }), "content")).toBe(false);
    const asked: (string | null)[] = [];
    const switchedOff = recorder({ enabledFor: async (h) => { asked.push(h); return false; } });
    expect(await switchedOff.rec.record(message(), tab("https://www.example.com/"), "content")).toBe(false);
    expect(asked).toEqual(["www.example.com"]);
    for (const r of [off, priv, switchedOff]) expect(r.store.days.size).toBe(0);
  });

  it("records nothing for a page that is no web page", async () => {
    const { store, rec } = recorder();
    expect(await rec.record(message(), tab("chrome://settings/"), "content")).toBe(false);
    expect(await rec.record(message(), { frameId: 0 }, "content")).toBe(false);
    expect(store.days.size).toBe(0);
  });

  it("takes the time shown from the top frame only", async () => {
    const { store, rec } = recorder();
    await rec.record(message({ dwell: 40 }), { ...tab("https://example.com/p"), frameId: 3 }, "content");
    await rec.record(message({ dwell: 5 }), tab("https://example.com/p"), "content");
    expect([...store.pages.values()][0]!.dwell).toBe(5);
  });

  it("counts the PDF reader's words as a document of the PDF's own site, and a file from this computer as no site", async () => {
    const { store, rec } = recorder();
    const reader = (query: string): StatsSender => ({ url: `chrome-extension://abc/reader.html${query}`, frameId: 0, tab: { url: `chrome-extension://abc/reader.html${query}`, title: "paper.pdf" } });
    await rec.record(message({ kind: "feed" }), reader(`?src=${encodeURIComponent("https://www.arxiv.org/pdf/1.pdf?x=1")}`), "reader");
    await rec.record(message(), reader(""), "reader");
    expect([...store.sites.values()].map((s) => s.site).sort()).toEqual(["", "arxiv.org"]);
    expect([...store.pages.values()].map((p) => [p.url, p.kind, p.key]).sort()).toEqual([["", "document", "file:paper.pdf"], ["https://www.arxiv.org/pdf/1.pdf", "document", "https://www.arxiv.org/pdf/1.pdf"]]);
  });

  it("deletes the days past retention at most once a day, and again when the setting changes", async () => {
    let days: 30 | 90 | 365 = 90;
    const { store, rec, setClock } = recorder({ retention: async () => days });
    store.days.set("2026-07-05", applyReading("daily", reading({ date: "2026-07-05" }), {}).day!);
    store.days.set("2026-07-06", applyReading("daily", reading({ date: "2026-07-06" }), {}).day!);
    await rec.record(message(), tab("https://example.com/"), "content");
    await rec.record(message(), tab("https://example.com/"), "content");
    // Ninety days counting today: the fifth of July is the first day kept.
    expect(store.prunes).toEqual(["2026-07-07"]);
    expect([...store.days.keys()].sort()).toEqual(["2026-10-04"]);
    setClock(new Date(2026, 9, 5, 8));
    await rec.record(message(), tab("https://example.com/"), "content");
    days = 30;
    await rec.record(message(), tab("https://example.com/"), "content");
    expect(store.prunes).toEqual(["2026-07-07", "2026-07-08", "2026-09-06"]);
  });
});

describe("the export", () => {
  const ctx: ExportContext = { generatedAt: "2026-10-04", extensionVersion: "0.8.2", flagFrom: "heavy", minWords: 50, mergeShorts: true };
  async function recordedByPage() {
    const { store, rec, setClock } = recorder();
    await rec.record(message({ units: [{ w: 100, p: AI }, { w: 50, p: HUMAN }], skipped: [{ w: 20, why: "short" }], dwell: 9 }), tab("https://example.com/a"), "content");
    setClock(new Date(2026, 9, 3, 20));
    await rec.record(message({ kind: "feed", units: [{ w: 40, p: HUMAN }] }), tab("https://social.example/home"), "content");
    return store.read("2026-10-01", "2026-10-04");
  }

  it("says what it is and where it came from", async () => {
    const range = await recordedByPage();
    const file = buildExport(range, "2026-10-01", "2026-10-04", recordedLevel(range), "pages", ctx);
    expect(file).toMatchObject({ schema: "anagram-stats", version: 1, generatedAt: "2026-10-04", extension: { version: "0.8.2" },
      model: [{ id: "fake-editlens", ver: "test", calibration: "none" }], level: { recorded: "pages", exported: "pages" }, range: { from: "2026-10-01", to: "2026-10-04" },
      settings: { minWords: [50], minWordsNow: 50, flagFrom: "heavy" }, scale: { bands: ["human", "light", "heavy", "ai"] } });
    expect(file.words).toEqual({ viewed: 210, scored: 190 });
    expect(file.coverage).toEqual({ short: 20, language: 0, unavailable: 0 });
    expect(file.days.map((d) => d.date)).toEqual(["2026-10-03", "2026-10-04"]);
    expect(file.sites!.map((s) => s.site)).toEqual(["social.example", "example.com"]);
    expect(file.pages!.map((p) => [p.url, p.dwell])).toEqual([["https://social.example/home", 0], ["https://example.com/a", 9]]);
    expect(JSON.stringify(file)).not.toMatch(/siteCount|pageCount/);
  });

  it("is coarsened to daily totals with no site and no page, not even how many", async () => {
    const range = await recordedByPage();
    const file = buildExport(range, "2026-10-01", "2026-10-04", "pages", "daily", ctx);
    expect(file.level).toEqual({ recorded: "pages", exported: "daily" });
    expect(file.sites).toBeUndefined();
    expect(file.pages).toBeUndefined();
    expect(file.days.every((d) => d.level === "daily")).toBe(true);
    const text = JSON.stringify(file);
    for (const leak of ["example.com", "social.example", "Title", "https://"]) expect(text).not.toContain(leak);
    // By site, it has the sites and still no page.
    const sites = buildExport(range, "2026-10-01", "2026-10-04", "pages", "sites", ctx);
    expect(sites.sites).toHaveLength(2);
    expect(sites.pages).toBeUndefined();
  });

  it("is never finer than what was recorded", async () => {
    const { store, rec } = recorder({ level: async () => "sites" });
    await rec.record(message(), tab("https://example.com/a"), "content");
    const range = await store.read("2026-10-04", "2026-10-04");
    expect(recordedLevel(range)).toBe("sites");
    const file = buildExport(range, "2026-10-04", "2026-10-04", recordedLevel(range), "pages", ctx);
    expect(file.level.exported).toBe("sites");
    expect(file.pages).toBeUndefined();
  });

  it("has the daily rows as CSV", async () => {
    const range = await recordedByPage();
    const csv = dailyCsv(buildExport(range, "2026-10-01", "2026-10-04", "pages", "daily", ctx)).trim().split("\n");
    expect(csv[0]).toBe("date,words_viewed,words_scored,expected_human,expected_light,expected_heavy,expected_ai,units_human,units_light,units_heavy,units_ai,not_scored_short,not_scored_language,not_scored_unavailable");
    expect(csv[2]).toBe("2026-10-04,170,150,45,5,10,90,1,0,0,1,20,0,0");
  });
});

describe("the summaries the statistics page shows", () => {
  it("adds up the days, the kinds, feeds against the rest, the sites and every date of a trend", async () => {
    const { store, rec } = recorder();
    await rec.record(message({ kind: "feed", units: [{ w: 100, p: AI }] }), tab("https://social.example/"), "content");
    await rec.record(message({ kind: "article", units: [{ w: 300, p: HUMAN }] }), tab("https://news.example/a"), "content");
    const range = await store.read("2026-10-01", "2026-10-04");
    expect(sumDays(range.days).scored).toBe(400);
    expect(byKind(range.days).map((k) => [k.kind, k.tally.scored])).toEqual([["feed", 100], ["article", 300]]);
    const { feeds, rest } = feedsAndRest(range.days);
    expect([aiShare(feeds), aiShare(rest)]).toEqual([0.9, 0]);
    expect(bySite(range.sites).map((s) => s.site)).toEqual(["news.example", "social.example"]);
    expect(trend(range.days, "2026-10-02", "2026-10-04").map((d) => [d.date, d.tally.scored])).toEqual([["2026-10-02", 0], ["2026-10-03", 0], ["2026-10-04", 400]]);
  });
});

describe("the message a page sends", () => {
  const content: AccessSender = { id: "ext", url: "https://example.com/", origin: "https://example.com", frameId: 0, tab: { id: 3, url: "https://example.com/" } };

  it("takes numbers in their bounds, and nothing else", () => {
    expect(parseWorkerMessage(message({ skipped: [{ w: 12, why: "short" }], dwell: 30 }))).not.toBeNull();
    for (const bad of [
      { ...message(), text: "a paragraph" },
      { ...message(), site: "elsewhere.example" },
      message({ units: [{ w: 100, p: [0.5, 0.5, 0.5, 0.5] }] }),
      message({ units: [{ w: 100, p: [1, 0, 0] }] }),
      message({ units: [{ w: 0, p: AI }] }),
      message({ units: [{ w: 1.5, p: AI }] }),
      message({ dwell: -1 }),
      message({ dwell: 601 }),
      { ...message(), kind: "shop" },
      message({ skipped: [{ w: 5, why: "boring" as never }] }),
      message({ units: Array.from({ length: 257 }, () => ({ w: 1, p: AI })) }),
    ]) expect(parseWorkerMessage(bad), JSON.stringify(bad).slice(0, 120)).toBeNull();
  });

  it("is taken from a page and from the PDF reader, never from Analyze text or the extension's other pages", () => {
    const msg = parseWorkerMessage(message())!;
    expect(permitsMessage("content", msg, content)).toBe(true);
    expect(permitsMessage("reader", msg, content)).toBe(true);
    for (const role of ["paste", "popup", "options", "onboarding"] as const) expect(permitsMessage(role, msg, content), role).toBe(false);
  });
});

describe("settings and dates", () => {
  it("answers a stored value that is not a choice with the default", () => {
    expect(statsLevelOf("pages")).toBe("pages");
    expect(statsLevelOf("everything")).toBe("off");
    expect(retentionOf(365)).toBe(365);
    expect(retentionOf(7)).toBe(90);
  });

  it("counts days on the calendar across a change of the clocks", () => {
    expect(addDays("2026-03-28", 2)).toBe("2026-03-30");
    expect(addDays("2026-11-01", -1)).toBe("2026-10-31");
    expect(datesBetween("2026-02-27", "2026-03-02")).toEqual(["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
    expect(monthRange("2028-02")).toEqual({ from: "2028-02-01", to: "2028-02-29" });
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
    const og = parseHTML(`<html><head><meta property="og:type" content="article"></head><body>${Array.from({ length: 6 }, () => "<article><p>c</p></article>").join("")}</body></html>`).document;
    expect(pageKindOf(og, at("https://example.com/2026/story"), unitsIn(og, "p"))).toBe("article");
    const one = parseHTML(`<html><body><main><p>a</p><p>b</p><p>c</p></main><aside><p>d</p></aside></body></html>`).document;
    expect(pageKindOf(one, at("https://example.com/essay"), unitsIn(one, "p"))).toBe("article");
    const shop = parseHTML(`<html><body><div><p>a</p></div><div><p>b</p></div></body></html>`).document;
    expect(pageKindOf(shop, at("https://shop.example/item/1"), unitsIn(shop, "p"))).toBe("other");
    expect(pageKindOf(shop, at("https://shop.example/"), [])).toBe("other");
  });
});
