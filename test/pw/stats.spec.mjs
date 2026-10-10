// The reading log (lib/stats/), against the deterministic fake host: nothing is kept while it is
// off; a paragraph counts once it has been on screen, once however often it is scrolled back
// to; each preset keeps what it says and no more (no text unless asked, no address unless
// asked); a route change is a visit of its own, filed under its own address; the PDF reader's
// paragraphs count as a document; the statistics page shows what was kept, counts it another way
// where paragraphs were kept, replays a visit, exports at the layers chosen and clears; Settings
// chooses what to keep and offers to delete what a new choice would not; and the toolbar menu
// has today's line.
//
// The database is read from the extension's worker (the extension's own origin); its rows are
// seeded from it too where a test is about the page rather than the reading
// (test/stats-fixture.mjs).
//
//   npx playwright test stats --project chromium
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, settledChips, ABSENCE_MS, popupOver } from "./kit.mjs";
import { fakeScore } from "../fake-native.mjs";
import { TEST_PDF, pdfChips, readerRead } from "../pdf-fixture.mjs";
import { localDate, presetConfig, seedStats, statsRecords, statsVisit } from "../stats-fixture.mjs";

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
    const out = {};
    for (const store of ["visits", "units", "events", "texts", "totals", "tabs", "context"]) out[store] = await all(store);
    db.close();
    return out;
  });

const dayTotal = (db) => db?.totals.find((t) => t.scope === "day")?.tally;
/** The day's totals as soon as they hold `units` paragraphs (the page sends every few seconds). */
const dayWith = (extension, units) =>
  expect.poll(async () => {
    const t = dayTotal(await statsDb(extension));
    return t ? t.units.reduce((a, b) => a + b, 0) : 0;
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
const leave = async (page, pages) => {
  await page.waitForTimeout(1500);
  await page.goto(pages.url("/elsewhere.html"), { waitUntil: "load" });
  await page.waitForTimeout(ABSENCE_MS);
};

test("nothing is recorded while statistics are off, which is the default", async ({ page, pages, extension, storage }) => {
  expect((await storage.get("statsConfig")).statsConfig).toBeUndefined();
  await readTop(page, pages);
  await leave(page, pages);
  expect(await statsDb(extension), "no database at all").toBeNull();
});

test("daily totals: the paragraphs read, once each, as expected words per verdict, and nothing of the visit, the site or the page", async ({ page, pages, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("daily") });
  await readTop(page, pages);
  // The three on screen count; the two far below have not been read.
  await dayWith(extension, 3);
  const first = dayTotal(await statsDb(extension));
  expect(first.scored).toBe(270);
  expect(first.expected.reduce((a, b) => a + b, 0)).toBeCloseTo(270, 0);
  first.expected.forEach((w, i) => expect(w, `band ${i}`).toBeCloseTo(expectedOf(TOP)[i], 0));
  // Scrolled to, they count too; scrolled back past, nothing counts twice.
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await expect(settledChips(page)).toHaveCount(5);
  await dayWith(extension, 5);
  await page.evaluate(() => window.scrollTo(0, 0));
  await leave(page, pages);
  const db = await statsDb(extension);
  expect(dayTotal(db).scored).toBe(450);
  expect(db.totals.map((t) => `${t.scope}:${t.key}`).sort()).toEqual(["day:", "kind:article"]);
  expect(db.visits).toEqual([]);
  expect(db.units).toEqual([]);
  expect(db.events).toEqual([]);
  expect(JSON.stringify(db.totals), "no text, no address").not.toMatch(/Alpha|river|localhost|article\.html/);
});

test("a short paragraph read, then given a neighbour, counts its words once: short then, and the rest with the paragraph", async ({ page, pages, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("daily") });
  pages.serve({
    "/short.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>short</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui"><header style="height:160px">short</header><main><div id="box"><p>${para("Lonely", 20)}</p></div></main></body></html>`,
    "/elsewhere.html": "<!doctype html><title>elsewhere</title><p>nothing</p>",
  });
  await page.goto(pages.url("/short.html"), { waitUntil: "load" });
  await expect.poll(async () => dayTotal(await statsDb(extension))?.short ?? 0, { message: "the short paragraph read", timeout: 25_000 }).toBe(20);
  // The page gives it a neighbour: the two are one paragraph of 60 words now, scored.
  await page.evaluate((text) => { const p = document.createElement("p"); p.textContent = text; document.getElementById("box").append(p); }, para("Joined", 40));
  await expect(settledChips(page)).toHaveCount(1);
  await dayWith(extension, 1);
  await leave(page, pages);
  const day = dayTotal(await statsDb(extension));
  expect(day.short, "its 20 words, read while short").toBe(20);
  expect(day.scored, "the paragraph's other 40, not all 60 again").toBe(40);
});

test("what the reader left out is counted by why, in words, and none of it kept", async ({ page, pages, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("full") });
  const links = Array.from({ length: 12 }, (_, i) => `<li><a href="/story/${i}">Story ${i} about the river towns and their quiet letters</a></li>`).join("");
  pages.serve({
    "/left.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>left out</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<nav><a href="/">Home</a> <a href="/news">News</a> <a href="/sport">Sport</a> <a href="/about">About the paper and its people</a></nav>
<main><header style="height:120px"></header><p>${para("Alpha")}</p><ul>${links}</ul><pre><code>const river = boats.map((b) => b.town);\nfor (const letter of river) send(letter);</code></pre><p>${para("Bravo")}</p></main></body></html>`,
    "/elsewhere.html": "<!doctype html><title>elsewhere</title><p>nothing</p>",
  });
  await page.goto(pages.url("/left.html"), { waitUntil: "load" });
  await expect(settledChips(page)).toHaveCount(2);
  await leave(page, pages);
  const db = await statsDb(extension);
  const visit = db.visits.find((v) => v.url?.includes("left.html"));
  expect(visit.leftOut.chrome, "the navigation").toBeGreaterThan(0);
  expect(visit.leftOut.links, "the list of links").toBeGreaterThanOrEqual(12 * 9);
  expect(visit.leftOut.code, "the code").toBeGreaterThan(0);
  expect(JSON.stringify(db), "words only, never the text").not.toMatch(/Story 3|boats\.map/);
});

