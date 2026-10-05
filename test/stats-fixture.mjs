// test/stats-fixture.mjs — reading statistics to show, for the suites about the pages that show
// them (test/pw/stats.spec.mjs, test/pw/a11y.spec.mjs, test/pseudo-locale.mjs): rows in the
// shape lib/stats/store.ts keeps, put into the extension's database from its own worker.

/** The browser's local date, as the extension names days. */
export const localDate = (at = new Date()) =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;

/** `n` days before today. */
export const daysAgo = (n) => {
  const at = new Date();
  at.setHours(12, 0, 0, 0);
  at.setDate(at.getDate() - n);
  return localDate(at);
};

export const tally = (scored, expected, units, [short, language, unavailable, removed] = [0, 0, 0, 0], argmax = units) =>
  ({ scored, expected, units, argmax, short, language, unavailable, removed });

const MODEL = { id: "fake-editlens", ver: "test", calibration: "none" };

/** Today, as the statistics page's assertions know it: 14% AI-generated of 8,400 words scored,
 *  10,200 read; a feed and an article, two sites, one page. `scale` makes other days differ. */
export function statsRecords(date = localDate(), scale = 1) {
  const s = (t) => tally(t.scored * scale, t.expected.map((w) => w * scale), t.units, [t.short * scale, t.language * scale, t.unavailable * scale, t.removed * scale]);
  const feed = tally(3000, [1500, 500, 340, 660], [20, 5, 3, 4], [1200, 0, 0, 0]);
  const article = tally(5400, [3500, 1000, 384, 516], [20, 5, 3, 5], [0, 500, 100, 0]);
  const total = tally(8400, [5000, 1500, 724, 1176], [40, 10, 6, 9], [1200, 500, 100, 0]);
  return {
    totals: [
      { date, scope: "day", key: "", tally: s(total), models: [MODEL] },
      { date, scope: "kind", key: "feed", tally: s(feed) },
      { date, scope: "kind", key: "article", tally: s(article) },
      { date, scope: "site", key: "news.example", tally: s(article) },
      { date, scope: "site", key: "social.example", tally: s(feed) },
      { date, scope: "page", key: "https://news.example/story", title: "A story", start: "09:15", dwell: 125, kind: "article", tally: s(tally(5400, [3500, 1000, 384, 516], [20, 5, 3, 5])) },
    ],
    visits: [], units: [], events: [],
  };
}

/** A visit of three paragraphs with its events, as Full trace keeps it: for the lens, the visits
 *  table and the replay. */
export function statsVisit(date = localDate()) {
  const start = new Date(`${date}T10:00:00`).getTime();
  const visit = "0123456789abcdef0123456789abcdef";
  const band = (ms) => [ms, ms, 0, 0];
  const unit = (n, p, ms) => ({
    visit, n, date, status: "scored", found: n * 100, hash: `00000000000000${n}${n}`, len: { words: 100 },
    verdict: { p, score: p[1] / 3 + (2 * p[2]) / 3 + p[3], band: p[3] > 0.5 ? 3 : 0, argmax: p[3] > 0.5 ? 3 : 0 },
    expo: { any: band(ms), half: band(ms), band: band(ms), sightings: 1, first: 500, last: 500 + ms, readAt: ms >= 1000 ? 1500 : undefined },
  });
  const AI = [0, 0, 0.1, 0.9], HUMAN = [0.9, 0.1, 0, 0];
  const units = [unit(0, AI, 4000), unit(1, HUMAN, 1500), unit(2, AI, 600)];
  return {
    totals: [{ date, scope: "day", key: "", tally: tally(200, [90, 10, 10, 90], [1, 0, 0, 1]), models: [MODEL] }, { date, scope: "kind", key: "article", tally: tally(200, [90, 10, 10, 90], [1, 0, 0, 1]) }],
    visits: [{ id: visit, date, start, end: start + 60_000, frame: "top", kind: "article", surface: "web", url: "https://news.example/story", site: "news.example",
      places: { url: "https://news.example/story", path: "https://news.example/story", host: "news.example", domain: "news.example" },
      title: "A story", shown: 60_000, active: 50_000, focused: 60_000, tally: tally(200, [90, 10, 10, 90], [1, 0, 0, 1]) }],
    units,
    events: [{ visit, seq: 0, date, streams: {
      intervals: { unit: [0, 1, 2], kind: [0, 0, 0], start: [500, 4000, 9000], end: [4500, 5500, 9600], peak: [1, 1, 0.5] },
      scroll: { t: [0, 4000, 9000], box: [0, 0, 0], x: [0, 0, 0], y: [0, 600, 1400], vw: [1280, 1280, 1280], vh: [720, 720, 720], ph: [3000, 3000, 3000] },
    } }],
  };
}

/** Several days of them merged: what a week of reading looks like. */
export function statsWeek(days = [0, 1, 2, 4, 6]) {
  const out = { totals: [], visits: [], units: [], events: [] };
  days.forEach((n, i) => {
    const r = statsRecords(daysAgo(n), 1 + (i % 3) * 0.5);
    for (const key of Object.keys(out)) out[key].push(...r[key]);
  });
  return out;
}

/** Put `records` into the extension's database from its worker (`worker.evaluate`), making the
 *  database as lib/stats/store.ts does when it is not there yet. */
export function seedStats(worker, records) {
  return worker.evaluate(async (records) => {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open("anagram-stats", 2);
      open.onupgradeneeded = () => {
        const made = open.result;
        for (const name of [...made.objectStoreNames]) made.deleteObjectStore(name);
        made.createObjectStore("visits", { keyPath: "id" }).createIndex("date", "date");
        made.createObjectStore("units", { keyPath: ["visit", "n"] }).createIndex("date", "date");
        made.createObjectStore("events", { keyPath: ["visit", "seq"] }).createIndex("date", "date");
        made.createObjectStore("texts", { keyPath: "hash" }).createIndex("last", "last");
        made.createObjectStore("totals", { keyPath: ["date", "scope", "key"] });
        made.createObjectStore("tabs", { autoIncrement: true }).createIndex("date", "date");
        made.createObjectStore("context", { autoIncrement: true }).createIndex("date", "date");
        made.createObjectStore("meta");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const stores = ["totals", "visits", "units", "events"];
    const tx = db.transaction(stores, "readwrite");
    for (const store of stores) for (const record of records[store] ?? []) tx.objectStore(store).put(record);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  }, records);
}

/** lib/stats/config.ts, bundled for the suites (it is pure: it imports nothing). */
let config = null;
async function configModule() {
  if (!config) {
    const { build } = await import("esbuild");
    const { join } = await import("node:path");
    const { outputFiles } = await build({ entryPoints: [join(import.meta.dirname, "..", "lib", "stats", "config.ts")], bundle: true, write: false, format: "esm" });
    config = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString("base64")}`);
  }
  return config;
}

/** A preset's configuration in storage.local's shape, as Settings writes it (`statsConfig`). */
export async function presetConfig(name, over = {}) {
  const { presetConfig: make, normalize } = await configModule();
  const c = make(name);
  return normalize({ ...c, ...over, layers: { ...c.layers, ...(over.layers ?? {}) } }).config;
}
