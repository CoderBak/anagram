// The PDF reader: a real PDF handed to the full PDF.js viewer and shown as it is, with the
// ORDINARY pipeline over it (the same chips, underlines and toolbar menu report). The
// reconstruction is invisible and is only asserted through what it decides: what reaches the
// host, and where a chip lands. Then short paragraphs grouped under a heading, a thirty-page
// document, a scan and a corrupt file, the way in from a tab showing a PDF, the drop zone,
// and two documents asked for one after the other.
//
//   npx playwright test scenarios-pdf
import { test as base, expect, BADGE_SEL, ABSENCE_MS, popupOver, menuReport } from "./kit.mjs";
import {
  BROKEN_PDF, GROUPED_PARAS, GROUPED_PDF, GROUPED_UNIT_TEXT, PDF_HEAD, PDF_HEADING, PDF_PARAS, SCANNED_PDF, TALL_PDF, TEST_PDF,
  handOverPdf, openPdfInReader, pdfTabChip, readerRead, readerReady,
} from "../pdf-fixture.mjs";

const test = base.extend({
  /** The documents, served as application/pdf; `url(path)` is where each is. */
  pdfs: async ({ pages }, use) => {
    pages.serve({ "/doc.pdf": TEST_PDF, "/grouped.pdf": GROUPED_PDF, "/scanned.pdf": SCANNED_PDF, "/broken.pdf": BROKEN_PDF, "/tall.pdf": TALL_PDF });
    await use({ url: pages.url });
  },
});

/** The upstream viewer scrolls its own container and draws the text layers near it. */
async function visitPdfPage(page, number) {
  await page.locator("#pageNumber").fill(String(number));
  await page.locator("#pageNumber").press("Enter");
  await page.waitForFunction((n) => window.PDFViewerApplication.page === n &&
    window.PDFViewerApplication.pdfViewer.getPageView(n - 1)?.renderingState === 3 &&
    !!document.querySelector(`#viewer .page[data-page-number="${n}"] .textLayer span`), number, { timeout: 30_000 });
}
async function visitShortPdf(page) {
  await readerReady(page, { timeout: 30_000 });
  const count = await page.evaluate(() => window.PDFViewerApplication.pdfDocument.numPages);
  for (let number = 1; number <= count; number++) await visitPdfPage(page, number);
  await visitPdfPage(page, 1);
}
/** The reader's chips (its toolbar and notices are badge hosts too: a chip holds a pill). */
const readerChips = (page) =>
  page.evaluate((sel) => {
    const pills = [...document.querySelectorAll(sel)].map((h) => h.shadowRoot?.querySelector(".pill")).filter(Boolean);
    return { chips: pills.length, pending: pills.filter((p) => p.classList.contains("pending")).length };
  }, BADGE_SEL);
/** Zotero's structure has answered (it re-lays every chip) and `n` chips carry their verdicts. */
async function readerSettles(page, n) {
  await readerRead(page);
  await expect.poll(() => readerChips(page), { message: `${n} settled chips in the reader` }).toEqual({ chips: n, pending: 0 });
}