test("by site: each host's share of the day, and no page", async ({ page, pages, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("sites", { layers: { place: "host" } }) });
  await readTop(page, pages);
  await dayWith(extension, 3);
  // The same server under its address: another site.
  await page.goto(pages.url("/article.html").replace("localhost", "127.0.0.1"), { waitUntil: "load" });
  await expect.poll(() => settledChips(page).count()).toBeGreaterThanOrEqual(3);
  await expect.poll(async () => (await statsDb(extension)).totals.filter((t) => t.scope === "site").map((t) => [t.key, t.tally.scored]).sort(), { timeout: 25_000 })
    .toEqual([["127.0.0.1", 270], ["localhost", 270]]);
  expect((await statsDb(extension)).totals.some((t) => t.scope === "page")).toBe(false);
});

test("every page: its address without the query, its title, when it was first read and how long it was shown", async ({ page, pages, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("pages") });
  pages.serve({ "/article.html": article("A test article") });
  await page.goto(pages.url("/article.html?utm_source=x#top"), { waitUntil: "load" });
  await expect.poll(() => settledChips(page).count()).toBeGreaterThanOrEqual(3);
  await dayWith(extension, 3);
  await page.waitForTimeout(1500);
  await page.goto("about:blank");
  const pageTotal = async () => (await statsDb(extension)).totals.find((t) => t.scope === "page");
  await expect.poll(async () => (await pageTotal())?.dwell ?? 0, { message: "the time shown", timeout: 25_000 }).toBeGreaterThan(0);
  const record = await pageTotal();
  expect(record).toMatchObject({ key: pages.url("/article.html"), title: "A test article", kind: "article" });
  expect(record.start).toMatch(/^\d\d:\d\d$/);
  expect(record.tally.scored).toBe(270);
  expect((await statsDb(extension)).visits).toEqual([]);
});

