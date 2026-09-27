// The PDF reader: a real PDF handed to the full PDF.js viewer and shown as it is, with the
// ORDINARY pipeline over it (the same chips, underlines, ball, panel and copied report). The
// reconstruction is invisible and is only asserted through what it decides: what reaches the
// host, and where a chip lands. Then short paragraphs grouped under a heading, a thirty-page
// document, a scan and a corrupt file, the way in from a tab showing a PDF, the drop zone,
// and two documents asked for one after the other.
//
//   npx playwright test scenarios-pdf
import { test as base, expect, BADGE_SEL, ABSENCE_MS, toggleCounter } from "./kit.mjs";
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

test("a PDF in the reader: its paragraphs read as written, drawn with a text layer, one chip each beside the text, marks on their glyphs, zoom from the cache, the panel and the report", async ({ page, pdfs, nativeHost, report }) => {
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
  const zoomed = await readReader(page);
  const zoom = "PDF reader: zoom restores chips and mapped marks without requesting the same scores again";
  expect.soft(zoomed.scale, zoom).toBeGreaterThan(read.scale);
  expect.soft({ chips: zoomed.chips, marks: zoomed.marks }, zoom).toEqual({ chips: read.chips, marks: read.marks });
  expect.soft(zoomed.placed.filter((c) => !c.inPage || c.overText), zoom).toEqual([]);
  expect.soft(nativeHost.stats.requests, zoom).toBe(requestsBefore);

  // The report must name the PDF by its scope note, not by the chrome-extension:// address it
  // is rendered on. PDF.js is still re-drawing after the zoom, and the reader re-reads each
  // page it re-draws: the panel is drawn when it opens and the report when it is copied, so
  // the two are compared once they agree, the panel reopened each time.
  const panel = "PDF reader: the panel lists the flagged paragraphs and Copy report carries the scope note";
  await expect(async () => {
    const open = await page.evaluate(() => !!document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".panel.open"));
    if (open) await toggleCounter(page);
    await toggleCounter(page);
    const items = await page.locator("#anagram-fab .panel.open .pitem").count();
    const text = await report(page);
    expect(text).toMatch(/^# Anagram analysis report/);
    expect(items).toBe(Number(text.match(/· Flagged: (\d+)/)?.[1]));
    // Reports omit titles and URLs unless the user opts in: the PDF is named by its scope note.
    expect(text).toContain("not a complete document assessment");
  }, panel).toPass({ timeout: 30_000 });
});

// On a web page three short paragraphs of one voice are read together and the chip says ×3;
// in a PDF they used to be dropped one by one. The rules are the same ones (lib/plan/group.ts),
// the reconstruction supplying the barriers: the three under the first heading are one unit,
// and the two under the second, 48 words with nothing of their section to join, are read by nobody.
test("short paragraphs under a heading are read as ONE unit: nothing crosses the heading, the chip says ×3 beside the text, the marks lie on all three", async ({ context, pdfs, nativeHost }) => {
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
  const returned = await readReader(page);
  expect.soft(last.page, restores).toBe(30);
  expect.soft(last.text, restores).toBeTruthy();
  expect.soft(returned.placed.some((c) => c.page === 1), restores).toBe(true);
  expect.soft(returned.marks, restores).toBeGreaterThan(0);
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
  await expect.poll(() => stateOf(scanned), { message: `${refuses} (the scan)` }).toEqual({ notice: "This PDF has no text layer.", pages: 1, drawn: 1 });
  const broken = await openPdfInReader(context, pdfs.url("/broken.pdf"));
  await expect.poll(() => stateOf(broken), { message: `${refuses} (the corrupt file)` }).toMatchObject({ notice: "This file could not be read as a PDF.", pages: 0 });
});

// Chrome wraps its viewer in an outer document that content scripts do run in, so the ball is
// there, and it has to be ABOVE the plugin's own chrome. The chip asks the worker to swap the
// tab for the reader, which a content script cannot do itself.
test("PDF tab: the ball offers Analyze PDF above the viewer, and it swaps the tab for the reader", async ({ page, pdfs, extension }) => {
  await page.goto(pdfs.url("/doc.pdf"), { waitUntil: "load" }).catch(() => {});
  const swap = "PDF tab: the ball offers Analyze PDF above the viewer, and it swaps the tab for the reader";
  expect(await pdfTabChip(page), swap).toBe("Analyze PDF");
  await expect
    .poll(() => page.evaluate(() => {
      const host = document.getElementById("anagram-fab");
      const r = host.shadowRoot.querySelector(".action").getBoundingClientRect();
      return { contentType: document.contentType, onTop: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === host };
    }), { message: swap })
    .toEqual({ contentType: "application/pdf", onTop: true });
  await page.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".action").click());
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
