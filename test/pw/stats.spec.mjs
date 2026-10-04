// The reading statistics (lib/stats/), against the deterministic fake host: nothing is kept
// while they are off; a paragraph counts once it has been on screen, once however often it is
// scrolled back to; each level keeps what it says and no more; the PDF reader's paragraphs
// count as a document; the statistics page shows the numbers recorded, exports them at a
// coarser level and clears them; lowering the level offers to delete what it no longer
// records; and the toolbar menu has today's line.
//
// The database is read from the extension's worker (the extension's own origin); its records
// are seeded from it too where a test is about the page rather than the reading
// (test/stats-fixture.mjs).
//
//   npx playwright test stats --project chromium
import { readFile } from "node:fs/promises";
import { test, expect, settledChips, ABSENCE_MS, popupOver } from "./kit.mjs";
import { fakeScore } from "../fake-native.mjs";
import { TEST_PDF, pdfChips, readerRead } from "../pdf-fixture.mjs";
import { localDate, seedStats, statsRecords } from "../stats-fixture.mjs";

test.use({ launch: { viewport: { width: 1280, height: 720 } } });

/** A paragraph of exactly `n` words (as Intl.Segmenter counts them), opening on `tag`. */
const WORDS = "the river carried small boats past quiet towns where people read letters and wrote replies before supper while dogs slept under tables near open doors".split(" ");
const para = (tag, n = 90) => `${tag} ${Array.from({ length: n - 1 }, (_, i) => WORDS[i % WORDS.length]).join(" ")}.`;
const TOP = ["Alpha", "Bravo", "Charlie"].map((t) => para(t));
const BELOW = ["Delta", "Echo"].map((t) => para(t));
const article = (title) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><meta property="og:type" content="article"></head>
<body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui"><main>
${TOP.map((p) => `<p>${p}</p>`).join("\n")}
<div style="height:4000px"></div>
${BELOW.map((p) => `<p>${p}</p>`).join("\n")}
</main></body></html>`;

/** What the extension's database holds, from its worker; null while there is no database. */
const statsDb = (extension) =>
  extension.worker().evaluate(async () => {
    const db = await new Promise((resolve) => {
      const open = indexedDB.open("anagram-stats");
      // No database yet: none is made here, or the extension's own would find it empty.
      open.onupgradeneeded = () => open.transaction.abort();
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => resolve(null);
    });
    if (!db) return null;
    const all = (store) => new Promise((resolve) => { const r = db.transaction(store).objectStore(store).getAll(); r.onsuccess = () => resolve(r.result); });
    const out = { days: await all("days"), sites: await all("sites"), pages: await all("pages") };
    db.close();
    return out;
  });

/** The day's totals as soon as they hold `units` paragraphs (the page sends every few seconds). */
const dayWith = (extension, units) =>
  expect.poll(async () => {
    const db = await statsDb(extension);
    return db?.days[0]?.total.units.reduce((a, b) => a + b, 0) ?? 0;
  }, { message: `${units} paragraphs recorded`, timeout: 25_000 }).toBe(units);

/** A page's text, the fake host's probabilities for it, and so the expected words of each band. */
const expectedOf = (texts, n = 90) => {
  const out = [0, 0, 0, 0];
  for (const text of texts) fakeScore(text).probs.forEach((p, i) => (out[i] += n * p));
  return out;
};

async function readTop(page, pages, path = "/article.html", title = "A test article") {
  pages.serve({ [path]: article(title), "/favicon.ico": (req, res) => res.writeHead(204).end(), "/elsewhere.html": "<!doctype html><title>elsewhere</title><p>nothing</p>" });
  await page.goto(pages.url(path), { waitUntil: "load" });
  // The three on screen; the two below may be read ahead meanwhile, which is not reading them.
  await expect.poll(() => settledChips(page).count()).toBeGreaterThanOrEqual(3);
}

test("nothing is recorded while statistics are off, which is the default", async ({ page, pages, extension, storage }) => {
  expect((await storage.get("statsLevel")).statsLevel).toBeUndefined();
  await readTop(page, pages);
  // Long enough on screen to count, and the page left, which sends whatever there was.
  await page.waitForTimeout(1500);
  await page.goto(pages.url("/elsewhere.html"), { waitUntil: "load" });
  await page.waitForTimeout(ABSENCE_MS);
  expect(await statsDb(extension), "no database at all").toBeNull();
});

test("daily totals: the paragraphs read, once each, as expected words per verdict, and nothing of the site or the page", async ({ page, pages, extension, storage }) => {
  await storage.set({ statsLevel: "daily" });
  await readTop(page, pages);
  // The three on screen count; the two far below have not been read.
  await dayWith(extension, 3);
  const first = (await statsDb(extension)).days[0];
  expect(first.date).toBe(localDate());
  expect(first.total.scored).toBe(270);
  expect(first.total.expected.reduce((a, b) => a + b, 0)).toBeCloseTo(270, 0);
  first.total.expected.forEach((w, i) => expect(w, `band ${i}`).toBeCloseTo(expectedOf(TOP)[i], 0));
  expect(Object.keys(first.kinds)).toEqual(["article"]);
  // Scrolled to, they count too; scrolled back past, nothing counts twice.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(settledChips(page)).toHaveCount(5);
  await dayWith(extension, 5);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(1500);
  await page.goto(pages.url("/elsewhere.html"), { waitUntil: "load" });
  await page.waitForTimeout(ABSENCE_MS);
  const db = await statsDb(extension);
  expect(db.days).toHaveLength(1);
  expect(db.days[0].total.scored).toBe(450);
  expect(db.days[0].level).toBe("daily");
  expect(db.sites).toEqual([]);
  expect(db.pages).toEqual([]);
  expect(JSON.stringify(db), "no text, no address").not.toMatch(/Alpha|river|localhost|article\.html/);
});

test("by site: each host's share of the day, without www. and without any page", async ({ page, pages, extension, storage }) => {
  await storage.set({ statsLevel: "sites" });
  await readTop(page, pages);
  await dayWith(extension, 3);
  // The same server under its address: another site.
  await page.goto(pages.url("/article.html").replace("localhost", "127.0.0.1"), { waitUntil: "load" });
  await expect.poll(() => settledChips(page).count()).toBeGreaterThanOrEqual(3);
  await expect.poll(async () => (await statsDb(extension)).sites.map((s) => [s.site, s.tally.scored]).sort(), { timeout: 25_000 })
    .toEqual([["127.0.0.1", 270], ["localhost", 270]]);
  const db = await statsDb(extension);
  expect(db.pages).toEqual([]);
  expect(db.days[0]).toMatchObject({ level: "sites", siteCount: 2 });
});

test("every page: its address without the query, its title, when it was opened and how long it was shown", async ({ page, pages, extension, storage }) => {
  await storage.set({ statsLevel: "pages" });
  pages.serve({ "/article.html": article("A test article") });
  await page.goto(pages.url("/article.html?utm_source=x#top"), { waitUntil: "load" });
  await expect.poll(() => settledChips(page).count()).toBeGreaterThanOrEqual(3);
  await dayWith(extension, 3);
  await page.waitForTimeout(1500);
  await page.goto("about:blank");
  await expect.poll(async () => (await statsDb(extension)).pages[0]?.dwell ?? 0, { message: "the time shown", timeout: 25_000 }).toBeGreaterThan(0);
  const [record] = (await statsDb(extension)).pages;
  expect(record).toMatchObject({ url: pages.url("/article.html"), title: "A test article", kind: "article" });
  expect(record.start).toMatch(/^\d\d:\d\d$/);
  expect(record.tally.scored).toBe(270);
});

test("the PDF reader's paragraphs count as a document, and a file from this computer as no site", async ({ page, extension, storage }) => {
  await storage.set({ statsLevel: "sites" });
  await page.goto(extension.url("reader.html"), { waitUntil: "load" });
  await page.setInputFiles("#file", { name: "dropped.pdf", mimeType: "application/pdf", buffer: TEST_PDF });
  await readerRead(page);
  expect(await pdfChips(page)).toBeGreaterThan(0);
  await expect.poll(async () => (await statsDb(extension))?.days[0]?.kinds.document?.scored ?? 0, { timeout: 25_000 }).toBeGreaterThan(0);
  const db = await statsDb(extension);
  expect(Object.keys(db.days[0].kinds)).toEqual(["document"]);
  expect(db.sites.map((s) => s.site)).toEqual([""]);
});

// ---- the statistics page --------------------------------------------------------------------

/** The statistics page, with `records` put in the database first. */
async function statsPage(page, extension, records) {
  if (records) await seedStats(extension.worker(), records);
  await page.goto(extension.url("stats.html"), { waitUntil: "load" });
  return page;
}

test("the statistics page, while off, says what each level keeps and turns one on", async ({ page, extension, storage }) => {
  await statsPage(page, extension);
  await expect(page.locator("#offCard")).toBeVisible();
  await expect(page.locator("#content")).toBeHidden();
  await expect(page.locator("#offCard .levels li")).toHaveCount(3);
  await expect(page.locator("#turnOnWarn")).toBeHidden();
  await page.selectOption("#turnOnLevel", "pages");
  await expect(page.locator("#turnOnWarn")).toBeVisible();
  await page.click("#turnOn");
  await expect.poll(async () => (await storage.get("statsLevel")).statsLevel).toBe("pages");
  await expect(page.locator("#offCard")).toBeHidden();
  await expect(page.locator("#levelLine")).toHaveText("Recording: Every page, kept for 90 days.");
});

test("the statistics page shows what was recorded: the share, the four verdicts, kinds, feeds, sites, coverage and pages", async ({ page, extension, storage }) => {
  await storage.set({ statsLevel: "pages" });
  await statsPage(page, extension, statsRecords());
  await expect(page.locator("#heroShare")).toHaveText("14%");
  await expect(page.locator("#heroLine")).toHaveText("expected to be AI-generated, of 8,400 words read and scored");
  await expect(page.locator("#heroLegend li")).toHaveText(["Human60%", "Lightly edited18%", "Heavily edited9%", "AI-generated14%"]);
  await expect(page.locator("#heroCompare")).toHaveText("Your average over the last 30 days: 14%.");
  // One day: no trend.
  await expect(page.locator("#trendCard")).toBeHidden();
  const rows = (id) => page.locator(`#${id} tbody tr`).evaluateAll((trs) => trs.map((tr) => [...tr.cells].slice(0, 3).map((c) => c.textContent)));
  expect(await rows("kindTable")).toEqual([["Feeds", "4,200", "22%"], ["Articles", "6,000", "10%"]]);
  expect(await rows("feedTable")).toEqual([["Feeds", "4,200", "22%"], ["Everything else", "6,000", "10%"]]);
  expect(await rows("siteTable")).toEqual([["news.example", "6,000", "10%"], ["social.example", "4,200", "22%"]]);
  await expect(page.locator("#coverageLine")).toHaveText("8,400 of the 10,200 words you read could be scored (82%).");
  await expect(page.locator("#coverageList li")).toHaveText(["Scored: 8,400 words", "Too short to score: 1,200 words", "Not in English: 500 words", "Engine unavailable: 100 words"]);
  const pagesRow = await page.locator("#pagesTable tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent)));
  expect(pagesRow).toHaveLength(1);
  expect(pagesRow[0].slice(1, 4)).toEqual(["A story", "5,400", "10%"]);
  await expect(page.locator("#pagesTable a")).toHaveAttribute("href", "https://news.example/story");
  // Seven days: a column a day, and a table that says the same.
  await page.click('#ranges [data-range="7"]');
  await expect(page.locator("#trendCard")).toBeVisible();
  await expect(page.locator("#trendChart svg[role=img] g.col")).toHaveCount(7);
  await expect(page.locator("#trendTable tbody tr")).toHaveCount(7);
  await expect(page.locator("#trendTable tbody tr").last().locator("td").nth(1)).toHaveText("10,200");
});

