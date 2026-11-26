// The reading log (lib/stats/), against the deterministic fake host: nothing is kept while it is
// off; a paragraph counts once it has been on screen, once however often it is scrolled back
// to; each preset keeps what it says and no more (no text unless asked, no address unless
// asked); a route change is a visit of its own, filed under its own address; the PDF reader's
// paragraphs count as a document; the statistics page shows what was kept, counts it another way
// where paragraphs were kept, replays a visit, exports at the layers chosen and clears; Settings
// chooses what to keep (a preset menu) and offers to delete what a new choice would not; and the toolbar menu
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
import { daysAgo, localDate, presetConfig, seedStats, statsDb, statsRecords, statsVisit, statsWeek, tally } from "../stats-fixture.mjs";

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

test.describe("with Chromium's private-window access enabled", () => {
  test.use({ launch: { incognitoAccess: true } });

  test("a private article gets a verdict without entering the full-text reading log", async ({ page, pages, extension, storage }) => {
    await storage.set({ statsConfig: await presetConfig("fullText") });
    await readTop(page, pages);
    await dayWith(extension, 3);
    await page.goto("about:blank");
    const before = await statsDb(extension);
    const label = "Private window test article";
    const path = "/private-reading.html";
    pages.serve({ [path]: article(label).replaceAll("Alpha", "Private-reading-marker") });
    const worker = extension.worker();
    const tab = await worker.evaluate(async (url) => {
      const win = await chrome.windows.create({ incognito: true, focused: true, url });
      return (await chrome.tabs.query({ windowId: win.id }))[0];
    }, pages.url(path));
    expect(tab.incognito).toBe(true);
    try {
      await expect.poll(() => worker.evaluate(async (id) => {
        const [frame] = await chrome.scripting.executeScript({ target: { tabId: id }, func: () =>
          [...document.querySelectorAll('[data-anagram="host"]')].filter((h) => h.shadowRoot?.querySelector(".pill.scored")).length });
        return frame.result;
      }, tab.id).catch(() => 0)).toBeGreaterThanOrEqual(3);
      await page.waitForTimeout(1500); // Remain visible past the one-second reading threshold.
    } finally {
      await worker.evaluate((id) => chrome.windows.remove(id), tab.windowId);
    }
    await page.waitForTimeout(ABSENCE_MS);
    const after = await statsDb(extension);
    expect(dayTotal(after)).toEqual(dayTotal(before));
    for (const store of ["units", "visits", "texts"]) expect(after[store]).toHaveLength(before[store].length);
    const saved = JSON.stringify(after);
    for (const value of [path, label, "Private-reading-marker"]) expect(saved).not.toContain(value);
  });
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
async function statsPage(page, extension, records, hash = "#today") {
  if (records) await seedStats(extension.worker(), records);
  await page.goto(extension.url("stats.html") + hash, { waitUntil: "load" });
  return page;
}

test("the statistics page, while off, offers the presets in one menu, says what the chosen one keeps, and turns it on", async ({ page, extension, storage }) => {
  await statsPage(page, extension);
  await expect(page.locator("#offCard")).toBeVisible();
  await expect(page.locator("#content")).toBeHidden();
  await expect(page.locator("#turnOnPreset option")).toHaveCount(7);
  await expect(page.locator("#turnOnHint")).toHaveText("Word counts and verdicts by day.");
  await expect(page.locator("#turnOnWarn p")).toHaveCount(0);
  await page.selectOption("#turnOnPreset", "fullText");
  await expect(page.locator("#turnOnHint")).toHaveText("Everything, including the text you read.");
  await expect(page.locator("#turnOnWarn p")).toContainText(["Apps with access to this browser profile can read the saved paragraphs."]);
  await page.selectOption("#turnOnPreset", "pages");
  await page.click("#turnOn");
  await expect.poll(async () => (await storage.get("statsConfig")).statsConfig?.layers?.rows).toBe("page");
  await expect(page.locator("#offCard")).toBeHidden();
  await expect(page.locator("#levelLine")).toHaveText("Recording: Every page.");
});

test("the statistics page shows what was kept: the share against before, the words, the site with most, coverage, kinds, sites and pages", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("pages") });
  await statsPage(page, extension, statsRecords());
  await expect(page.locator("#heroShare")).toHaveText("14%");
  await expect(page.locator("#heroLine")).toHaveText("Estimated AI-generated share");
  await expect(page.locator("#heroLegend li")).toHaveText(["Human60%", "Lightly edited18%", "Heavily edited9%", "AI-generated14%"]);
  await expect(page.locator("#siteCard")).toBeVisible();
  await expect(page.locator("#pagesCard")).toBeHidden();
  await page.click("#pagesTab");
  await expect(page.locator("#pagesCard")).toBeVisible();
  await page.click("#siteTab");
  await expect(page.locator("#heroCompare")).toHaveText("Last 30 days: 14%");
  await expect(page.locator("#scoredFigure")).toHaveText("8,400");
  await expect(page.locator("#scoredLine")).toHaveText("1 page · 2 sites");
  // The site with the largest share, of those with words enough to say.
  await expect(page.locator("#topFigure")).toHaveText("social.example");
  await expect(page.locator("#topLine")).toHaveText("22% of 3,000 words scored");
  await expect(page.locator("#coverageLine")).toBeHidden();
  await expect(page.locator("#coverageLine")).toHaveText("Scored 8,400 of 10,200 words (82%).");
  // What held no words is not listed.
  await expect(page.locator("#coverageList")).toBeHidden();
  await page.getByText("Scoring details", { exact: true }).click();
  await expect(page.locator("#coverageList")).toBeVisible();
  await expect(page.locator("#coverageList li")).toHaveText(["Too short to score: 1,200 words", "Not in English: 500 words", "Engine unavailable: 100 words"]);
  await expect(page.locator("#trendCard")).toBeHidden();
  const rows = (id) => page.locator(`#${id} tbody tr`).evaluateAll((trs) => trs.map((tr) => [...tr.cells].slice(0, 3).map((c) => c.textContent)));
  expect(await rows("kindTable")).toEqual([["Feeds", "4,200", "22%"], ["Articles", "6,000", "10%"]]);
  expect(await rows("siteTable")).toEqual([["news.example", "6,000", "10%"], ["social.example", "4,200", "22%"]]);
  await expect(page.locator("#pagesTable tbody tr")).toHaveCount(1);
  await expect(page.locator("#pagesTable a")).toHaveText("A story");
  await expect(page.locator("#pagesTable .page-host")).toHaveText("news.example");
  await expect(page.locator("#pagesTable .cell-value")).toHaveText(["5,400", "10%", "2 min"]);
  await expect(page.locator("#pagesTable a")).toHaveAttribute("href", "https://news.example/story");
  await expect(page.locator("#lensNote")).toContainText("once per visit");

  // A site is a filter: the figures are that site's alone, By site still lists both, until Show all.
  await expect(page.locator("#filter")).toBeHidden();
  await page.locator("#siteTable tbody tr", { hasText: "news.example" }).click();
  await expect(page.locator("#filterText")).toHaveText("Site: news.example");
  await expect(page.locator("#heroShare")).toHaveText("10%");
  await expect(page.locator("#scoredFigure")).toHaveText("5,400");
  await expect(page.locator("#scoredLine")).toHaveText("1 page");
  // One kind of page alone is not the most of anything.
  await expect(page.locator("#topDetail")).toBeHidden();
  await expect(page.locator("#siteTable tbody tr")).toHaveCount(2);
  await expect(page.locator('#siteTable tr[aria-current="true"]')).toContainText("news.example");
  expect(await rows("kindTable")).toEqual([["Articles", "5,400", "10%"]]);
  await page.locator("#siteTable button", { hasText: "social.example" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#filterText")).toHaveText("Site: social.example");
  await expect(page.locator("#heroShare")).toHaveText("22%");
  await page.click("#filterClear");
  await expect(page.locator("#filter")).toBeHidden();
  await expect(page.locator("#heroShare")).toHaveText("14%");

  // Seven days: a column a day, and a table that says the same; against the seven before, none.
  await page.click('#ranges [data-range="7"]');
  await expect(page.locator("#trendCard")).toBeVisible();
  await expect(page.locator("#trendChart svg[role=img] g.col")).toHaveCount(7);
  await expect(page.locator("#trendTable tbody tr")).toHaveCount(7);
  await expect(page.locator("#trendTable tbody tr").last().locator("td").nth(1)).toHaveText("10,200");
  await expect(page.locator("#heroCompare")).toHaveText("");
  // A day pointed at says its numbers; clicked, the page is that day's.
  const today = page.locator("#trendChart g.col").last();
  await today.locator("rect.hit").hover();
  await expect(page.locator("#trendTip")).toBeVisible();
  await expect(page.locator("#trendTip")).toContainText("8,400 words scored, 14% AI-generated");
  await today.locator("rect.hit").click();
  await expect(page.locator("#trendCard")).toBeHidden();
  await expect(page.locator("#trendTip")).toBeHidden();
  await expect(page.locator('#ranges [aria-pressed="true"]')).toHaveCount(0);
  await expect(page.locator("#heroShare")).toHaveText("14%");
  await page.click("#more summary");
  await expect(page.locator("#rangeFrom")).toHaveValue(localDate());
  await expect(page.locator("#rangeTo")).toHaveValue(localDate());
  await page.keyboard.press("Escape");
  await page.click("#returnRange");
  await expect(page.locator('#ranges [data-range="7"]')).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#returnRange")).toBeHidden();
  // A scrollbar or a change to the column can resize the chart without resizing the window.
  const chart = page.locator("#trendChart");
  await chart.evaluate(node => { node.style.maxWidth = "360px"; });
  await expect(chart.locator("svg")).toHaveAttribute("width", "360");
  await chart.evaluate(node => { node.style.removeProperty("max-width"); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.click('#ranges [data-range="30"]');
  await expect(page.locator("#trendChart g.col")).toHaveCount(30);
  const labels = await page.locator('#trendChart text[text-anchor="middle"]').evaluateAll((nodes) =>
    nodes.map((n) => ({ left: n.getBoundingClientRect().left, right: n.getBoundingClientRect().right, date: n.textContent })).sort((a, b) => a.left - b.left));
  expect(labels.length).toBeGreaterThan(2);
  expect(labels.at(-1).date).toEqual(new Intl.DateTimeFormat("en", { month: "numeric", day: "numeric" }).format(new Date()));
  for (let i = 1; i < labels.length; i++) expect(labels[i].left - labels[i - 1].right).toBeGreaterThan(1);
  await page.click("#trendCard details summary");
  const lastDay = page.locator("#trendTable button").last();
  await expect(lastDay).toBeVisible();
  await lastDay.focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#trendCard")).toBeHidden();
});

test("the weekly report switches between comparable shares and daily volume", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("pages") });
  await statsPage(page, extension, statsWeek(), "");
  await expect(page.locator('#ranges [aria-pressed="true"]')).toHaveText("7 days");
  const heights = () => page.locator("#trendChart g.col").evaluateAll(cols =>
    cols.map(col => [...col.querySelectorAll("rect.seg")].reduce((total, rect) => total + rect.height.baseVal.value, 0)));
  const volume = await heights();
  expect(new Set(volume.filter(n => n > 0)).size).toBeGreaterThan(1);
  await page.click("#trendShare");
  await expect(page.locator("#trendShare")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#trendChart svg")).toHaveAttribute("aria-label", /Daily verdict shares/);
  const shares = await heights();
  expect(shares.filter(n => n === 0).length).toBeGreaterThan(0);
  for (const [i, height] of shares.entries()) {
    if (volume[i]) expect(height).toBeCloseTo(Math.max(...shares), 3);
    else expect(height).toBe(0);
  }
  await page.click("#trendVolume");
  expect(await heights()).toEqual(volume);
  await page.locator("#siteTab").focus();
  await page.keyboard.press("End");
  await expect(page.locator("#pagesTab")).toBeFocused();
  await expect(page.locator("#pagesCard")).toBeVisible();
  await expect(page.locator("#visitsTab")).toBeHidden();
  await page.keyboard.press("Home");
  await expect(page.locator("#siteTab")).toBeFocused();
  await page.click("#more summary");
  await page.locator("#rangeFrom").fill(daysAgo(4));
  await page.locator("#rangeTo").fill(daysAgo(1));
  await expect(page.locator('#ranges [data-range="7"]')).toHaveAttribute("aria-pressed", "true");
  await page.click("#rangeForm button");
  await expect(page.locator("#trendChart g.col")).toHaveCount(4);
  await page.setViewportSize({ width: 320, height: 680 });
  await page.click("#pagesTab");
  await expect(page.locator("#pagesTable .mobile-label").first()).toBeVisible();
  expect(await page.locator("#pagesTable").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test("how it counts: the paragraphs kept are counted again by another rule, and the totals say they cannot be", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("full") });
  await statsPage(page, extension, statsVisit());
  await expect(page.locator("#heroShare")).toHaveText("45%");
  await page.click("#lens summary");
  // Two seconds on screen to count: the 1.5 s human paragraph is no longer read.
  await page.selectOption("#lensRead", "2000");
  await expect(page.locator("#lensNote")).toHaveText("Calculated from recorded paragraphs.");
  await expect(page.locator("#heroShare")).toHaveText("90%");
  await page.selectOption("#lensRead", "500");
  await expect(page.locator("#heroShare")).toHaveText("60%");
  await page.click("#lensReset");
  await expect(page.locator("#heroShare")).toHaveText("45%");
  // A replay of the visit: a bar for each spell on screen.
  await page.click("#visitsTab");
  await page.click("#visitsTable button.linkish");
  await expect(page.locator("#replay")).toBeVisible();
  await expect(page.locator("#visitFacts")).toContainText("Passages on screen");
  await expect(page.locator("#replayChart svg")).toHaveCount(0);
  await page.locator("#visitTimeline summary").click();
  await expect(page.locator("#replayChart svg rect.on")).toHaveCount(3);
  await expect(page.locator("#replayChart svg path.scroll")).toHaveCount(1);
});

test("changing sites closes a replay from the previous site while keeping other visits visible", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("full") });
  const records = statsVisit();
  records.totals.push(...statsRecords().totals.filter((r) => r.scope === "site"));
  records.visits.push({ ...records.visits[0], id: "abcdef0123456789abcdef0123456789", site: "social.example", url: "https://social.example/post", title: "Other visit" });
  await statsPage(page, extension, records);
  await page.click("#visitsTab");
  await page.locator("#visitsTable tr", { hasText: "A story" }).getByRole("button").click();
  await expect(page.locator("#replay")).toBeVisible();
  await page.click("#siteTab");
  await page.locator("#siteTable tr.pick", { hasText: "social.example" }).click();
  await expect(page.locator("#visitsTable tbody tr")).toHaveCount(1);
  await page.click("#visitsTab");
  await expect(page.locator("#visitsCard")).toBeVisible();
  await expect(page.locator("#replay")).toBeHidden();
  await expect(page.locator("#replayTitle")).toHaveText("");
});

