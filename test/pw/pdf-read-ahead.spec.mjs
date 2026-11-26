// The PDF reader reads the whole document, not only the pages pdf.js has drawn: the text of
// every page is taken from the document and its paragraphs are scored in the background,
// nearest first and paced by how fast the engine is (lib/pdf/readAhead.ts). The toolbar menu
// says how much of the document's paragraphs it has read, and where the engine is slow it reads
// only around the page being read and offers the rest. Without Zotero's structure the reader
// reads what is drawn until the menu requests the entire document. Nothing is scrolled here unless a test
// says so.
//
//   npx playwright test pdf-read-ahead
import { test as base, expect, BADGE_SEL, popupOver, menuReport } from "./kit.mjs";
import { presetConfig, statsDb } from "../stats-fixture.mjs";
import { buildPdf, pdfColumn, PDF_PARAS, TALL_PDF, TALL_WORDS, openPdfInReader, readerRead, readerReady } from "../pdf-fixture.mjs";

const test = base.extend({
  /** The thirty-page document, served as application/pdf. */
  tall: async ({ pages }, use) => {
    pages.serve({ "/tall.pdf": TALL_PDF });
    await use(pages.url("/tall.pdf"));
  },
});

const PAGES = 30;
/** TALL_PDF sets four paragraphs a page. */
const PER_PAGE = 4;
/** The read-ahead under way, and the share read where it reads only around the page (a slow
 *  engine, or the setting off): percentages of the document's paragraphs. */
const READING = /^Reading the whole document: (\d+)% so far\.$/;
const SHARE = /^(\d+)% of the document read; the rest is read as you scroll to it\.$/;
/** The reflow's, with no structure: pages. */
const SCOPED = /^Covers (\d+) of 30 pages\. Scroll to read more\.$/;
const NOTE = /so far|^Covers |read as you scroll|^Prepared |^Could not read /;

/** The menu's report, its note on how much of the document is read, and its page action. */
async function menuState(menu) {
  const actionOf = () => menu.evaluate(() => {
    const button = document.getElementById("pageAction");
    return button && !button.hidden ? button.textContent : null;
  }).catch(() => null);
  // The note and the button are read one after the other, and the menu can be redrawn between
  // the two (it draws both from one report): a reading counts when the button read before the
  // note is the one read after it.
  let shown, action;
  for (let tries = 0; tries < 10; tries++) {
    const before = await actionOf();
    shown = await menuReport(menu).catch(() => null);
    action = await actionOf();
    if (action === before) break;
  }
  return {
    read: shown?.bands.reduce((a, b) => a + b, 0) ?? 0,
    scope: shown?.notes.find((n) => NOTE.test(n)) ?? null,
    notes: shown?.notes ?? [],
    action,
  };
}

/** Pages of the reader with a text layer drawn now. */
const drawnPages = (page) =>
  page.evaluate(() => [...document.querySelectorAll("#viewer .page")]
    .filter((p) => p.querySelector(".textLayer span"))
    .map((p) => Number(p.dataset.pageNumber)));

/** Chips on page `n` that carry a verdict, and chips there still waiting for one. */
const chipsOn = (page, n) =>
  page.evaluate(([sel, n]) => {
    const pills = [...document.querySelectorAll(sel)]
      .filter((h) => h.closest(".page")?.dataset.pageNumber === String(n))
      .map((h) => h.shadowRoot?.querySelector(".pill"))
      .filter(Boolean);
    return { scored: pills.filter((p) => p.classList.contains("scored")).length, pending: pills.filter((p) => p.classList.contains("pending")).length };
  }, [BADGE_SEL, n]);

/** Page `n` shows its paragraphs' chips (a paragraph or two may be read with a neighbour),
 *  every one with its verdict. */
const pageRead = async (page, n) => {
  const { scored, pending } = await chipsOn(page, n);
  return scored >= PER_PAGE - 1 && pending === 0;
};