test("export: a file at a coarser level than recorded holds daily totals and no site or page", async ({ page, extension, storage }) => {
  await storage.set({ statsLevel: "pages" });
  await statsPage(page, extension, statsRecords());
  await page.click("#export");
  await expect(page.locator("#exportDialog")).toBeVisible();
  await expect(page.locator("#exportLevel option")).toHaveText(["Daily totals", "Daily totals and sites", "Every page"]);
  await page.selectOption("#exportLevel", "daily");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#exportSave")]);
  expect(download.suggestedFilename()).toBe(`anagram-stats-${localDate()}.json`);
  const text = await readFile(await download.path(), "utf8");
  const file = JSON.parse(text);
  expect(file).toMatchObject({ schema: "anagram-stats", version: 1, level: { recorded: "pages", exported: "daily" }, range: { from: localDate(), to: localDate() },
    words: { viewed: 10200, scored: 8400 }, coverage: { short: 1200, language: 500, unavailable: 100 }, model: [{ id: "fake-editlens" }] });
  expect(file.extension.version).toMatch(/^\d+\.\d+\.\d+/);
  expect(file.days).toHaveLength(1);
  expect(file.days[0]).toMatchObject({ level: "daily", expected: [5000, 1500, 724, 1176], units: [40, 10, 6, 9] });
  expect(file.sites).toBeUndefined();
  expect(file.pages).toBeUndefined();
  for (const leak of ["news.example", "social.example", "A story", "https://"]) expect(text).not.toContain(leak);
  await expect(page.locator("#exportDialog")).toBeHidden();
});