test("how it counts: totals alone cannot be counted another way, and say so", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("daily") });
  await statsPage(page, extension, statsRecords());
  await page.click("#lens summary");
  await page.selectOption("#lensRead", "2000");
  await expect(page.locator("#lensNote")).toHaveText("Showing recorded totals. This rule requires paragraph history.");
  await expect(page.locator("#heroShare")).toHaveText("14%");
});

test("period comparisons require both periods to support the selected counting rule", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("full") });
  const records = statsVisit(), previous = statsVisit(daysAgo(8));
  previous.visits[0].id = "earlier-visit";
  for (const unit of previous.units) {
    unit.visit = previous.visits[0].id;
    delete unit.expo;
  }
  records.visits.push(...previous.visits);
  records.units.push(...previous.units);
  records.totals.push(...previous.totals);
  await statsPage(page, extension, records);
  await page.click('#ranges [data-range="7"]');
  await expect(page.locator("#heroCompare")).not.toBeEmpty();
  await page.click("#lens summary");
  await page.selectOption("#lensRead", "2000");
  await expect(page.locator("#scoredFigure")).toHaveText("100");
  await expect(page.locator("#heroCompare")).toBeEmpty();
});

test("paragraph verdict shares use the classified paragraph count throughout the dashboard", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("pages") });
  const records = statsRecords();
  for (const total of records.totals) delete total.tally.argmax;
  await statsPage(page, extension, records);
  await page.click("#lens summary");
  await page.selectOption("#lensEstimator", "chip");
  await expect(page.locator("#heroLine")).toHaveText("AI-generated paragraphs");
  await expect(page.locator("#topLine")).toHaveText("15% of 33 paragraphs scored");
  await page.click('#ranges [data-range="7"]');
  await expect(page.locator("#trendChart svg")).toHaveAttribute("aria-label", /Paragraphs scored per day/);
  await page.locator("#trendChart rect.hit").last().hover();
  await expect(page.locator("#trendTip")).toContainText("65 paragraphs scored, 14% AI-generated");
  await page.selectOption("#lensEstimator", "argmax");
  await expect(page.locator("#heroShare")).toHaveText("Unavailable");
  await expect(page.locator("#heroLegend")).toBeHidden();
  await expect(page.locator("#trendUnavailable")).toBeVisible();
  await expect(page.locator("#trendChart")).toBeHidden();
});