test("every paragraph: visits with no address, paragraphs with a salted hash, their verdict and their time on screen, and no text", async ({ page, pages, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("paragraphs") });
  await readTop(page, pages);
  await dayWith(extension, 3);
  await leave(page, pages);
  const db = await statsDb(extension);
  const visit = db.visits.find((v) => v.tally.scored === 270);
  expect(visit).toMatchObject({ kind: "article", surface: "web", frame: "top", arrival: "typed" });
  expect(visit.url).toBeUndefined();
  expect(visit.title).toBeUndefined();
  const units = db.units.filter((u) => u.visit === visit.id);
  expect(units.length).toBeGreaterThanOrEqual(3);
  const read = units.filter((u) => u.expo?.readAt !== undefined);
  expect(read).toHaveLength(3);
  for (const u of read) {
    expect(u.hash).toMatch(/^[0-9a-f]{16}$/);
    expect(u.verdict.p).toHaveLength(4);
    expect(u.expo.band[0]).toBeGreaterThanOrEqual(1000);
    expect(u.len.words).toBe(90);
  }
  expect(db.texts).toEqual([]);
  expect(JSON.stringify(db), "no text, no address").not.toMatch(/Alpha|river|article\.html/);
});

test("full trace with text: every step on screen, the scroll, input and the text itself; a route change is a visit filed under its own address", async ({ page, pages, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("fullText") });
  await readTop(page, pages);
  await dayWith(extension, 3);
  await page.evaluate(() => window.scrollBy(0, 300));
  await page.mouse.click(10, 10);
  // A route change within the page: what was read before it stays the first address's.
  await page.evaluate(() => history.pushState({}, "", "/article.html/second"));
  // Its paragraphs, still on screen, are read again in the new visit once it has been shown a while.
  await page.waitForTimeout(3500);
  await page.goto(pages.url("/elsewhere.html"), { waitUntil: "load" });
  await page.waitForTimeout(ABSENCE_MS);
  const db = await statsDb(extension);
  const first = db.visits.find((v) => v.url === pages.url("/article.html"));
  expect(first, JSON.stringify(db.visits.map((v) => v.url))).toBeTruthy();
  expect(first.tally.scored).toBe(270);
  expect(first.title).toBe("A test article");
  const second = db.visits.find((v) => v.url === pages.url("/article.html/second"));
  expect(second?.arrival, JSON.stringify(db.visits.map((v) => [v.url, v.arrival, v.ended, v.shown, v.tally.scored]))).toBe("route");
  const streams = db.events.filter((e) => e.visit === first.id).map((e) => Object.keys(e.streams)).flat();
  expect(streams).toEqual(expect.arrayContaining(["steps", "intervals", "scroll", "input"]));
  expect(db.texts.map((t) => t.text)).toEqual(expect.arrayContaining(TOP));
  expect(db.units.find((u) => u.visit === first.id && u.n === 0).head).toBe(TOP[0].split(" ").slice(0, 12).join(" "));
  expect(db.context.length).toBeGreaterThan(0);
});

test("the PDF reader's paragraphs count as a document, and a file from this computer as no site", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("sites", { layers: { place: "host" } }) });
  await page.goto(extension.url("reader.html"), { waitUntil: "load" });
  await page.setInputFiles("#file", { name: "dropped.pdf", mimeType: "application/pdf", buffer: TEST_PDF });
  await readerRead(page);
  expect(await pdfChips(page)).toBeGreaterThan(0);
  await expect.poll(async () => (await statsDb(extension))?.totals.find((t) => t.scope === "kind" && t.key === "document")?.tally.scored ?? 0, { timeout: 25_000 }).toBeGreaterThan(0);
  const db = await statsDb(extension);
  expect(db.totals.filter((t) => t.scope === "kind").map((t) => t.key)).toEqual(["document"]);
  expect(db.totals.filter((t) => t.scope === "site").map((t) => t.key)).toEqual([""]);
});

