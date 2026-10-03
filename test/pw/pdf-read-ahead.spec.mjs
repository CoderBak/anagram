// The PDF reader reads the whole document, not only the pages pdf.js has drawn: the text of
// every page is taken from the document and its paragraphs are scored in the background,
// nearest first and paced by how fast the engine is (lib/pdf/readAhead.ts). The toolbar menu
// says how much of the document's paragraphs it has read, and where the engine is slow it reads
// only around the page being read and offers the rest. Without Zotero's structure the reader
// reads only what is drawn, and the menu counts pages. Nothing is scrolled here unless a test
// says so.
//
//   npx playwright test pdf-read-ahead
import { test as base, expect, BADGE_SEL, popupOver, menuReport } from "./kit.mjs";
import { TALL_PDF, openPdfInReader, readerRead } from "../pdf-fixture.mjs";

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
const SCOPED = /^Covers the (\d+) pages loaded now, of 30; the others are read as you scroll to them\.$/;
const NOTE = /so far|read as you scroll/;

/** The menu's report, its note on how much of the document is read, and its page action. */
async function menuState(menu) {
  const shown = await menuReport(menu).catch(() => null);
  const action = await menu.evaluate(() => {
    const button = document.getElementById("pageAction");
    return button && !button.hidden ? button.textContent : null;
  }).catch(() => null);
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
  await expect.poll(async () => {
    state = await menuState(menu);
    return state.action;
  }, { message: offered, timeout: 100_000, intervals: [500] }).toBe("Read the whole document");
  expect.soft(state.scope, offered).toMatch(SHARE);
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

test("without Zotero's structure the reader reads only the pages drawn, and the menu counts pages", async ({ context, tall, nativeHost, storage }) => {
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
  expect.soft(state.action, `${reflow} (and nothing is offered)`).toBeNull();
});

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
  await page.locator("#autoOpenPdfs").waitFor();
  await expect(page.locator("#pdfReadAhead"), "the setup page leaves the read-ahead to Settings").toHaveCount(0);
});