test("export: never finer than what was kept, at the layers chosen, as JSON or a zip of CSV", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("full") });
  await statsPage(page, extension, { ...statsRecords(), ...statsVisit(), totals: [...statsRecords().totals] });
  // Export is available from the report header.
  await expect(page.locator("#export")).toBeVisible();
  await page.click("#export");
  await expect(page.locator("#exportDialog")).toBeVisible();
  await expect(page.locator("#more")).not.toHaveAttribute("open");
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

test("exporting saved text or excerpts requires choosing them for each download", async ({ page, extension, storage }) => {
  const records = statsVisit();
  const unit = records.units[0];
  unit.head = "Private excerpt";
  records.texts = [{ hash: unit.hash, text: "Private excerpt and its continuation.", first: unit.date, last: unit.date }];
  await storage.set({ statsConfig: await presetConfig("fullText") });
  await statsPage(page, extension, records);
  const downloadJSON = async () => {
    const [file] = await Promise.all([page.waitForEvent("download"), page.click("#exportSave")]);
    return readFile(await file.path(), "utf8");
  };
  await page.click("#export");
  await expect(page.locator("#exportPreset")).toHaveValue("full");
  expect(await downloadJSON()).not.toContain("Private excerpt");
  await page.click("#export");
  await page.selectOption("#exportPreset", "fullText");
  await page.check('#exportForm input[name="link"][value="stable"]');
  expect(await downloadJSON()).toContain("Private excerpt and its continuation.");
  await expect(page.locator("#exportPreview")).toBeEmpty();
  await page.click("#export");
  await expect(page.locator("#exportPreset")).toHaveValue("full");
  await expect(page.locator('#exportForm input[name="link"][value="file"]')).toBeChecked();
  expect(await downloadJSON()).not.toContain("Private excerpt");
});