// ---- the statistics page --------------------------------------------------------------------

/** The statistics page, with `records` put in the database first. */
async function statsPage(page, extension, records) {
  if (records) await seedStats(extension.worker(), records);
  await page.goto(extension.url("stats.html"), { waitUntil: "load" });
  return page;
}

test("the statistics page, while off, says what each choice keeps and turns one on", async ({ page, extension, storage }) => {
  await statsPage(page, extension);
  await expect(page.locator("#offCard")).toBeVisible();
  await expect(page.locator("#content")).toBeHidden();
  await expect(page.locator("#presetList li")).toHaveCount(7);
  await expect(page.locator("#turnOnWarn p")).toHaveCount(0);
  await page.selectOption("#turnOnPreset", "fullText");
  await expect(page.locator("#turnOnWarn p")).toContainText(["This keeps the text of every paragraph you read."]);
  await page.selectOption("#turnOnPreset", "pages");
  await page.click("#turnOn");
  await expect.poll(async () => (await storage.get("statsConfig")).statsConfig?.layers?.rows).toBe("page");
  await expect(page.locator("#offCard")).toBeHidden();
  await expect(page.locator("#levelLine")).toHaveText("Recording: Every page, paragraphs and visits kept for 90 days.");
});

test("the statistics page shows what was kept: the share, the four verdicts, kinds, feeds, sites, coverage and pages", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("pages") });
  await statsPage(page, extension, statsRecords());
  await expect(page.locator("#heroShare")).toHaveText("14%");
  await expect(page.locator("#heroLine")).toHaveText("expected to be AI-generated, of 8,400 words read and scored");
  await expect(page.locator("#heroLegend li")).toHaveText(["Human60%", "Lightly edited18%", "Heavily edited9%", "AI-generated14%"]);
  await expect(page.locator("#heroCompare")).toHaveText("Over the last 30 days, today included: 14%.");
  await expect(page.locator("#trendCard")).toBeHidden();
  const rows = (id) => page.locator(`#${id} tbody tr`).evaluateAll((trs) => trs.map((tr) => [...tr.cells].slice(0, 3).map((c) => c.textContent)));
  expect(await rows("kindTable")).toEqual([["Feeds", "4,200", "22%"], ["Articles", "6,000", "10%"]]);
  expect(await rows("feedTable")).toEqual([["Feeds", "4,200", "22%"], ["Everything else", "6,000", "10%"]]);
  expect(await rows("siteTable")).toEqual([["news.example", "6,000", "10%"], ["social.example", "4,200", "22%"]]);
  await expect(page.locator("#coverageLine")).toHaveText("8,400 of the 10,200 words you read could be scored (82%).");
  await expect(page.locator("#coverageList li")).toHaveText(["Scored: 8,400 words", "Too short to score: 1,200 words", "Not in English: 500 words", "Engine unavailable: 100 words", "Removed before its verdict: 0 words"]);
  const pagesRow = await page.locator("#pagesTable tbody tr").evaluateAll((trs) => trs.map((tr) => [...tr.cells].map((c) => c.textContent)));
  expect(pagesRow).toHaveLength(1);
  expect(pagesRow[0].slice(1, 4)).toEqual(["A story", "5,400", "10%"]);
  await expect(page.locator("#pagesTable a")).toHaveAttribute("href", "https://news.example/story");
  await expect(page.locator("#lensNote")).toContainText("As Anagram counts");
  // Seven days: a column a day, and a table that says the same.
  await page.click('#ranges [data-range="7"]');
  await expect(page.locator("#trendCard")).toBeVisible();
  await expect(page.locator("#trendChart svg[role=img] g.col")).toHaveCount(7);
  await expect(page.locator("#trendTable tbody tr")).toHaveCount(7);
  await expect(page.locator("#trendTable tbody tr").last().locator("td").nth(1)).toHaveText("10,200");
});