test("clear: every day recorded is deleted, after a confirmation", async ({ page, extension, storage }) => {
  await storage.set({ statsLevel: "daily" });
  await statsPage(page, extension, statsRecords());
  await expect(page.locator("#heroShare")).toHaveText("14%");
  await page.click("#clear");
  await expect(page.locator("#clearDialog")).toBeVisible();
  await page.click("#clearCancel");
  expect((await statsDb(extension)).days).toHaveLength(1);
  await page.click("#clear");
  await page.click("#clearConfirm");
  await expect(page.locator("#emptyCard")).toBeVisible();
  expect(await statsDb(extension)).toEqual({ days: [], sites: [], pages: [] });
});

test("Settings: the level, what it keeps, the warning for every page, and how long", async ({ page, extension, storage }) => {
  await page.goto(extension.url("options.html#statistics"), { waitUntil: "load" });
  await expect(page.locator("#statsLevel")).toHaveValue("off");
  await expect(page.locator("#statsLevelNote")).toHaveText("Nothing is recorded.");
  await expect(page.locator("#statsRetention")).toHaveValue("90");
  await page.selectOption("#statsLevel", "pages");
  await expect(page.locator("#statsPagesWarn")).toBeVisible();
  await page.selectOption("#statsRetention", "30");
  await expect.poll(() => storage.get(["statsLevel", "statsRetentionDays"])).toEqual({ statsLevel: "pages", statsRetentionDays: 30 });
  await page.selectOption("#statsLevel", "daily");
  await expect(page.locator("#statsPagesWarn")).toBeHidden();
  await expect(page.locator("#statsLevelNote")).toContainText("No sites, no pages.");
});

