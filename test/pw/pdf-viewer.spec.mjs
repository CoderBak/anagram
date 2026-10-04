// The PDF reader: the unmodified upstream viewer, offline, on bytes the reader was handed,
// with Anagram's layer on it — and the source mapping that ties its marks to the glyphs.
//
//   npm run test:pdf-viewer           # builds output/ first; this loads the SHIPPING build
//   npx playwright test pdf-viewer --repeat-each 10      # hunting a flake
import { createHash } from "node:crypto";
import { readFileSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import { test, expect } from "./fixtures.mjs";
import { TEST_PDF, LOCKED_PDF, PDF_PASSWORD, TALL_PDF, PDF_CHIP, PDF_HEAD, PDF_HEADING, PDF_PARAS, buildPdf, buildTwoColumnPdf, pdfColumn, readerReady } from "../pdf-fixture.mjs";
import { BADGE_SEL, popupOver, menuReport } from "../harness.mjs";

const ROOT = join(import.meta.dirname, "..", "..");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const input = (name, buffer) => ({ name, mimeType: "application/pdf", buffer });
const chips = (page) =>
  page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((el) => el.shadowRoot?.querySelector(".pill")).length, PDF_CHIP);
/** Two frames: what a resize or a ResizeObserver changed has been laid out. */
const frames = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

// The shipping build, offline: nothing the viewer, its parser, fonts or locale files need
// may come from anywhere but the extension, and every test checks that at its end.
test.use({ build: "shipping", offline: true });

/** The reader with a document chosen from this computer; a `file=` query is never read. */
async function openReader(page, extId, file = input("offline.pdf", TEST_PDF)) {
  await page.goto(`chrome-extension://${extId}/reader.html?file=https://must-not-load.invalid/private.pdf`);
  await page.locator("#drop:not([hidden])").waitFor();
  expect(new URL(page.url()).searchParams.has("file")).toBe(false);
  await page.locator("#file").setInputFiles(file);
  await readerReady(page, { timeout: 20000 });
}

test("a chosen PDF opens offline in the full upstream viewer, byte for byte", async ({ page, extension }) => {
  await openReader(page, extension.extId);
  const features = await page.evaluate(() => {
    const app = window.PDFViewerApplication, options = window.PDFViewerApplicationOptions;
    return {
      pages: app.pdfDocument.numPages, find: !!app.findController, outline: !!app.pdfOutlineViewer,
      thumbs: !!app.pdfThumbnailViewer || !!app.viewsManager, print: app.supportsPrinting,
      scripting: options.get("enableScripting"), url: options.get("defaultUrl"), editor: options.get("annotationEditorMode"),
    };
  });
  expect(features).toEqual({ pages: 2, find: true, outline: true, thumbs: true, print: true, scripting: false, url: "", editor: -1 });
  const toolbar = await page.evaluate(() =>
    ["anagramAnalyze", "printButton", "downloadButton", "secondaryToolbarToggleButton"].map((id) => {
      const r = document.getElementById(id).getBoundingClientRect();
      return { id, visible: r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= innerWidth };
    }),
  );
  expect(toolbar.filter((button) => !button.visible), "toolbar controls outside the window").toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
  const bytes = await page.evaluate(async () => [...(await window.PDFViewerApplication.pdfDocument.getData())]);
  expect(digest(Buffer.from(bytes)), "rendering and analysis never rewrite the source bytes").toBe(digest(TEST_PDF));
});