test("how it counts: the paragraphs kept are counted again by another rule, and the totals say they cannot be", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("full") });
  await statsPage(page, extension, statsVisit());
  await expect(page.locator("#heroShare")).toHaveText("45%");
  await page.click("#lens summary");
  // Two seconds on screen to count: the 1.5 s human paragraph is no longer read.
  await page.selectOption("#lensRead", "2000");
  await expect(page.locator("#lensNote")).toHaveText("Counted again from the paragraphs Anagram kept.");
  await expect(page.locator("#heroShare")).toHaveText("90%");
  await page.selectOption("#lensRead", "500");
  await expect(page.locator("#heroShare")).toHaveText("60%");
  await page.click("#lensReset");
  await expect(page.locator("#heroShare")).toHaveText("45%");
  // A replay of the visit: a bar for each spell on screen.
  await page.click("#visitsTable button.linkish");
  await expect(page.locator("#replay")).toBeVisible();
  await expect(page.locator("#replayChart svg rect.on")).toHaveCount(3);
  await expect(page.locator("#replayChart svg path.scroll")).toHaveCount(1);
});

test("how it counts: totals alone cannot be counted another way, and say so", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("daily") });
  await statsPage(page, extension, statsRecords());
  await page.click("#lens summary");
  await page.selectOption("#lensRead", "2000");
  await expect(page.locator("#lensNote")).toHaveText("These are the totals Anagram kept: counting another way needs paragraphs kept (Settings, Statistics).");
  await expect(page.locator("#heroShare")).toHaveText("14%");
});

test("export: never finer than what was kept, at the layers chosen, as JSON or a zip of CSV", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("full") });
  await statsPage(page, extension, { ...statsRecords(), ...statsVisit(), totals: [...statsRecords().totals] });
  await page.click("#export");
  await expect(page.locator("#exportDialog")).toBeVisible();
  await expect(page.locator("#exportPreview")).toContainText("rows");
  await page.selectOption("#exportPreset", "daily");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#exportSave")]);
  expect(download.suggestedFilename()).toBe(`anagram-stats-${localDate()}.json`);
  const text = await readFile(await download.path(), "utf8");
  const file = JSON.parse(text);
  expect(file.manifest).toMatchObject({ schema: "anagram-stats", version: 1, link: "file", range: { from: localDate(), to: localDate() } });
  expect(Object.keys(file.tables).sort()).toEqual(["context", "totals"]);
  expect(file.tables.totals.rows.map((r) => r[file.tables.totals.columns.indexOf("scope")]).sort()).toEqual(["day", "kind", "kind"]);
  for (const leak of ["news.example", "social.example", "A story", "https://"]) expect(text).not.toContain(leak);
  // Full: visits, paragraphs and events, in a zip a real unzip opens.
  await page.click("#export");
  await page.selectOption("#exportPreset", "full");
  await page.check('#exportForm input[name=format][value=csv]');
  const [zipped] = await Promise.all([page.waitForEvent("download"), page.click("#exportSave")]);
  expect(zipped.suggestedFilename()).toBe(`anagram-stats-${localDate()}.zip`);
  const dir = mkdtempSync(join(tmpdir(), "anagram-export-"));
  try {
    writeFileSync(join(dir, "f.zip"), readFileSync(await zipped.path()));
    execFileSync("unzip", ["-q", join(dir, "f.zip"), "-d", join(dir, "x")]);
    const list = execFileSync("ls", [join(dir, "x")], { encoding: "utf8" }).trim().split("\n").sort();
    expect(list).toEqual(expect.arrayContaining(["manifest.json", "visits.csv", "units.csv", "intervals.csv", "scroll.csv", "totals.csv"]));
    expect(readFileSync(join(dir, "x", "visits.csv"), "utf8")).toContain("https://news.example/story");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clear: everything kept is deleted, after a confirmation", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("daily"), statsSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
  await statsPage(page, extension, statsRecords());
  await expect(page.locator("#heroShare")).toHaveText("14%");
  await page.click("#clear");
  await expect(page.locator("#clearDialog")).toBeVisible();
  await page.click("#clearCancel");
  expect((await statsDb(extension)).totals.length).toBeGreaterThan(0);
  await page.click("#clear");
  await page.click("#clearConfirm");
  await expect(page.locator("#emptyCard")).toBeVisible();
  expect((await statsDb(extension)).totals).toEqual([]);
  expect((await storage.get("statsSecret")).statsSecret ?? null, "a new key for what comes next").toBeNull();
});