/** The upstream viewer scrolls its own container and draws the text layers near it. */
async function visitPdfPage(page, number) {
  await page.locator("#pageNumber").fill(String(number));
  await page.locator("#pageNumber").press("Enter");
  await page.waitForFunction((n) => window.PDFViewerApplication.page === n &&
    window.PDFViewerApplication.pdfViewer.getPageView(n - 1)?.renderingState === 3 &&
    !!document.querySelector(`#viewer .page[data-page-number="${n}"] .textLayer span`), number, { timeout: 30_000 });
}

/** The reader's own document says it is hidden, or shown again, as the browser would. Headless
 *  Chromium never hides a page; the reader runs in the page's own world. */
const setHidden = (page, hidden) =>
  page.evaluate((hidden) => {
    for (const [key, value] of [["visibilityState", hidden ? "hidden" : "visible"], ["hidden", hidden]]) {
      Object.defineProperty(document, key, { configurable: true, get: () => value });
    }
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);

async function openTall(context, url) {
  const page = await openPdfInReader(context, url);
  await readerRead(page, { timeout: 30_000 });
  return page;
}

test("with nothing scrolled, the menu's report comes to cover every page, its list goes to a page never drawn, and a far page's chips cost no request", async ({ context, tall, nativeHost }) => {
  test.setTimeout(150_000);
  const page = await openTall(context, tall);
  const menu = await popupOver(page);
  const whole = "PDF read-ahead: the report covers all thirty pages without one being scrolled to, and the scope note goes";
  let state;
  await expect.poll(async () => {
    state = await menuState(menu);
    return state.scope === null && state.read >= PAGES * 3;
  }, { message: whole, timeout: 90_000, intervals: [500] }).toBe(true);
  expect.soft(state.notes.join(" "), whole).not.toMatch(NOTE);
  expect.soft(state.action, `${whole} (nothing left to offer)`).toBeNull();
  const drawn = await drawnPages(page);
  expect.soft(drawn.length, `${whole}: it is not pdf.js drawing them (${drawn})`).toBeLessThan(15);
  expect.soft(drawn, `${whole}: page 25 is not drawn yet`).not.toContain(25);
  expect.soft(await page.evaluate(() => window.PDFViewerApplication.page), `${whole}: still on page 1`).toBe(1);

  const requests = nativeHost.stats.requests;
  const mark = nativeHost.textMark();
  // The menu lists what was read ahead, and its last row is on a page far from any drawn.
  const rows = menu.locator(".report-result");
  if (await rows.count() > 0) {
    const reveal = "PDF read-ahead: a row of the menu's list goes to its paragraph's page, which was never drawn";
    await rows.last().click();
    await expect.poll(() => page.evaluate(() => window.PDFViewerApplication.page), { message: reveal, timeout: 15_000 }).not.toBe(1);
    const at = await page.evaluate(() => window.PDFViewerApplication.page);
    expect.soft(drawn, `${reveal} (page ${at})`).not.toContain(at);
    await expect.poll(() => pageRead(page, at), { message: `${reveal} (page ${at})`, timeout: 20_000 }).toBe(true);
  }
  await visitPdfPage(page, 25);
  const cached = "PDF read-ahead: a page read ahead shows its chips when drawn, from the cache, with no request";
  await expect.poll(() => pageRead(page, 25), { message: cached, timeout: 20_000 }).toBe(true);
  expect.soft(nativeHost.textsSince(mark).map((t) => t.slice(0, 40)), cached).toEqual([]);
  expect.soft(nativeHost.stats.requests, cached).toBe(requests);
});

test("while it reads ahead, the menu counts the pages read so far, and the count climbs", async ({ context, tall, nativeHost }) => {
  test.setTimeout(120_000);
  // A little slower than the fixture's own pace, so there is a while to watch.
  nativeHost.setState({ latency: [300, 500] });
  const page = await openTall(context, tall);
  const menu = await popupOver(page);
  /** Every count the menu showed, in the order it showed them. */
  const seen = [];
  const climbs = "PDF read-ahead: the menu says 'Reading the whole document: N% so far.', N climbing";
  await expect.poll(async () => {
    const state = await menuState(menu);
    const n = state.scope?.match(READING)?.[1];
    if (n !== undefined && seen.at(-1) !== Number(n)) seen.push(Number(n));
    return seen.length;
  }, { message: climbs, timeout: 90_000, intervals: [250] }).toBeGreaterThanOrEqual(2);
  expect.soft(seen.every((n) => n >= 0 && n < 100), `${climbs}: ${seen}`).toBe(true);
  expect.soft(seen, `${climbs}: it never goes back`).toEqual([...seen].sort((a, b) => a - b));
  expect.soft((await menuState(menu)).action, `${climbs} (a fast engine is offered nothing)`).toBeNull();
});

test("a slow engine reads only around the page, says so, and reads the rest once the menu is asked to", async ({ context, tall, nativeHost }) => {
  test.setTimeout(150_000);
  // One paragraph of about 600 characters a request at 2.5 s: two background batches make the
  // pace slow (test/node/readAhead.test.ts).
  nativeHost.setState({ latency: [2500, 2500] });
  const page = await openTall(context, tall);
  const menu = await popupOver(page);
  const offered = "PDF read-ahead: a slow engine reads around the page and the menu offers 'Read the whole document'";
  let state;
  // The note and the button are read one after the other, and the menu can be redrawn between
  // the two: wait for a reading in which both say so.
  await expect.poll(async () => {
    state = await menuState(menu);
    return state.action === "Read the whole document" && SHARE.test(state.scope ?? "") ? "offered" : `${state.action} | ${state.scope}`;
  }, { message: offered, timeout: 100_000, intervals: [500] }).toBe("offered");
  expect.soft(Number(state.scope?.match(SHARE)?.[1]), offered).toBeLessThan(50);

  await menu.locator("#pageAction").click();
  // The menu closes once the reader has taken the action; where the reader turns it down the
  // menu stays open and says so (popupPageActionFailed).
  const asked = "PDF read-ahead: asked for the whole document, the reader reads it all and stops offering it";
  await expect.poll(async () => menu.isClosed() ? "closed" : await menu.evaluate(() => {
    const status = document.getElementById("status");
    return status && !status.hidden ? status.textContent : "open";
  }).catch(() => "closed"), { message: `${asked} (the reader takes the menu's action)`, timeout: 10_000 }).toBe("closed");
  const again = await popupOver(page);
  await expect.poll(async () => {
    state = await menuState(again);
    return state.scope;
  }, { message: asked, timeout: 15_000 }).toMatch(READING);
  expect.soft(state.action, asked).toBeNull();
});

test("with the read-ahead off in Settings, only the pages drawn are read", async ({ context, tall, nativeHost, storage }) => {
  test.setTimeout(90_000);
  await storage.set({ pdfReadAhead: false });
  const mark = nativeHost.textMark();
  const page = await openTall(context, tall);
  await expect.poll(() => pageRead(page, 1), { message: "page 1 is read", timeout: 20_000 }).toBe(true);
  // Long enough for the quietest the read-ahead ever waits (five seconds) and a batch.
  await page.waitForTimeout(7000);
  const drawn = await drawnPages(page);
  const lines = await page.evaluate(() => [...document.querySelectorAll("#viewer .textLayer span")].map((s) => s.textContent.trim()).filter((t) => t.length > 10));
  const sent = nativeHost.textsSince(mark);
  const off = `PDF read-ahead off: nothing is read beyond the drawn pages ${drawn}`;
  expect.soft(sent.length, off).toBeGreaterThan(0);
  expect.soft(sent.filter((t) => !lines.some((line) => t.startsWith(line))).map((t) => t.slice(0, 40)), `${off} (texts from no drawn page)`).toEqual([]);
  // A paragraph may be sent twice, as the quick reflow read it and then as Zotero's structure
  // does: count paragraphs, not texts.
  const paragraphs = new Set(sent.map((t) => lines.find((line) => t.startsWith(line))));
  expect.soft(paragraphs.size, off).toBeLessThanOrEqual(drawn.length * PER_PAGE);
  const menu = await popupOver(page);
  let state;
  await expect.poll(async () => (state = await menuState(menu)).scope, { message: off }).toMatch(SHARE);
  // About as much of the paragraphs as of the pages: the drawn ones.
  expect.soft(Number(state.scope.match(SHARE)[1]), off).toBeLessThan(100 * (drawn.length + 1) / PAGES);
  expect.soft(state.action, `${off} (and nothing is offered)`).toBeNull();
});

test("without Zotero the menu reads unseen pages on request and later places cached chips", async ({ context, tall, nativeHost, storage }) => {
  test.setTimeout(90_000);
  await storage.set({ pdfStructure: false });
  const mark = nativeHost.textMark();
  const page = await openPdfInReader(context, tall);
  await expect.poll(() => pageRead(page, 1), { message: "page 1 is read", timeout: 30_000 }).toBe(true);
  await page.waitForTimeout(6000);
  const drawn = await drawnPages(page);
  const lines = await page.evaluate(() => [...document.querySelectorAll("#viewer .textLayer span")].map((s) => s.textContent.trim()).filter((t) => t.length > 10));
  const reflow = `PDF reader, reflow: nothing is read beyond the drawn pages ${drawn}`;
  expect.soft(nativeHost.textsSince(mark).filter((t) => !lines.some((line) => t.startsWith(line))).map((t) => t.slice(0, 40)), reflow).toEqual([]);
  const menu = await popupOver(page);
  let state;
  await expect.poll(async () => (state = await menuState(menu)).scope, { message: reflow }).toMatch(SCOPED);
  expect.soft(Number(state.scope.match(SCOPED)[1]), reflow).toBeLessThanOrEqual(drawn.length);
  expect(state.action).toBe("Read the whole document");
  const worker = page.waitForEvent("worker", {predicate: (w) => /scan\.worker/.test(w.url())});
  await menu.locator("#pageAction").click();
  await worker;
  await expect.poll(() => menu.isClosed()).toBe(true);
  const report = await popupOver(page);
  await expect.poll(async () => {
    state = await menuState(report);
    return state.scope === null && state.read >= PAGES * 3;
  }, { message: "fallback covers the whole document", timeout: 75_000, intervals: [250] }).toBe(true);
  expect(state.action).toBeNull();
  expect(await drawnPages(page)).not.toContain(25);
  expect(await page.locator("#pageNumber").inputValue()).toBe("1");
  const beforeVisit = nativeHost.textMark();
  await report.close();
  await visitPdfPage(page, 25);
  await expect.poll(() => pageRead(page, 25), { timeout: 15_000 }).toBe(true);
  expect(nativeHost.textsSince(beforeVisit)).toEqual([]);
});

test("a later spelling replaces a provisional verdict and the toolbar counts the corrected passage once", async ({context, pages, storage, nativeHost, extension}) => {
  await storage.set({pdfStructure: false, statsConfig: await presetConfig("fullText")});
  const broken = ["The researchers took their observations outdoors during the long dry-", "season that followed the spring rains.", ...PDF_PARAS[0]];
  const evidence = ["Later in the report the dry-season measurements are compared again.", ...PDF_PARAS[0]];
  const doc = [pdfColumn(broken, 680), ...Array.from({length: 15}, () => []), pdfColumn(evidence, 680)];
  pages.serve({"/rainfall.pdf": buildPdf(doc)});
  const mark = nativeHost.textMark();
  const page = await openPdfInReader(context, pages.url("/rainfall.pdf"));
  const saw = (needle) => nativeHost.textsSince(mark).some((text) => text.includes(needle));
  await expect.poll(() => saw("long dryseason"), {timeout: 25_000}).toBe(true);
  const visit = async () => (await statsDb(extension))?.visits.find((v) => v.surface === "pdf");
  await expect.poll(async () => (await visit())?.tally.scored, {timeout: 20_000}).toBeGreaterThan(0);
  const original = (await visit()).tally;
  const menu = await popupOver(page);
  await menu.locator("#pageAction").click();
  const report = await popupOver(page);
  await expect.poll(() => saw("long dry-season"), {timeout: 35_000}).toBe(true);
  await expect.poll(async () => {
    const {scope, read} = await menuState(report);
    return {scope, read};
  }, {timeout: 20_000}).toEqual({scope: null, read: 2});
  expect(await page.locator("#pageNumber").inputValue()).toBe("1");
  await report.close();
  await page.bringToFront();
  await page.waitForTimeout(1800); // Keep the corrected passage in view past the reading threshold.
  await page.goto("about:blank");
  await expect.poll(async () => (await visit())?.ended, {timeout: 15_000}).toBeTruthy();
  const db = await statsDb(extension);
  expect(db.visits.find((v) => v.surface === "pdf").tally).toEqual(original);
  expect(db.totals.find((t) => t.scope === "day").tally).toEqual(original);
  expect(db.units.filter((u) => u.readDate)).toHaveLength(1);
});

test("an unreadable fallback page is reported and can be retried without reopening any other page", async ({ context, tall, storage }) => {
  test.setTimeout(90_000);
  await storage.set({ pdfStructure: false, pdfReadAhead: false });
  const page = await openPdfInReader(context, tall);
  await expect.poll(() => pageRead(page, 1), { timeout: 20_000 }).toBe(true);
  const menu = await popupOver(page);
  await expect.poll(async () => (await menuState(menu)).scope).toMatch(SCOPED);
  expect((await menuState(menu)).action).toBeNull();
  await page.evaluate(() => {
    const doc = window.PDFViewerApplication.pdfDocument;
    const get = doc.getPage.bind(doc);
    window.attemptedPages = [];
    let once = true;
    doc.getPage = (n) => {
      window.attemptedPages.push(n);
      if (once && n === 26) { once = false; return Promise.reject(new Error("Page unavailable")); }
      return get(n);
    };
  });
  await storage.set({ pdfReadAhead: true });
  await expect(menu.locator("#pageAction")).toHaveText("Read the whole document");
  await menu.locator("#pageAction").click();
  await expect.poll(() => menu.isClosed()).toBe(true);
  const retry = await popupOver(page);
  await expect.poll(async () => (await menuState(retry)).scope, { timeout: 55_000 }).toBe("Could not read 1 of 30 pages.");
  await expect(retry.locator("#pageAction")).toHaveText("Retry unread pages");
  await page.evaluate(() => { window.attemptedPages.length = 0; });
  await retry.locator("#pageAction").click();
  await expect.poll(() => retry.isClosed()).toBe(true);
  const final = await popupOver(page);
  await expect.poll(async () => {
    const state = await menuState(final);
    return state.scope === null && state.read >= PAGES * 3;
  }, { timeout: 20_000 }).toBe(true);
  expect(await page.evaluate(() => window.attemptedPages)).toEqual([26]);
});

for (const structured of [false, true]) {
  test(`a PDF with image covers reads the later text without scrolling, structure ${structured}`, async ({ context, pages, storage, nativeHost }) => {
    await storage.set({pdfStructure: structured});
    const doc = buildPdf([[], [], [], pdfColumn(PDF_PARAS[0], 680)], {drawings: ["60 100 470 510 re f", "80 100 400 510 re f"]});
    pages.serve({"/covers.pdf": doc});
    const mark = nativeHost.textMark();
    const page = await openPdfInReader(context, pages.url("/covers.pdf"));
    if (!structured) {
      const menu = await popupOver(page);
      await expect(menu.locator("#pageAction")).toHaveText("Read the whole document");
      await menu.locator("#pageAction").click();
    }
    await expect.poll(() => nativeHost.textsSince(mark).length, {timeout: 20_000}).toBeGreaterThan(0);
    await expect(page.locator("#notice")).toBeHidden();
    expect(await page.locator("#pageNumber").inputValue()).toBe("1");
    expect(await drawnPages(page)).not.toContain(4);
  });
}

test("a hidden reader asks the engine for nothing in the background, and picks up when it is shown", async ({ context, tall, nativeHost }) => {
  test.setTimeout(120_000);
  // Slow enough that the document is not read whole before the tab is hidden.
  nativeHost.setState({ latency: [400, 600] });
  const page = await openTall(context, tall);
  await expect.poll(() => pageRead(page, 1), { message: "page 1 is read", timeout: 20_000 }).toBe(true);
  await setHidden(page, true);
  // What was already on its way lands.
  await page.waitForTimeout(1500);
  const mark = nativeHost.textMark();
  const requests = nativeHost.stats.requests;
  await page.waitForTimeout(6000);
  const hidden = "PDF read-ahead: a hidden reader sends nothing";
  expect.soft(nativeHost.textsSince(mark).map((t) => t.slice(0, 40)), hidden).toEqual([]);
  expect.soft(nativeHost.stats.requests, hidden).toBe(requests);
  await setHidden(page, false);
  await expect.poll(() => nativeHost.textsSince(mark).length, { message: "PDF read-ahead: shown again, the reader reads on", timeout: 30_000 }).toBeGreaterThan(0);
});

// A document longer than the reader reads without asking (300 pages where the browser does not
// say how much memory there is, as in Firefox and Safari): the menu offers to read it whole,
// and the structure is then read in page ranges, a worker each (lib/pdf/structureWorker.ts).
// Here the caps are ten pages and ranges of twelve, so the thirty pages are read in three
// ranges of ten; what comes of them must be what one worker reads of the whole, on the same
// pages. (Test builds read the caps from __anagramReaderCaps, here from localStorage.)
test("past what it reads without asking, the menu offers the whole document, and reading it in page ranges reads what one worker does, on the same pages", async ({ context, tall, nativeHost, extension }) => {
  test.setTimeout(240_000);
  await context.addInitScript(() => {
    try { globalThis.__anagramReaderCaps = JSON.parse(localStorage.getItem("anagram-test-caps") ?? "null") ?? undefined; } catch {}
  });
  const opt = await context.newPage();
  await opt.goto(extension.url("options.html"), { waitUntil: "load" });
  const caps = (value) => opt.evaluate((value) => localStorage.setItem("anagram-test-caps", JSON.stringify(value)), value);
  /** The menu's report once the whole document is read: how many paragraphs read as each word. */
  const wholeReport = async (page, message) => {
    const menu = await popupOver(page);
    let state;
    await expect.poll(async () => { state = await menuState(menu); return state.scope === null && state.read >= PAGES * 3; }, { message, timeout: 90_000, intervals: [500] }).toBe(true);
    const shown = await menuReport(menu);
    await menu.close();
    return { bands: shown.bands, action: state.action };
  };

  await caps({ autoPages: 10, rangePages: 12 });
  const page = await openPdfInReader(context, tall);
  // Not readerRead: it waits for the structure, which is not read until asked.
  await readerReady(page, { timeout: 30_000 });
  const menu = await popupOver(page);
  const offer = "PDF reader: past the pages it reads without asking, the menu offers to read the whole document";
  let state;
  await expect.poll(async () => { state = await menuState(menu); return state.action; }, { message: offer, timeout: 20_000 }).toBe("Read the whole document");
  expect.soft(state.scope ?? "", `${offer}, and meanwhile counts the pages drawn`).toMatch(SCOPED);
  expect.soft(await page.evaluate(() => performance.getEntriesByName("anagram-structure").length), `${offer}: no structure until asked`).toBe(0);
  const pressed = nativeHost.textMark();
  await menu.locator("#pageAction").click();
  const ranges = "PDF reader: the whole document read in three page ranges";
  // From the press on, the menu says the whole document is being read, not what it covered.
  await expect.poll(() => menu.isClosed(), { message: `${offer}: the menu closes as the reader takes it` }).toBe(true);
  const asked = await menuState(await popupOver(page));
  expect.soft(asked.scope ?? "", `${offer}: once pressed, the menu says it is reading the whole document`).not.toMatch(SCOPED);
  expect.soft(asked.action, `${offer}: once pressed, it is not offered again`).toBeNull();
  await page.waitForFunction(() => performance.getEntriesByName("anagram-structure").length > 0, null, { timeout: 60_000 });
  const ranged = await wholeReport(page, `${ranges}: the report comes to cover every page`);
  expect.soft(ranged.action, `${ranges}: nothing left to offer`).toBeNull();
  // Every paragraph read from the structure went to the engine as itself — its words ending
  // "and so it ends.", none run into the next or into the running head — and all 120 were read.
  const paragraph = (t) => /and so it ends\.$/.test(t) && t.split(/\s+/).length === TALL_WORDS && !t.includes("ANAGRAM TEST DOCUMENT");
  expect.soft(nativeHost.textsSince(pressed).filter((t) => !paragraph(t)).map((t) => t.slice(0, 60)), `${ranges}: every text read is one paragraph`).toEqual([]);
  expect.soft(new Set(nativeHost.textsSince().filter(paragraph)).size, `${ranges}: every paragraph is read`).toBe(PAGES * PER_PAGE);
  // A page of the last range shows its own paragraphs' chips, from the cache: its paragraphs
  // were placed on it, not ten or twenty pages before it.
  const requests = nativeHost.stats.requests;
  const mark = nativeHost.textMark();
  await visitPdfPage(page, 25);
  const placed = `${ranges}: page 25's paragraphs are on page 25`;
  await expect.poll(() => pageRead(page, 25), { message: placed, timeout: 20_000 }).toBe(true);
  expect.soft(nativeHost.textsSince(mark).map((t) => t.slice(0, 40)), placed).toEqual([]);
  expect.soft(nativeHost.stats.requests, placed).toBe(requests);
  await page.close();

  // The same document read by one worker, from nothing cached: the same paragraphs.
  await caps({ rangePages: 100 });
  await opt.click("#clearCache");
  await expect(opt.locator("#cacheStatus")).toContainText("Cleared");
  const again = await openPdfInReader(context, tall);
  await readerRead(again, { timeout: 30_000 });
  const whole = await wholeReport(again, "PDF reader: the same document read by one worker");
  expect.soft(ranged.bands, `${ranges}: as many paragraphs read as each word as one worker reads`).toEqual(whole.bands);
  expect.soft(whole.bands.reduce((a, b) => a + b, 0), "PDF reader: one worker reads every paragraph").toBeGreaterThanOrEqual(PAGES * 3);
});

test("Settings offers the read-ahead among the PDF rows, on unless turned off, and the setup page does not", async ({ page, extension, storage }) => {
  await page.goto(extension.url("options.html"));
  const toggle = page.locator("#pdfRows #pdfReadAhead");
  const settings = "Settings: the read-ahead switch is in the PDFs group and on by default";
  await expect(toggle, settings).toBeChecked();
  await expect(toggle, settings).toHaveAttribute("role", "switch");
  await expect(page.locator('label[for="pdfReadAhead"]'), settings).toHaveText("Read whole PDFs in the background");
  expect(await storage.get("pdfReadAhead"), `${settings} (nothing stored until it is changed)`).toEqual({});
  await toggle.uncheck();
  await expect.poll(() => storage.get("pdfReadAhead"), { message: "Settings: turning it off is stored" }).toEqual({ pdfReadAhead: false });
  await page.reload();
  await expect(page.locator("#pdfRows #pdfReadAhead"), "Settings: off stays off").not.toBeChecked();
  await page.locator("#pdfRows #pdfReadAhead").check();
  await expect.poll(() => storage.get("pdfReadAhead"), { message: "Settings: turning it on is stored" }).toEqual({ pdfReadAhead: true });

  await page.goto(extension.url("onboarding.html"));
  // The step may be folded while an earlier one is still to do.
  await page.locator("#autoOpenPdfs").waitFor({ state: "attached" });
  await expect(page.locator("#pdfReadAhead"), "the setup page leaves the read-ahead to Settings").toHaveCount(0);
});