test("Settings: lowering the level asks whether to delete the sites and pages it no longer records, and keeps them unless told", async ({ page, extension, storage }) => {
  await storage.set({ statsLevel: "pages" });
  await seedStats(extension.worker(), statsRecords());
  await page.goto(extension.url("options.html#statistics"), { waitUntil: "load" });
  await expect(page.locator("#statsLevel")).toHaveValue("pages");
  const dialog = page.locator("#dropStatsDialog");
  const kept = async () => { const db = await statsDb(extension); return [db.days.length, db.sites.length, db.pages.length]; };
  // Every page → sites: only the pages would go. Keeping them is the default, and Escape keeps too.
  await page.selectOption("#statsLevel", "sites");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#dropStatsTitle")).toHaveText("Delete the pages already recorded?");
  await expect(page.locator("#dropStatsKeep")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect.poll(() => storage.get("statsLevel")).toEqual({ statsLevel: "sites" });
  expect(await kept()).toEqual([1, 2, 1]);
  // Sites → off: the sites and the pages kept before would go; deleted, the day's totals stay.
  await page.selectOption("#statsLevel", "off");
  await expect(page.locator("#dropStatsTitle")).toHaveText("Delete the sites and pages already recorded?");
  await page.click("#dropStatsConfirm");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#statsStatus")).toHaveText("Deleted. The daily totals stay.");
  expect(await kept()).toEqual([1, 0, 0]);
  // Raising it asks nothing, and lowering it with nothing finer kept asks nothing either.
  await page.selectOption("#statsLevel", "pages");
  await page.selectOption("#statsLevel", "daily");
  await expect.poll(() => storage.get("statsLevel")).toEqual({ statsLevel: "daily" });
  await expect(dialog).toBeHidden();
});

test("the toolbar menu says today's share while statistics are recorded, and nothing while they are off", async ({ page, pages, extension, storage }) => {
  pages.serve({ "/plain.html": "<!doctype html><title>plain</title><p>plain</p>" });
  await page.goto(pages.url("/plain.html"), { waitUntil: "load" });
  const off = await popupOver(page);
  await expect(off.locator("#status")).not.toHaveText("…");
  await expect(off.locator("#statsToday")).toBeHidden();
  await off.close();

  await storage.set({ statsLevel: "daily" });
  await seedStats(extension.worker(), statsRecords());
  const menu = await popupOver(page);
  await expect(menu.locator("#statsTodayText")).toHaveText("Today: 14% AI-generated, of 8,400 words read.");
  const [opened] = await Promise.all([page.context().waitForEvent("page"), menu.click("#openStats")]);
  await expect(opened).toHaveURL(extension.url("stats.html"));
});