test("Settings: a choice, what it keeps, its warnings, field by field, and how long", async ({ page, extension, storage }) => {
  await page.goto(extension.url("options.html#statistics"), { waitUntil: "load" });
  await expect(page.locator("#statsPreset")).toHaveValue("off");
  await expect(page.locator("#statsPresetNote")).toHaveText("Nothing is kept.");
  await expect(page.locator("#statsCustomize")).toBeHidden();
  await page.selectOption("#statsPreset", "pages");
  await expect(page.locator("#statsWarnings p")).toHaveText(["This keeps a list of every page you read, with its address and title. It stays on this computer, but anyone who uses this browser profile could see it."]);
  await expect.poll(async () => (await storage.get("statsConfig")).statsConfig?.layers?.rows).toBe("page");
  await page.click("#statsCustomize");
  await expect(page.locator("#statsDims table.dims tbody tr")).toHaveCount(21);
  await page.selectOption("#stats-dim-title", "none");
  await expect(page.locator("#statsPreset")).toHaveValue("custom");
  await expect.poll(async () => (await storage.get("statsConfig")).statsConfig?.layers?.title).toBe("none");
  await page.check("#stats-dim-place-hash");
  await expect.poll(async () => (await storage.get("statsConfig")).statsConfig?.hashed).toEqual(["place"]);
  await page.selectOption("#statsDetailDays", "30");
  await expect.poll(async () => (await storage.get("statsConfig")).statsConfig?.retention?.detail).toBe(30);
  await expect(page.locator("#statsSize")).toContainText("records");
});

test("Settings: keeping less asks whether to delete what the new choice would not keep, and keeps it unless told", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("full") });
  await seedStats(extension.worker(), statsVisit());
  await page.goto(extension.url("options.html#statistics"), { waitUntil: "load" });
  await expect(page.locator("#statsPreset")).toHaveValue("full");
  const dialog = page.locator("#dropStatsDialog");
  const kept = async () => { const db = await statsDb(extension); return [db.visits.length, db.units.length, db.events.length, db.totals.length]; };
  // Full trace → every paragraph: the events would go. Keeping them is the default, and Escape keeps too.
  await page.selectOption("#statsPreset", "paragraphs");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#dropStatsKeep")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await kept()).toEqual([1, 3, 1, 2]);
  // → daily totals: the visits and paragraphs would go too; deleted, the totals stay.
  await page.selectOption("#statsPreset", "daily");
  await page.click("#dropStatsConfirm");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#statsStatus")).toHaveText("Deleted. The daily totals stay.");
  expect(await kept()).toEqual([0, 0, 0, 2]);
  // Keeping more asks nothing.
  await page.selectOption("#statsPreset", "pages");
  await expect(dialog).toBeHidden();
});

test("the toolbar menu says today's share while statistics are recorded, and nothing while they are off", async ({ page, pages, extension, storage }) => {
  pages.serve({ "/plain.html": "<!doctype html><title>plain</title><p>plain</p>" });
  await page.goto(pages.url("/plain.html"), { waitUntil: "load" });
  const off = await popupOver(page);
  await expect(off.locator("#status")).not.toHaveText("…");
  await expect(off.locator("#statsToday")).toBeHidden();
  await off.close();

  await storage.set({ statsConfig: await presetConfig("daily") });
  await seedStats(extension.worker(), statsRecords());
  const menu = await popupOver(page);
  await expect(menu.locator("#statsTodayText")).toHaveText("Today: 14% AI-generated, of 8,400 words scored.");
  const [opened] = await Promise.all([page.context().waitForEvent("page"), menu.click("#openStats")]);
  await expect(opened).toHaveURL(extension.url("stats.html"));
});