test("export starts with the selected site and includes other sites only when explicitly selected", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("full") });
  await statsPage(page, extension, statsRecords());
  await page.locator("#siteTable tbody tr", { hasText: "news.example" }).click();
  await expect(page.locator("#filterText")).toContainText("news.example");
  for (const scope of ["site", "all"]) {
    await page.click("#export");
    await expect(page.locator("#exportScope")).toHaveValue("site");
    if (scope === "all") await page.selectOption("#exportScope", "all");
    const [download] = await Promise.all([page.waitForEvent("download"), page.click("#exportSave")]);
    const file = JSON.parse(await readFile(await download.path(), "utf8"));
    expect(file.manifest.siteScope).toBe(scope === "all" ? "all-sites" : "selected-site");
    const table = file.tables.totals;
    const keys = table.rows.filter((r) => r[table.columns.indexOf("scope")] === "site").map((r) => r[table.columns.indexOf("key")]);
    expect(keys.sort()).toEqual(scope === "all" ? ["news.example", "social.example"] : ["news.example"]);
  }
});

test("a selected hashed site exports its retained page totals, including older rows linked by a visit", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("full", { layers: { place: "url" }, hashed: ["place"] }) });
  const rows = statsRecords(), visit = statsVisit().visits[0];
  const site = "413a4effe5203f13", other = "433df0ba013cbab3", url = "ac65ee413094f6cb", path = "0c66ab5c1fed098d";
  const siteRow = rows.totals.find((t) => t.scope === "site"), pageRow = rows.totals.find((t) => t.scope === "page");
  rows.totals = [
    ...rows.totals.filter((t) => t.scope === "day"),
    ...[site, other].map((key) => ({ ...siteRow, key, placeLayer: "host", hashed: true })),
    { ...pageRow, key: url, title: "Older page", placeLayer: "url", hashed: true },
    { ...pageRow, key: "482b65b1e15054ad", title: "Retained page", placeLayer: "path", hashed: true, siteHash: site },
    { ...pageRow, key: "fce1a67e924199ba", title: "Other site", placeLayer: "path", hashed: true, siteHash: other },
  ];
  rows.visits = [{ ...visit, url, site, hashed: ["place"], places: { url, path, host: site, domain: site } }];
  rows.visits[0].date = daysAgo(1);
  await seedStats(extension.worker(), rows, 3);
  await statsPage(page, extension);
  await page.locator("#siteTable tr.pick", { hasText: site }).click();
  await expect(page.locator("#pagesTable tbody tr")).toHaveCount(2);
  await page.click("#export");
  await page.selectOption("#exportPreset", "pages");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#exportSave")]);
  const file = JSON.parse(await readFile(await download.path(), "utf8"));
  const totals = file.tables.totals;
  const pages = totals.rows.filter((r) => r[totals.columns.indexOf("scope")] === "page");
  expect(pages.map((r) => r[totals.columns.indexOf("title")]).sort()).toEqual(["Older page", "Retained page"]);
  expect(file.tables.visits).toBeUndefined();
  expect(file.tables.units).toBeUndefined();
  expect(JSON.stringify(file)).not.toContain("Other site");
  expect(JSON.stringify(file)).not.toContain(site);
});