test("the structure worker's reading marks the page's own glyphs, and the toolbar menu says what it covers", async ({ page, extension, storage }, testInfo) => {
  // Every paragraph read is underlined, so the marks are checked on all of them.
  await storage.set({ underlineScope: "all" });
  await openReader(page, extension.extId);
  await expect.poll(() => chips(page), { message: "chips on the reader's pages", timeout: 15000 }).toBeGreaterThan(0);
  // The worker's reading replaces the reflow's: the paragraphs the fixture set, the running
  // head and page number left out, the broken word mended, the paragraph sewn across the break.
  await page.waitForFunction(
    () => performance.getEntriesByName("anagram-structure").length > 0 && performance.getEntriesByName("anagram-structured").length > 0,
    null,
    { timeout: 60000 },
  );
  await expect.poll(() => chips(page), { timeout: 15000 }).toBeGreaterThanOrEqual(3);
  const marked = await page.evaluate(() => {
    const ranges = [];
    for (const [, highlight] of CSS.highlights) for (const range of highlight) {
      const box = range.getBoundingClientRect();
      ranges.push({ page: Number(range.startContainer.parentElement?.closest(".page")?.dataset.pageNumber), y: box.top, x: box.left, text: range.toString() });
    }
    ranges.sort((a, b) => a.page - b.page || a.y - b.y || a.x - b.x);
    const text = (n) => ranges.filter((r) => r.page === n).map((r) => r.text).join(" ").replace(/\s+/g, " ");
    return { page1: text(1), page2: text(2), all: ranges.map((r) => r.text) };
  });
  expect(marked.page1).toMatch(/Anagram rebuilds this document from the text runs .* That is the whole idea\./);
  expect(marked.page1, "the mended word is marked on both of its glyph runs").toMatch(/hyphen ation mark is joined again/);
  expect(marked.page2).toMatch(/that the paragraph is sewn back together across the page break/);
  expect(marked.page2).toMatch(/Running heads and page numbers are furniture/);
  expect(marked.all.filter((s) => s.includes("ANAGRAM TEST DOCUMENT")), "the running head is not marked").toEqual([]);
  expect(marked.all.filter((s) => /^\s*[12]\s*$/.test(s)), "the page number is not marked").toEqual([]);
  // The menu the reader's Anagram button opens reports the document; with both its pages drawn
  // it counts all of them and says nothing about scope.
  const menu = await popupOver(page);
  await expect.poll(async () => (await menuReport(menu))?.title, { message: "the toolbar menu's report" }).toMatch(/^Flagged paragraphs|^Nothing flagged/);
  expect((await menuReport(menu)).notes.join(" "), "no scope note over a document drawn whole").not.toMatch(/Read \d+ of \d+ pages/);
  await menu.close();
  await page.screenshot({ path: testInfo.outputPath("reading.png") });
});

test("find, zoom, rotation, download, print and thumbnails work with Anagram's layer on", async ({ page, extension }, testInfo) => {
  await page.addInitScript(() => {
    window.print = () => {
      window.__printSnapshot = [...document.querySelectorAll("#printContainer img")].map((image) => ({ width: image.naturalWidth, height: image.naturalHeight }));
    };
  });
  await openReader(page, extension.extId);
  await page.locator("#viewFindButton").click();
  await page.locator("#findInput").fill("paragraph");
  await page.locator('label[for="findHighlightAll"]').click();
  await page.waitForFunction(() => document.querySelectorAll(".textLayer .highlight").length > 0);
  await expect.poll(() => chips(page), { timeout: 15000 }).toBeGreaterThan(0);
  await page.locator(".anagramPdfChips .pill").first().hover();
  await page.locator("#scaleSelect").selectOption("1.5");
  await page.waitForFunction(() => window.PDFViewerApplication.pdfViewer.currentScale === 1.5);
  await page.locator("#secondaryToolbarToggleButton").click();
  await page.locator("#pageRotateCw").click();
  await page.waitForFunction(() => window.PDFViewerApplication.pdfViewer.pagesRotation === 90);
  const downloading = page.waitForEvent("download");
  await page.locator("#downloadButton").click();
  const saved = testInfo.outputPath("downloaded.pdf");
  await (await downloading).saveAs(saved);
  expect(digest(readFileSync(saved)), "the download is the document as it was chosen").toBe(digest(TEST_PDF));
  await page.locator("#printButton").click();
  await page.waitForFunction(() => window.__printSnapshot?.length === 2);
  expect(
    await page.evaluate(() => window.__printSnapshot.every((image) => image.width > 0 && image.height > 0)),
    "every page is rendered before the native print call",
  ).toBe(true);
  expect(await page.locator("#viewsManagerAddFilePicker").isVisible()).toBe(false);
  await page.locator("#viewsManagerToggleButton").click();
  await page.screenshot({ path: testInfo.outputPath("full-viewer.png") });
});