/** Everything about the reader page a check below reads, in one pass. */
const readReader = (page) =>
  page.evaluate((sel) => {
    const chips = [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill"));
    const spans = [...document.querySelectorAll(".textLayer span")];
    const rects = spans.map((s) => s.getBoundingClientRect());
    const placed = chips.map((h) => {
      const r = h.getBoundingClientRect();
      const box = h.closest(".page").getBoundingClientRect();
      return {
        page: Number(h.closest(".page").dataset.pageNumber),
        inPage: r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
        // Half a pixel of tolerance: a chip that ends exactly where a span begins is beside
        // the text, not over it.
        overText: rects.some((s) => s.width > 0 && r.left < s.right - 0.5 && s.left + 0.5 < r.right && r.top < s.bottom - 0.5 && s.top + 0.5 < r.bottom),
      };
    });
    let marks = 0;
    const marked = [];
    for (const h of CSS.highlights?.values() ?? []) {
      marks += h.size;
      for (const range of h) marked.push(range.toString());
    }
    return {
      pages: window.PDFViewerApplication.pdfDocument.numPages,
      spans: spans.length,
      // The pages that have been DRAWN: a released or never-drawn canvas has no bitmap.
      drawn: [...document.querySelectorAll(".page canvas")].filter((c) => c.width > 0).length,
      text: spans.map((s) => s.textContent).join(" "),
      chips: chips.length,
      placed,
      marks,
      marked,
      scale: window.PDFViewerApplication.pdfViewer.currentScale,
      title: document.title,
    };
  }, BADGE_SEL);

test("a PDF in the reader: its paragraphs read as written, drawn with a text layer, one chip each beside the text, marks on their glyphs, zoom from the cache and the menu's report", async ({ page, pdfs, nativeHost, storage }) => {
  // Every paragraph read is underlined, so the marks are checked on all of them.
  await storage.set({ underlineScope: "all" });
  const extErrors = [];
  page.on("console", (m) => {
    // Only what OUR page said: the browser's own viewer asking the server for a favicon it
    // does not serve is not our news.
    if (m.type() === "error" && (m.location()?.url ?? "").startsWith("chrome-extension://")) extErrors.push(m.text().slice(0, 140));
  });
  const mark = nativeHost.textMark(); // what THIS document sends
  await page.goto(pdfs.url("/doc.pdf"), { waitUntil: "load" }).catch(() => {});
  await handOverPdf(page);
  await visitShortPdf(page);
  await readerSettles(page, 3);
  const read = await readReader(page);
  const sent = nativeHost.textsSince(mark);
  const first = PDF_PARAS[0].join(" "), last = PDF_PARAS[3].join(" ");
  const continuation = PDF_PARAS[1].join(" ").replace("hyphen- ation", "hyphenation").replace("state-of-the- art", "state-of-the-art");
  const tail = PDF_PARAS[2].join(" ");
  // A drawn page may be scored before its neighbour arrives. Only these exact source-derived
  // units are valid; the final map must include the joined paragraph.
  const allowed = new Set([first, continuation, tail, `${continuation} ${tail}`, last]);
  const joined = "PDF reader: rendered paragraphs reach the fixture and adjacent pages join without invented text";
  expect.soft(sent, joined).toEqual(expect.arrayContaining([first, last, `${continuation} ${tail}`]));
  expect.soft(sent.filter((t) => !allowed.has(t)).map((t) => t.slice(0, 40)), joined).toEqual([]);
  const furniture = "PDF reader: the running head and the page numbers never leave the page for the fixture";
  expect.soft(sent.filter((t) => t.includes(PDF_HEAD) || /\s[12]\s/.test(t)).map((t) => t.slice(0, 40)), furniture).toEqual([]);
  expect.soft(read.text, `${furniture} (and they are still THERE: the reader shows the document as it is)`).toContain(PDF_HEAD);
  const mended = "PDF reader: a broken word is mended and a real compound keeps its hyphen";
  expect.soft(sent.join(" "), mended).toContain("hyphenation mark is joined");
  expect.soft(sent.join(" "), mended).not.toContain("hyphen- ation");
  expect.soft(sent.join(" "), mended).toContain("compound such as state-of-the-art keeps");
  const drawn = "PDF reader: the real pages are drawn, with a selectable text layer over every one";
  expect.soft({ pages: read.pages, drawn: read.drawn, title: read.title }, drawn).toEqual({ pages: 2, drawn: 2, title: "doc.pdf" });
  expect.soft(read.spans, drawn).toBeGreaterThan(0);
  expect.soft([...PDF_PARAS.map((lines) => lines[0]), PDF_HEADING].filter((line) => !read.text.includes(line)), drawn).toEqual([]);
  expect.soft(extErrors, drawn).toEqual([]);
  const placed = "PDF reader: one chip per scored paragraph, inside its page and never over the text";
  expect.soft(read.chips, placed).toBe(3);
  expect.soft(read.placed.filter((c) => !c.inPage || c.overText), placed).toEqual([]);
  const marks = "PDF reader: the marks lie on the paragraph's own glyphs, not on the whole page";
  expect.soft(read.marks, marks).toBeGreaterThanOrEqual(20);
  expect.soft(read.marked.some((t) => t.startsWith("Anagram rebuilds this document")), marks).toBe(true);
  expect.soft(read.marked.filter((t) => t.includes(PDF_HEAD)), marks).toEqual([]);

  // Upstream may replace text nodes on zoom: the mapping comes back, the scores from the cache.
  const requestsBefore = nativeHost.stats.requests;
  await page.locator("#zoomInButton").click();
  await visitShortPdf(page);
  await expect.poll(() => readerChips(page)).toEqual({ chips: 3, pending: 0 });
  const zoom = "PDF reader: zoom restores chips and mapped marks without requesting the same scores again";
  // The chips are back before every re-drawn text layer has its marks mapped again.
  await expect.poll(async () => (await readReader(page)).marks, { message: `${zoom} (the marks)` }).toBe(read.marks);
  const zoomed = await readReader(page);
  expect.soft(zoomed.scale, zoom).toBeGreaterThan(read.scale);
  expect.soft({ chips: zoomed.chips, marks: zoomed.marks }, zoom).toEqual({ chips: read.chips, marks: read.marks });
  expect.soft(zoomed.placed.filter((c) => !c.inPage || c.overText), zoom).toEqual([]);
  expect.soft(nativeHost.stats.requests, zoom).toBe(requestsBefore);

  // The toolbar menu's report is the PDF's, not the chrome-extension:// address it is rendered
  // on. PDF.js is still re-drawing after the zoom, and the reader re-reads each page
  // it re-draws: the menu asks again every second, so it is read until its title and rows agree.
  const report = "PDF reader: the toolbar menu lists the flagged paragraphs and its title counts them; with every page drawn it has no scope note";
  const menu = await popupOver(page);
  await expect(async () => {
    const shown = await menuReport(menu);
    expect(shown?.title).toMatch(/^Flagged paragraphs \(\d+\/\d+\)$/);
    expect(shown.rows).toHaveLength(Number(shown.title.match(/\((\d+)\//)?.[1]));
    expect(shown.notes.join(" ")).not.toMatch(/Read \d+ of \d+ pages/);
  }, report).toPass({ timeout: 30_000 });
});

// On a web page three short paragraphs of one voice are read together and the chip says ×3;
// in a PDF they used to be dropped one by one. The rules are the same ones (lib/plan/group.ts),
// the reconstruction supplying the barriers: the three under the first heading are one unit,
// and the two under the second, 48 words with nothing of their section to join, are read by nobody.
test("short paragraphs under a heading are read as ONE unit: nothing crosses the heading, the chip says ×3 beside the text, the marks lie on all three", async ({ context, pdfs, nativeHost, storage }) => {
  await storage.set({ underlineScope: "all" });
  const mark = nativeHost.textMark();
  const page = await openPdfInReader(context, pdfs.url("/grouped.pdf"));
  await visitShortPdf(page);
  await readerSettles(page, 1);
  const grouped = await readReader(page);
  const one = "PDF reader: three short paragraphs under a heading are read as ONE unit, and nothing crosses the heading";
  expect.soft(nativeHost.textsSince(mark), one).toEqual([GROUPED_UNIT_TEXT]);
  const chip = "PDF reader: the grouped chip says ×3, sits inside its page and never over the text";
  expect.soft(await page.locator(`.anagramPdfChips ${BADGE_SEL} .num`).textContent(), chip).toMatch(/×3$/);
  expect.soft(grouped.placed.filter((c) => !c.inPage || c.overText), chip).toEqual([]);
  expect.soft(GROUPED_PARAS.slice(0, 3).filter((para) => !grouped.marked.some((t) => t.includes(para[0]))), "PDF reader: the marks lie on all three paragraphs of the group").toEqual([]);
});

// Upstream draws text and pixels near the viewport. Going to a distant page must draw it, and
// coming back must restore the recycled source mapping.
test("a thirty-page document: distant pages are not drawn ahead of time, are drawn when visited, and the first page's chips come back on return", async ({ context, pdfs }) => {
  const page = await openPdfInReader(context, pdfs.url("/tall.pdf"));
  await readerReady(page, { timeout: 30_000 });
  const far = await page.evaluate(() => {
    const last = document.querySelector('#viewer .page[data-page-number="30"]');
    return {
      pages: window.PDFViewerApplication.pdfDocument.numPages,
      textOnLast: !!last?.querySelector(".textLayer span"),
      drawn: [...document.querySelectorAll("#viewer .page canvas")].filter((c) => c.width > 0).length,
      lastDrawn: (last?.querySelector("canvas")?.width ?? 0) > 0,
    };
  });
  const lazy = `PDF reader: distant pages do not eagerly allocate text layers or canvases: ${JSON.stringify(far)}`;
  expect.soft({ pages: far.pages, textOnLast: far.textOnLast, lastDrawn: far.lastDrawn }, lazy).toEqual({ pages: 30, textOnLast: false, lastDrawn: false });
  expect.soft(far.drawn, lazy).toBeGreaterThan(0);
  expect.soft(far.drawn, lazy).toBeLessThanOrEqual(10);

  await visitPdfPage(page, 30);
  const last = await page.evaluate(() => ({ page: window.PDFViewerApplication.page, text: document.querySelector('#viewer .page[data-page-number="30"] .textLayer')?.textContent }));
  await visitPdfPage(page, 1);
  const restores = "PDF reader: page navigation renders distant text and restores annotations on return";
  await expect
    .poll(() => page.evaluate((sel) => [...document.querySelectorAll(`.anagramPdfChips ${sel}`)].some((el) => el.closest(".page")?.dataset.pageNumber === "1" && el.shadowRoot?.querySelector(".pill:not(.pending)")), BADGE_SEL), { message: restores })
    .toBe(true);
  // The marks of a page come back as it comes near the screen again (lib/render/highlight.ts).
  let returned;
  await expect.poll(async () => { returned = await readReader(page); return returned.marks; }, { message: restores }).toBeGreaterThan(0);
  expect.soft(last.page, restores).toBe(30);
  expect.soft(last.text, restores).toBeTruthy();
  expect.soft(returned.placed.some((c) => c.page === 1), restores).toBe(true);
});

// The viewer draws a few pages at a time and lets the rest go, and their units with them. The
// menu's report is the document read so far all the same — its counts, its list, the toolbar
// icon's number — and its list takes the reader back to a paragraph on a page let go.
test("a thirty-page document read to the end: the menu counts every page read, not the few still drawn, and its list goes back to a page let go", async ({ context, pdfs, extension }) => {
  const page = await openPdfInReader(context, pdfs.url("/tall.pdf"));
  await readerReady(page, { timeout: 30_000 });
  const scoredOn = (n) => page.evaluate(([sel, n]) => [...document.querySelectorAll(sel)].filter((h) => h.closest(".page")?.dataset.pageNumber === String(n) && h.shadowRoot?.querySelector(".pill.scored")).length, [BADGE_SEL, n]);
  for (let n = 1; n <= 30; n++) {
    await visitPdfPage(page, n);
    await expect.poll(() => scoredOn(n), { message: `page ${n} is read`, timeout: 15_000 }).toBeGreaterThan(0);
  }
  const drawn = await page.evaluate(() => [...document.querySelectorAll("#viewer .page .textLayer")].filter((t) => t.querySelector("span")).length);
  const keeps = "PDF reader: the menu's report keeps the pages the viewer let go";
  expect.soft(drawn, `${keeps} (most pages are let go by the end)`).toBeLessThan(15);
  const menu = await popupOver(page);
  let shown;
  await expect.poll(async () => { shown = await menuReport(menu); return shown?.bands.reduce((a, b) => a + b, 0) ?? 0; }, { message: keeps }).toBeGreaterThanOrEqual(30 * 2);
  // Every page read, the note that says how much of the document is goes (the last of the
  // background reading may still be landing).
  await expect.poll(async () => { shown = await menuReport(menu); return shown?.notes.join(" ") ?? ""; }, { message: `${keeps}: every page is read, so no scope note` })
    .not.toMatch(/Reading the whole document|of the document read|Covers the \d+ pages/);
  // The list and the icon are told apart, and a verdict read in the background can land
  // between the two readings: they agree once it has.
  const tabId = await page.evaluate(async () => (await chrome.tabs.getCurrent())?.id);
  let flagged = 0, badge = "";
  await expect.poll(async () => {
    shown = await menuReport(menu);
    flagged = Number(shown?.title?.match(/\((\d+)\//)?.[1] ?? 0);
    badge = await extension.sw.evaluate((tabId) => chrome.action.getBadgeText({ tabId }), tabId);
    return badge === (flagged > 0 ? String(flagged) : "");
  }, { message: `${keeps}: the toolbar icon counts what the list lists` }).toBe(true);
  test.skip(flagged === 0, "nothing flagged in this document under the fixture's scores: no row to follow");
  await menu.locator(".report-result").first().click();
  const back = "PDF reader: a row of the menu's list goes back to its page, which the viewer had let go";
  await expect.poll(() => page.evaluate(() => window.PDFViewerApplication.page), { message: back, timeout: 15_000 }).toBeLessThan(25);
});

// Reading on draws the next pages. Each one adds its own paragraphs and takes nothing down:
// the chips and marks of the pages still drawn stay where they are, with their verdicts. The
// quick reading only: Zotero's structure, landing whenever the worker is done, redraws the
// chips of a paragraph it reads otherwise, by design, and at a time no test can fix.
test("drawing the next pages leaves the chips already on screen in place", async ({ context, pdfs, storage }) => {
  await storage.set({ autoOpenPdfs: true, pdfStructure: false });
  const page = await context.newPage();
  await page.goto(pdfs.url("/tall.pdf"), { waitUntil: "load" }).catch(() => {});
  await readerReady(page, { timeout: 30_000 });
  const firstChips = () => page.evaluate((sel) => [...document.querySelectorAll(`.anagramPdfChips ${sel}`)]
    .filter((el) => el.closest(".page")?.dataset.pageNumber === "1" && el.shadowRoot?.querySelector(".pill:not(.pending)")).length, BADGE_SEL);
  await expect.poll(firstChips, { message: "page 1 is read" }).toBeGreaterThan(0);
  // All of page 1 read, not its first verdicts: nothing waiting there, and the count holding.
  const waiting = () => page.evaluate((sel) => [...document.querySelectorAll(`.anagramPdfChips ${sel}`)]
    .filter((el) => el.closest(".page")?.dataset.pageNumber === "1" && el.shadowRoot?.querySelector(".pill.pending")).length, BADGE_SEL);
  let before = -1;
  await expect.poll(async () => {
    const [now, pending] = [await firstChips(), await waiting()];
    const settled = pending === 0 && now === before;
    before = now;
    return settled;
  }, { message: "page 1 is read whole", intervals: [300] }).toBe(true);
  // Every chip host taken out of a page that is still drawn.
  await page.evaluate((sel) => {
    window.__takenDown = 0;
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.removedNodes) {
        const hosts = n instanceof Element ? (n.matches(sel) ? [n] : [...n.querySelectorAll(sel)]) : [];
        const drawn = r.target instanceof Element && r.target.closest(".page")?.querySelector(".textLayer span");
        if (drawn) window.__takenDown += hosts.length;
      }
    }).observe(document.getElementById("viewer"), { childList: true, subtree: true });
  }, BADGE_SEL);
  await visitPdfPage(page, 2);
  await visitPdfPage(page, 3);
  await visitPdfPage(page, 1);
  const kept = "PDF reader: a page that is drawn takes no chip off the pages already drawn";
  expect.soft(await page.evaluate(() => window.__takenDown), kept).toBe(0);
  expect.soft(await firstChips(), kept).toBe(before);
});

// The two ways a PDF refuses to be read, each said in one line; the scan is SHOWN rather
// than refused, its pages being the faithful thing to render.
test("PDF reader: a scan is still shown and says it has no text; a corrupt file says so instead", async ({ context, pdfs }) => {
  const stateOf = (page) =>
    page.evaluate(() => ({
      notice: document.getElementById("notice").textContent,
      pages: document.querySelectorAll(".page").length,
      drawn: [...document.querySelectorAll(".page canvas")].filter((c) => c.width > 0).length,
    }));
  const refuses = "PDF reader: a scan is still shown and says it has no text; a corrupt file says so instead";
  const scanned = await openPdfInReader(context, pdfs.url("/scanned.pdf"));
  await expect.poll(() => stateOf(scanned), { message: `${refuses} (the scan)` }).toEqual({ notice: "This PDF's pages are images, with no text to read.", pages: 1, drawn: 1 });
  const broken = await openPdfInReader(context, pdfs.url("/broken.pdf"));
  await expect.poll(() => stateOf(broken), { message: `${refuses} (the corrupt file)` }).toMatchObject({ notice: "This file could not be read as a PDF.", pages: 0 });
});

// Chrome wraps its viewer in an outer document that content scripts do run in, so the page
// itself offers Analyze PDF, in the toolbar menu. It asks the worker to swap the tab for the
// reader, which a content script cannot do itself.
test("PDF tab: the toolbar menu offers the page's Analyze PDF, and it swaps the tab for the reader", async ({ page, pdfs, extension }) => {
  await page.goto(pdfs.url("/doc.pdf"), { waitUntil: "load" }).catch(() => {});
  const swap = "PDF tab: the toolbar menu offers the page's Analyze PDF, and it swaps the tab for the reader";
  expect(await page.evaluate(() => document.contentType), swap).toBe("application/pdf");
  expect(await pdfTabChip(page, { click: true }), swap).toBe("Analyze PDF");
  await page.waitForURL(/reader\.html/);
  expect(page.url(), swap).toMatch(new RegExp(`^${extension.url("reader.html").replace(/[.?]/g, "\\$&")}\\?src=`));
  expect(new URL(page.url()).searchParams.get("src"), swap).toBe(pdfs.url("/doc.pdf"));
});

// The reader opened with no source takes a file, and the document it shows is scored like any
// other: the only way in for a file:// PDF when the user has not allowed file access.
test("PDF reader: with no source it offers a drop zone, and a chosen file is shown and scored", async ({ page, extension }) => {
  await page.goto(extension.url("reader.html"), { waitUntil: "load" });
  const drop = "PDF reader: with no source it offers a drop zone, and a chosen file is shown and scored";
  await expect(page.locator("#drop"), drop).toBeVisible();
  expect(await page.evaluate(() => !!window.PDFViewerApplication.pdfDocument), drop).toBe(false);
  await page.setInputFiles("#file", { name: "dropped.pdf", mimeType: "application/pdf", buffer: TEST_PDF });
  await visitShortPdf(page);
  await readerSettles(page, 3);
  await expect(page.locator("#drop"), drop).toBeHidden();
  expect(await page.evaluate(() => ({ pages: document.querySelectorAll(".page").length, title: document.title })), drop).toEqual({ pages: 2, title: "dropped.pdf" });
});

// The document the reader is given last owns the view from the moment it is given: a
// thirty-page book still parsing when a two-page note replaced it must not come back and take
// the pages, the title or an error line with it. Nothing used to own a load, and nothing could
// be cancelled.
test("PDF reader: the document asked for last is the one on screen, whichever finishes first", async ({ context, extension }) => {
  const big = { name: "book.pdf", mimeType: "application/pdf", buffer: TALL_PDF };
  const small = { name: "note.pdf", mimeType: "application/pdf", buffer: TEST_PDF };
  const shown = (page) =>
    page.evaluate(() => ({
      title: document.title,
      pages: document.querySelectorAll(".page").length,
      notice: document.getElementById("notice").textContent,
      reading: !window.PDFViewerApplication.pdfDocument,
    }));
  const reader = async () => {
    const page = await context.newPage();
    await page.goto(extension.url("reader.html"), { waitUntil: "load" });
    await expect(page.locator("#drop")).toBeVisible();
    return page;
  };
  const last = "PDF reader: the document asked for last is the one on screen, whichever finishes first";
  // How long the book takes to open here, now: the loser below is given twice that to lose.
  const alone = await reader();
  const t0 = Date.now();
  await alone.setInputFiles("#file", big);
  await expect.poll(() => shown(alone), { message: "the book opens alone" }).toEqual({ title: "book.pdf", pages: 30, notice: "", reading: false });
  const bookMs = Date.now() - t0;
  await alone.close();

  // The one that matters: the slow one asked for FIRST, so it finishes LAST.
  const slowFirst = await reader();
  await slowFirst.setInputFiles("#file", big);
  await slowFirst.setInputFiles("#file", small);
  await expect.poll(() => shown(slowFirst), { message: `${last} (the note, asked for last)` }).toEqual({ title: "note.pdf", pages: 2, notice: "", reading: false });
  await slowFirst.waitForTimeout(Math.max(ABSENCE_MS, 2 * bookMs)); // the book would have finished by now
  expect(await shown(slowFirst), `${last} (the book never comes back)`).toEqual({ title: "note.pdf", pages: 2, notice: "", reading: false });

  const slowSecond = await reader();
  await slowSecond.setInputFiles("#file", small);
  await slowSecond.setInputFiles("#file", big);
  await expect.poll(() => shown(slowSecond), { message: `${last} (the book, asked for last)` }).toEqual({ title: "book.pdf", pages: 30, notice: "", reading: false });
});
