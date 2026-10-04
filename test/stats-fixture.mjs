// test/stats-fixture.mjs — reading statistics to show, for the suites about the pages that show
// them (test/pw/stats.spec.mjs, test/pw/a11y.spec.mjs, test/pseudo-locale.mjs): records in the
// shape lib/stats/record.ts writes, put into the extension's database from its own worker.

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

export const tally = (scored, expected, units, [short, language, unavailable] = [0, 0, 0]) => ({ scored, expected, units, short, language, unavailable });

/** Today, as the statistics page's assertions know it: 14% AI-generated of 8,400 words scored,
 *  10,200 read; a feed and an article, two sites, one page. `scale` makes other days differ. */
export function statsRecords(date = localDate(), scale = 1) {
  const s = (t) => tally(t.scored * scale, t.expected.map((w) => w * scale), t.units, [t.short * scale, t.language * scale, t.unavailable * scale]);
  const feed = tally(3000, [1500, 500, 340, 660], [20, 5, 3, 4], [1200, 0, 0]);
  const article = tally(5400, [3500, 1000, 384, 516], [20, 5, 3, 5], [0, 500, 100]);
  const total = tally(8400, [5000, 1500, 724, 1176], [40, 10, 6, 9], [1200, 500, 100]);
  return {
    days: [{ date, level: "pages", total: s(total), siteCount: 2, pageCount: 1, kinds: { feed: s(feed), article: s(article) },
      models: [{ id: "fake-editlens", ver: "test", calibration: "none" }], minWords: [50] }],
    sites: [{ date, site: "news.example", tally: s(article) }, { date, site: "social.example", tally: s(feed) }],
    pages: [{ date, key: "https://news.example/story", url: "https://news.example/story", title: "A story", start: "09:15", dwell: 125, kind: "article", tally: s(tally(5400, [3500, 1000, 384, 516], [20, 5, 3, 5])) }],
  };
}

/** Several days of them merged: what a week of reading looks like. */
export function statsWeek(days = [0, 1, 2, 4, 6]) {
  const out = { days: [], sites: [], pages: [] };
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
      const open = indexedDB.open("anagram-stats", 1);
      open.onupgradeneeded = () => {
        const made = open.result;
        made.createObjectStore("days", { keyPath: "date" });
        made.createObjectStore("sites", { keyPath: ["date", "site"] });
        made.createObjectStore("pages", { keyPath: ["date", "key"] });
        made.createObjectStore("meta");
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const tx = db.transaction(["days", "sites", "pages"], "readwrite");
    for (const store of ["days", "sites", "pages"]) for (const record of records[store]) tx.objectStore(store).put(record);
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); });
    db.close();
  }, records);
}