test("a file over the cap is refused, and the password dialog works offline", async ({ page, extension }, testInfo) => {
  await openReader(page, extension.extId);
  // Over the direct-file cap: refused before the open document is closed.
  const oversized = testInfo.outputPath("oversized.pdf");
  writeFileSync(oversized, "");
  truncateSync(oversized, 101 * 1024 * 1024);
  await page.locator("#file").setInputFiles(oversized);
  await expect(page.locator("#notice")).toHaveText("This PDF is too large to read here.");
  expect(await page.evaluate(() => ({ pages: window.PDFViewerApplication.pdfDocument?.numPages ?? 0, drop: !document.getElementById("drop").hidden }))).toEqual({ pages: 2, drop: false });

  // The upstream password dialog, a refused password included.
  await page.locator("#file").setInputFiles(input("locked.pdf", LOCKED_PDF));
  await page.locator("#passwordDialog[open]").waitFor();
  await page.locator("#password").fill("wrong");
  await page.locator("#passwordSubmit").click();
  await page.waitForFunction(() => document.querySelector("#passwordDialog")?.open && /invalid/i.test(document.querySelector("#passwordText")?.textContent ?? ""));
  await page.locator("#password").fill(PDF_PASSWORD);
  await page.locator("#passwordSubmit").click();
  await readerReady(page, { timeout: 20000 });
  expect(await page.locator("#passwordDialog").evaluate((el) => el.open)).toBe(false);

  // A new choice while a password is pending supersedes the old load and its dialog.
  await page.locator("#file").setInputFiles(input("pending-password.pdf", LOCKED_PDF));
  await page.locator("#passwordDialog[open]").waitFor();
  await page.locator("#file").setInputFiles(input("replacement.pdf", TEST_PDF));
  await readerReady(page, { timeout: 20000 });
  expect(await page.locator("#passwordDialog").evaluate((el) => el.open)).toBe(false);
  expect(await page.evaluate(() => window.PDFViewerApplication.pdfDocument.numPages)).toBe(2);
});

test("a long document builds only the text layers near the view, and rebuilds recycled ones", async ({ page, extension }) => {
  await openReader(page, extension.extId, input("long.pdf", TALL_PDF));
  const start = await page.evaluate(() => ({ pages: window.PDFViewerApplication.pdfDocument.numPages, layers: document.querySelectorAll("#viewer .textLayer").length }));
  expect(start.pages).toBe(30);
  expect(start.layers, "opening a long PDF does not build every text layer").toBeLessThan(10);
  for (const n of [30, 1]) {
    await page.locator("#pageNumber").fill(String(n));
    await page.locator("#pageNumber").press("Enter");
    await page.waitForFunction((n) => window.PDFViewerApplication.page === n && !!document.querySelector(`.page[data-page-number="${n}"] .textLayer span`), n);
  }
});

test("a document past the structure's page cap is read on every page, by the reflow", async ({ page, extension }) => {
  await openReader(page, extension.extId, input("book.pdf", buildTwoColumnPdf(305)));
  const onPage = (n) => page.evaluate(([n, sel]) => [...document.querySelectorAll(`.page[data-page-number="${n}"] ${sel}`)].filter((el) => el.shadowRoot?.querySelector(".pill")).length, [n, PDF_CHIP]);
  await expect.poll(() => onPage(1), { message: "chips on the first page", timeout: 20000 }).toBeGreaterThan(0);
  await page.locator("#pageNumber").fill("303");
  await page.locator("#pageNumber").press("Enter");
  await expect.poll(() => onPage(303), { message: "chips on page 303", timeout: 20000 }).toBeGreaterThan(0);
  expect(await page.locator("#notice").isVisible(), "no notice that pages go unread").toBe(false);
  expect(await page.evaluate(() => performance.getEntriesByName("anagram-structure").length), "no structure worker for it").toBe(0);
});

test("with the engine stopped, the viewer and its file picker still work", async ({ page, extension, nativeHost }) => {
  await nativeHost.close();
  await openReader(page, extension.extId, input("without-engine.pdf", TEST_PDF));
  expect(await page.evaluate(() => window.PDFViewerApplication.pdfDocument.numPages)).toBe(2);
  const refused = await page.evaluate(async () => {
    try {
      await window.PDFViewerApplication.open({ url: "https://must-not-load.invalid/b.pdf" });
      return false;
    } catch {
      return true;
    }
  });
  expect(refused, "the viewer refuses to open an address itself").toBe(true);
});