test("upgrades overnight history and includes only today's reading in a one-day recount and download", async ({ page, extension, storage }) => {
  const today = localDate(), yesterday = daysAgo(1), records = statsVisit(yesterday);
  const v = records.visits[0];
  v.start = new Date(yesterday + "T23:58:00").getTime();
  v.end = v.start + 240_000;
  records.units[1].expo.readAt = 180_000;
  records.totals = [yesterday, today].map((date) => ({ ...records.totals[0], date, tally: { ...v.tally, scored: 100 } }));
  await storage.set({ statsConfig: await presetConfig("full") });
  await seedStats(extension.worker(), records, 2);
  await statsPage(page, extension);
  await page.click("#lens summary");
  await page.selectOption("#lensWeight", "paragraphs");
  await expect(page.locator("#scoredFigure")).toHaveText("1");
  await expect(page.locator("#heroShare")).toHaveText("0%");
  await expect(page.locator("#pagesTable tbody tr").first().locator("td").first()).toContainText("23:58");
  await page.click("#export");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#exportSave")]);
  const file = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(file.manifest.lensBasis).toBe("paragraphs");
  const lens = file.tables.lens;
  expect(lens.rows.map((r) => [r[lens.columns.indexOf("date")], r[lens.columns.indexOf("tally.scored")]])).toEqual([[today, 1]]);
  expect(file.tables.units).toBeUndefined();
});