test("the reader's chrome fits a 400 px window, and its controls pass axe in dark mode", async ({ page, extension }, testInfo) => {
  await openReader(page, extension.extId);
  await page.locator("#viewFindButton").click(); // the find bar is the widest thing that can be open
  await page.setViewportSize({ width: 400, height: 900 });
  // The find bar re-wraps from a ResizeObserver, delivered after the frame's animation
  // callbacks: the second frame after the resize is the first that sees it.
  await frames(page);
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), "the page scrolls sideways").toBe(false);
  await page.emulateMedia({ colorScheme: "dark" });
  await page.evaluate(readFileSync(join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8"));
  const violations = await page.evaluate(async () =>
    (await axe.run({ include: [["#anagramAnalyze"], ["#analysisScope"]] }, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21aa"] } }))
      .violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
  );
  expect(violations, "WCAG AA violations on Anagram's reader controls").toEqual([]);
  await page.screenshot({ path: testInfo.outputPath("narrow-dark.png") });
});

test("source offsets survive nested search markup and page replacement", async ({ page }) => {
  const { outputFiles } = await build({ entryPoints: [join(ROOT, "lib/pdf/units.ts")], bundle: true, write: false, format: "iife", globalName: "PdfUnits" });
  await page.addScriptTag({ content: outputFiles[0].text });
  const result = await page.evaluate(() => {
    const text = "The paragraph carries enough words to be analyzed. ".repeat(10);
    const layer = document.createElement("div"), span = document.createElement("span");
    span.textContent = text;
    layer.append(span);
    document.body.append(layer);
    const source = PdfUnits.createPdfUnitSource();
    source.setPage(1, { layer, spans: [span] });
    source.setBlocks([{ kind: "paragraph", page: 1, text, runs: [{ page: 1, item: 0, at: 0, length: text.length, from: 0 }] }]);
    const [first] = source.collect(() => "take", false);
    const nested = document.createElement("span");
    nested.className = "highlight";
    nested.textContent = text.slice(4, 22);
    span.replaceChildren(document.createTextNode(text.slice(0, 4)), nested, document.createTextNode(text.slice(22)));
    const rangeText = source.ranges(first, [{ start: 2, end: 35 }])[0].map((range) => range.toString()).join("");
    const [second] = source.collect(() => "take", false);
    const nodesFresh = second.parts[0].nodes.every((node) => node.isConnected);
    layer.remove();
    source.removePage(1);
    const missing = source.collect(() => "take", false).length;
    document.body.append(layer);
    source.setPage(1, { layer, spans: [span] });
    const [third] = source.collect(() => "take", false);
    return { rangeText, expected: text.slice(2, 35), nodesFresh, missing, rebound: third.parts[0].nodes.every((node) => node.isConnected) };
  });
  expect(result.rangeText).toBe(result.expected);
  expect(result).toMatchObject({ nodesFresh: true, missing: 0, rebound: true });
});

// Overleaf previews the compiled PDF with pdf.js's own PDFViewer (pdfjs-dist, a text layer of
// transparent spans over each page's canvas), which its editor app builds once the project
// has compiled: after the content script has started. The page here is Overleaf's markup
// (services/web/frontend/js/features/pdf-preview/components/pdf-js-viewer.tsx) under its
// address, with pdf.js from the package; nothing reaches Overleaf. The test build grants
// every site, as the user's grant for overleaf.com would.
test.describe("a pdf.js viewer in a web page", () => {
test.use({ build: "test", offline: false });
test("Overleaf's PDF preview is read by the pdf.js surface, once its app has built the viewer", async ({ page, context, nativeHost }) => {
  const pdf = buildPdf([
    [
      { x: 72, y: 742, size: 9, text: PDF_HEAD },
      { x: 300, y: 50, size: 10, text: "1" },
      { x: 30, y: 250, size: 18, up: true, text: "arXiv:2609.00001v1 [cs.CL] 1 Sep 2026" },
      { x: 72, y: 700, size: 16, bold: true, text: PDF_HEADING },
      ...pdfColumn(PDF_PARAS[0], 670),
      ...pdfColumn(PDF_PARAS[1], 670 - PDF_PARAS[0].length * 14),
    ],
    [
      { x: 72, y: 742, size: 9, text: PDF_HEAD },
      { x: 300, y: 50, size: 10, text: "2" },
      ...pdfColumn(PDF_PARAS[2], 700),
      ...pdfColumn(PDF_PARAS[3], 700 - PDF_PARAS[2].length * 14 - 14),
    ],
  ]);
  const source = Array.from({ length: 12 }, (_, i) => `<div class="cm-line">\\paragraph{Line ${i}} This is the LaTeX source in the editor, which the preview beside it typesets for the reader.</div>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><title>Project - Overleaf</title><link rel="stylesheet" href="/pdfjs/web/pdf_viewer.css">
<style>body{margin:0;display:flex;height:100vh}.cm-editor{width:40%;overflow:auto}#pdf{width:60%;position:relative}.pdfjs-viewer,.pdfjs-viewer-inner{position:absolute;inset:0}.pdfjs-viewer-inner{overflow:auto}</style>
<div class="cm-editor"><div class="cm-content" contenteditable="true" role="textbox">${source}</div></div><div id="pdf"></div>
<script type="module">
  await new Promise((r) => setTimeout(r, 1000));
  const pdfjsLib = await import("/pdfjs/build/pdf.mjs");
  globalThis.pdfjsLib = pdfjsLib;
  pdfjsLib.GlobalWorkerOptions.workerSrc = "/pdfjs/build/pdf.worker.mjs";
  const { PDFViewer, EventBus, PDFLinkService } = await import("/pdfjs/web/pdf_viewer.mjs");
  document.getElementById("pdf").innerHTML = '<div class="pdfjs-viewer pdfjs-viewer-outer" tabindex="-1"><div class="pdfjs-viewer-inner" tabindex="0" role="tabpanel"><div class="pdfViewer"></div></div></div>';
  const eventBus = new EventBus(), linkService = new PDFLinkService({ eventBus });
  const viewer = new PDFViewer({ container: document.querySelector(".pdfjs-viewer-inner"), eventBus, linkService, annotationMode: pdfjsLib.AnnotationMode.ENABLE, annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE });
  linkService.setViewer(viewer);
  eventBus.on("pagesinit", () => { viewer.currentScaleValue = "page-width"; });
  const doc = await pdfjsLib.getDocument({ url: "/build/output.pdf", standardFontDataUrl: "/pdfjs/standard_fonts/" }).promise;
  viewer.setDocument(doc);
  linkService.setDocument(doc);
</script>`;
  const PDFJS = join(ROOT, "node_modules", "pdfjs-dist");
  await context.route("https://www.overleaf.com/**", (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === "/build/output.pdf") return route.fulfill({ contentType: "application/pdf", body: pdf });
    if (pathname.startsWith("/pdfjs/")) {
      const type = pathname.endsWith(".mjs") ? "text/javascript" : pathname.endsWith(".css") ? "text/css" : "application/octet-stream";
      return route.fulfill({ contentType: type, body: readFileSync(join(PDFJS, pathname.slice("/pdfjs/".length))) });
    }
    return route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
  });
  const mark = nativeHost.textMark();
  await page.setViewportSize({ width: 1300, height: 1000 });
  await page.goto("https://www.overleaf.com/project/64f0c0ffee0123456789abcd");
  const onPages = () => page.evaluate((sel) => document.querySelectorAll(`.page > [data-anagram] ${sel}`).length, BADGE_SEL);
  await expect.poll(onPages, { message: "chips over the preview's pages", timeout: 30000 }).toBeGreaterThanOrEqual(3);
  const drawn = await page.evaluate((sel) => ({
    inLayer: document.querySelectorAll(".textLayer [data-anagram]").length,
    inEditor: document.querySelectorAll(`.cm-editor ${sel}`).length,
  }), BADGE_SEL);
  expect(drawn, "nothing drawn inside pdf.js's text layer or on the editor").toEqual({ inLayer: 0, inEditor: 0 });
  const sent = nativeHost.textsSince(mark).map((t) => t.replace(/\s+/g, " "));
  expect(sent.some((t) => t.includes("broke across two lines with a hyphenation mark is joined again")), "the broken word mended").toBe(true);
  expect(sent.some((t) => t.includes("Running heads and page numbers are furniture")), "the second page read").toBe(true);
  // pdf.js has turned a run with `--rotate` since version 4, not with its transform: the stamp
  // up the margin is a rotated line, which is never part of a paragraph.
  const { outputFiles } = await build({ entryPoints: [join(ROOT, "lib/surfaces/pdfjs.ts")], bundle: true, write: false, format: "iife", globalName: "PdfjsSource" });
  await page.addScriptTag({ content: outputFiles[0].text });
  const stamp = await page.evaluate(() => {
    const [first] = PdfjsSource.createPdfjsSource(document).pages();
    const at = first.lines.findIndex((line) => line.textContent.startsWith("arXiv:"));
    return at < 0 ? null : first.boxes[at].rotated;
  });
  expect(stamp, "the stamp up the margin is read as rotated").toBe(true);
  expect(sent.filter((t) => t.includes("arXiv:") || t.includes(PDF_HEAD) || t.includes("LaTeX source")), "the stamp up the margin, the running head, the editor").toEqual([]);
});
});