test("Settings keeps the permitted hashed page when deleting finer history from IndexedDB", async ({ page, extension, storage }) => {
  const records = statsVisit(), url = "c8ba3570dd2aa601", path = "ca890e0f974a0063", host = "c170c6d721219c60";
  Object.assign(records.visits[0], { url, site: host, places: { url, path, host }, hashed: ["place"] });
  records.totals.push({ ...records.totals[0], scope: "page", key: url, hashed: true, placeLayer: "url", title: "Older page" });
  await storage.set({ statsConfig: await presetConfig("full", { hashed: ["place"] }) });
  await seedStats(extension.worker(), records);
  await page.goto(extension.url("options.html#statistics"));
  await page.selectOption("#statsPresets", "pages");
  await page.click("#dropStatsConfirm");
  await expect(page.locator("#statsStatus")).toHaveText("Deleted. The daily totals stay.");
  const db = await statsDb(extension);
  expect(db.visits).toEqual([]);
  expect(db.totals.find((t) => t.scope === "page")).toMatchObject({ key: path, siteHash: host, tally: { scored: 200 } });
});

test("clear: everything kept is deleted, after a confirmation", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("daily"), statsSecret: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=" });
  await statsPage(page, extension, statsRecords());
  await expect(page.locator("#heroShare")).toHaveText("14%");
  await page.locator("#siteTable tr.pick", { hasText: "news.example" }).click();
  await expect(page.locator("#filter")).toBeVisible();
  await page.click("#clear");
  await expect(page.locator("#clearDialog")).toBeVisible();
  await page.click("#clearCancel");
  expect((await statsDb(extension)).totals.length).toBeGreaterThan(0);
  // The menu also closes on Escape and on a click elsewhere.
  await page.click("#more summary");
  await expect(page.locator("#month")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#month")).toBeHidden();
  await page.click("#more summary");
  await page.getByRole("heading", { name: "Reading statistics" }).click();
  await expect(page.locator("#month")).toBeHidden();
  await page.click("#clear");
  await page.click("#clearConfirm");
  await expect(page.locator("#emptyCard")).toBeVisible();
  await expect(page.locator("#filter")).toBeHidden();
  expect((await statsDb(extension)).totals).toEqual([]);
  expect((await storage.get("statsSecret")).statsSecret ?? null, "a new key for what comes next").toBeNull();
});

test("Settings: the preset menu explains what it keeps, preserves custom choices and works with the keyboard", async ({ page, extension, storage }) => {
  await page.goto(extension.url("options.html#statistics"), { waitUntil: "load" });
  const preset = page.getByRole("combobox", { name: "What to record" });
  await expect(preset).toHaveValue("off");
  await expect(preset.locator("option")).toHaveCount(8);
  await expect(page.locator("#statsPresetHint")).toHaveText("New reading activity is not recorded.");
  await expect(page.locator("#statsKeep")).toBeHidden();
  await expect(page.locator("#statsActions")).toBeHidden();
  await expect(page.locator("#statsWarnings p")).toHaveCount(0);
  await preset.selectOption("daily");
  await expect(page.locator("#statsPresetHint")).toHaveText("Word counts and verdicts by day.");
  await preset.selectOption("pages");
  await expect(page.locator("#statsTotals")).toBeHidden();
  await expect(page.locator("#statsWarnings")).toBeVisible();
  await page.locator("#statsKeep summary").focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("#statsTotals")).toBeVisible();
  await expect(page.locator("#statsDetailDays")).toBeHidden();
  await expect(page.locator("#statsFine")).toBeHidden();
  await expect(page.locator("#statsWarnings p")).toHaveText(["Saves page addresses and titles in this browser profile."]);
  await expect.poll(async () => (await storage.get("statsConfig")).statsConfig?.layers?.rows).toBe("page");
  await preset.focus();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(preset).toHaveValue("paragraphs");
  await expect(preset).toBeFocused();
  await expect.poll(async () => (await storage.get("statsConfig")).statsConfig?.layers?.rows).toBe("paragraph");
  await expect(page.locator("#statsFine")).toBeHidden();
  await page.selectOption("#statsDetailDays", "30");
  await expect.poll(async () => (await storage.get("statsConfig")).statsConfig?.retention?.detail).toBe(30);
  await preset.selectOption("full");
  await expect(page.locator("#statsFine")).toBeVisible();
  await expect(page.locator("#statsDetailDays"), "the length chosen stays with the next choice").toHaveValue("30");
  // An existing custom configuration stays intact when only its retention changes.
  await storage.set({ statsConfig: await presetConfig("pages", { layers: { title: "none" } }) });
  await expect(preset).toHaveValue("custom");
  await expect(preset.locator("option")).toHaveCount(9);
  await page.selectOption("#statsTotals", "365");
  await expect.poll(async () => (await storage.get("statsConfig")).statsConfig?.retention?.totals).toBe(365);
  await expect.poll(async () => (await storage.get("statsConfig")).statsConfig?.layers?.title, "a new length keeps the fields").toBe("none");
  await page.reload();
  await expect(preset).toHaveValue("custom");
  await expect(page.locator("#statsTotals")).toHaveValue("365");
  await expect(page.locator("#statsSize")).toContainText("records");
  await preset.selectOption("off");
  await expect.poll(async () => (await storage.get("statsConfig")).statsConfig?.on).toBe(false);
  await expect(preset.locator("option")).toHaveCount(8);
  await expect(page.locator("#statsKeep")).toBeHidden();
});

test("Settings: keeping less asks whether to delete what the new choice would not keep, and keeps it unless told", async ({ page, extension, storage }) => {
  await storage.set({ statsConfig: await presetConfig("full") });
  await seedStats(extension.worker(), statsVisit());
  await page.goto(extension.url("options.html#statistics"), { waitUntil: "load" });
  await expect(page.locator("#statsPresets")).toHaveValue("full");
  const dialog = page.locator("#dropStatsDialog");
  const kept = async () => { const db = await statsDb(extension); return [db.visits.length, db.units.length, db.events.length, db.totals.length]; };
  // Full trace → every paragraph: the events would go. Keeping them is the default, and Escape keeps too.
  await page.selectOption("#statsPresets", "paragraphs");
  await expect(dialog).toBeVisible();
  await expect(page.locator("#dropStatsKeep")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  expect(await kept()).toEqual([1, 3, 1, 2]);
  // → daily totals: the visits and paragraphs would go too; deleted, the totals stay.
  await page.selectOption("#statsPresets", "daily");
  await page.click("#dropStatsConfirm");
  await expect(dialog).toBeHidden();
  await expect(page.locator("#statsStatus")).toHaveText("Deleted. The daily totals stay.");
  expect(await kept()).toEqual([0, 0, 0, 2]);
  // Keeping more asks nothing.
  await page.selectOption("#statsPresets", "pages");
  await expect(dialog).toBeHidden();
  // Off stops recording; the existing daily totals are still available to open or clear.
  await page.selectOption("#statsPresets", "off");
  await expect.poll(async () => (await storage.get("statsConfig")).statsConfig?.on).toBe(false);
  await expect(page.locator("#statsPresetHint")).toHaveText("New reading activity is not recorded.");
  await expect(page.locator("#statsActions")).toBeVisible();
  expect(await kept()).toEqual([0, 0, 0, 2]);
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
  await expect(opened).toHaveURL(extension.url("stats.html") + "#today");
  await expect(opened.locator('#ranges [aria-pressed="true"]')).toHaveText("Today");
});


test("AI-assisted uses the reader's amber in current and mixed history", async ({ page, extension, storage }) => {
  await storage.set({statsConfig: await presetConfig("daily")});
  const day = (date, totals) => ({date, scope: "day", key: "", tally: totals});
  await statsPage(page, extension, {totals: [
    day(localDate(), tally(100, [60, 0, 0, 15, 25], [1, 0, 0, 1, 1])),
    day(daysAgo(1), tally(100, [0, 55, 45, 0], [0, 1, 1, 0])),
  ]});
  const assisted = page.locator("#heroLegend li", {hasText: "AI-assisted"});
  await expect(assisted).toHaveClass("b1");
  await expect(assisted.locator(".n")).toHaveText("25%");
  const choices = page.locator("#lensHeadline option");
  await expect(choices).toHaveCount(2);
  await page.locator("#lens summary").click();
  await page.selectOption("#lensHeadline", "assistedAndAi");
  await expect(page.locator("#heroShare")).toHaveText("40%");
  await expect(page.locator("#heroLine")).toContainText("AI-assisted");

  await page.click('#ranges [data-range="7"]');
  await expect(assisted).toHaveClass("b1");
  await expect(page.locator("#heroLegend li", {hasText: "Lightly edited"})).toHaveClass("b4");
  await expect(choices).toHaveCount(3);
  await expect(page.locator("#heroShare")).toHaveText("20%");
  await page.selectOption("#lensHeadline", "heavyAndAi");
  await expect(page.locator("#heroShare")).toHaveText("30%");
  const today = page.locator("#trendChart .col").last();
  await expect(today.locator(".seg.b1")).toHaveCount(1);
  await today.locator(".hit").hover();
  await expect(page.locator("#trendTip .b1")).toContainText("AI-assisted 25%");
  await page.selectOption("#lensHeadline", "assistedAndAi");
  await page.click("#export");
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#exportSave")]);
  const file = JSON.parse(await readFile(await download.path(), "utf8"));
  expect(file.manifest.lens.headline).toBe("assistedAndAi");
  const rows = file.tables.lens;
  expect(rows.rows.map(row => [row[rows.columns.indexOf("date")], row[rows.columns.indexOf("headline")]]))
    .toEqual([[daysAgo(1), 0], [localDate(), .4]]);
});

test("a categorical recount keeps the current model’s labels when every retained label is human or generated", async ({page, extension, storage}) => {
  const records = statsVisit();
  const baseline = tally(200, [100, 0, 0, 100, 0], [1, 0, 0, 1, 0]);
  for (const row of records.totals) row.tally = baseline;
  records.visits[0].tally = baseline;
  records.units.forEach((unit, i) => { unit.verdict = {band: i === 0 ? 3 : 0, argmax: i === 0 ? 3 : 0}; });
  await storage.set({statsConfig: await presetConfig("paragraphs")});
  await statsPage(page, extension, records);
  await page.locator("#lens summary").click();
  await page.selectOption("#lensHeadline", "assistedAndAi");
  await page.selectOption("#lensEstimator", "chip");
  await page.selectOption("#lensWeight", "paragraphs");
  await expect(page.locator("#lensNote")).toHaveText("Calculated from recorded paragraphs.");
  await expect(page.locator("#lensHeadline")).toHaveValue("assistedAndAi");
  await expect(page.locator("#lensHeadline option")).toHaveCount(2);
  await expect(page.locator("#heroLegend li", {hasText: "Heavily edited"})).toHaveCount(0);
});

test("visit facts survive event expiry and open inline with the keyboard at narrow widths", async ({ page, extension, storage }) => {
  const records = statsVisit();
  records.events = [];
  records.visits[0].scroll = {depth: .785, distance: 1500};
  records.units[0].expo.sightings = 3;
  records.units[1].expo.sightings = 2;
  await storage.set({statsConfig: await presetConfig("paragraphs")});
  await statsPage(page, extension, records);
  await page.click("#visitsTab");
  await page.setViewportSize({width: 320, height: 800});
  const open = page.getByRole("button", {name: "Visit details"});
  await open.focus();
  await page.keyboard.press("Enter");
  await expect(open).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#visitFacts dd")).toHaveText(["78.5% of page", "3", "2"]);
  await expect(page.locator("#visitTimeline")).toBeHidden();
  expect(await page.locator("#replay").evaluate(panel => panel.closest("tr").previousElementSibling.contains(document.activeElement))).toBe(true);
  expect(await page.locator("#visitsTable").evaluate(table => table.scrollWidth <= table.clientWidth)).toBe(true);
  await page.keyboard.press("Space");
  await expect(open).toHaveAttribute("aria-expanded", "false");
  await expect(page.locator("#replay")).toBeHidden();
});

test("visit details omit unknown measurements and follow retained events after recording is reduced", async ({ page, extension, storage }) => {
  const records = statsVisit();
  records.visits[0].scroll = {depth: 0, distance: 0};
  for (const u of records.units) delete u.expo;
  records.events[0].streams = {input: {t: [5000], kind: [0]}};
  await storage.set({statsConfig: await presetConfig("daily")});
  await statsPage(page, extension, records);
  await page.click("#visitsTab");
  await page.getByRole("button", {name: "Visit details"}).click();
  await expect(page.locator("#visitFacts dd")).toHaveCount(0);
  await page.locator("#visitTimeline summary").click();
  await expect(page.locator("#replayChart")).toHaveText("No timeline samples were retained for this visit.");
  await expect(page.locator("#replayChart svg")).toHaveCount(0);
});

test("a passage can enter and leave view in separate timeline chunks", async ({page, extension, storage}) => {
  const records = statsVisit();
  const chunk = records.events[0];
  const step = (t, ratio) => ({t: [t], unit: [0], obs: [0], ratio: [ratio], top: [0], h: [120]});
  records.events = [
    {...chunk, seq: 0, streams: {steps: step(500, .5)}},
    {...chunk, seq: 1, streams: {steps: step(1500, 0)}},
  ];
  await storage.set({statsConfig: await presetConfig("full")});
  await statsPage(page, extension, records);
  await page.click("#visitsTab");
  await page.getByRole("button", {name: "Visit details"}).click();
  await page.locator("#visitTimeline summary").click();
  await expect(page.locator("#replayChart rect.on")).toHaveCount(1);
  await expect(page.locator("#timelineKey")).toHaveText("Bars show when each passage was on screen.");
  await expect(page.locator("#replayChart svg text").last()).toHaveText("1:00");
});
