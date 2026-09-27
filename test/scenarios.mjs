// test/scenarios.mjs — the wide-net scenario matrix.
//
// Phase A (deterministic, local): what test/pw/scenarios-*.spec.mjs do not cover yet —
// the Docs overlay, the reading surfaces, the PDF reader and the engine dying.
//
// Phase B (live, soft): real-site sweep with per-site expectations — HF paper
// (the original bug), EN/AR/JA Wikipedia, MDN, paulgraham, arXiv, StackOverflow,
// GitHub, a text/plain RFC, and zero-badge aggregator pages. A site that fails
// to LOAD is SKIP (network flake), but a loaded site violating its expectation
// is FAIL. Only console errors originating from the extension count against us.
//
//   node test/scenarios.mjs            # full matrix
//   node test/scenarios.mjs --local    # phase A only
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { launchExtension, serveHtml, artifact, BADGE_SEL } from "./harness.mjs";
import { createNativeFixture } from "./fake-native.mjs";
import { docsReadingHtml } from "./fixtures/docs-reading.mjs";
import {
  GROUPED_PARAS,
  GROUPED_UNIT_TEXT,
  PDF_HEAD,
  PDF_HEADING,
  PDF_PARAS,
  TEST_PDF,
  TALL_PDF,
  servePdfs,
  openPdfInReader,
  handOverPdf,
} from "./pdf-fixture.mjs";
import { surfaceScenarios } from "./scenario-surfaces.mjs";
import { crashScenarios } from "./scenario-crash.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_ONLY = process.argv.includes("--local");

const results = []; // { phase, name, status: PASS|FAIL|SKIP, note }
const record = (phase, name, ok, note = "") =>
  results.push({ phase, name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note });

// ---- the panel's Copy report -----------------------------------------------------------
// The report is built before it is written — its paragraph links alone may take 1.5 s
// (lib/render/textFragment.ts) — so the clipboard is read once it holds something else
// than the sentinel put there first, never after a fixed pause.
const NO_REPORT = "NO REPORT COPIED";
const clearClipboard = (p) => p.evaluate((s) => navigator.clipboard.writeText(s).catch(() => {}), NO_REPORT);
const readCopiedReport = (p, { timeout = 10000 } = {}) =>
  p.evaluate(async ({ sentinel, timeout }) => {
    const end = Date.now() + timeout;
    for (;;) {
      const text = await navigator.clipboard.readText().catch(() => null);
      if ((text && text !== sentinel) || Date.now() > end) return text;
      await new Promise((r) => setTimeout(r, 100));
    }
  }, { sentinel: NO_REPORT, timeout }).catch(() => null);

// ---- fake fixture (deterministic verdicts) + server for the fixture page -------------
let fixture = await createNativeFixture();

const PARA = (tag) => `${tag} paragraph is long enough to be scored on its own because it carries well over seventy-five ordinary English words describing nothing in particular except the fact that a self-rewriting page must still end up with chips after it replaces its own document element, which is what legacy challenge pages and some old single-page frameworks do, and the extension then has to find the new document, walk it again from the top and read every paragraph in it as if the page had only just loaded.`;
const PAGES = {
  "/ui-fixtures.html": readFileSync(join(__dirname, "ui-fixtures.html"), "utf8"),
};
const server = await serveHtml(PAGES);
const fixturesUrl = server.url("/ui-fixtures.html");

// The reader fetches BYTES, so the PDFs are served by a server of their own (the same
// helper the Firefox suite uses, so both open the same document).
const fileServer = await servePdfs();
const fileUrl = fileServer.url;

const { context, sw } = await launchExtension({ nativeFixture: fixture });
await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
console.log("extension SW:", sw ? "loaded" : "NOT loaded", "· fake fixture at", fixture.label);

async function sweep(page, steps = 6) {
  await page
    .evaluate(async (n) => {
      const step = Math.round(window.innerHeight * 0.8);
      for (let i = 0; i < n; i++) {
        window.scrollBy(0, step);
        await new Promise((r) => setTimeout(r, 300));
      }
      window.scrollTo(0, 0);
    }, steps)
    .catch(() => {});
}

// =====================================================================================
// PHASE A — deterministic UI fixtures
// =====================================================================================
{
  // A29: the Google Docs reading overlay refreshes in place. The overlay shows a
  // snapshot of the document, so its Refresh button reads the static view again and
  // swaps the paper's content: the old paragraphs leave with their chips, the new ones
  // arrive and are analyzed, and none of the overlay's own chrome is rebuilt. A failed
  // re-read must leave the snapshot on screen and give the button back. docs.google.com
  // is served locally here — a real document needs an account, and nothing in this
  // check is about Google's own markup.
  {
    const DOC = "ANAGRAMREFRESHFIXTURE";
    const EDITOR = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Refresh fixture - Google Docs</title></head>
<body><canvas width="600" height="400"></canvas></body></html>`;
    const mobilebasic = (v) => docsReadingHtml([PARA(`DOCVERSION${v}ONE`), PARA(`DOCVERSION${v}TWO`)], v);
    let version = 1;
    let broken = false;
    await context.route("https://docs.google.com/**", (route) => {
      const isStatic = route.request().url().includes("/mobilebasic");
      if (isStatic && broken) return route.fulfill({ status: 500, contentType: "text/html", body: "no" });
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: isStatic ? mobilebasic(version) : EDITOR,
      });
    });

    const readOverlay = (page) =>
      page.evaluate((sel) => {
        const sr = document.getElementById("anagram-docs-overlay")?.shadowRoot;
        const paper = sr?.querySelector(".paper");
        const refresh = sr?.querySelector("#anagram-ovl-refresh");
        return {
          hosts: document.querySelectorAll("#anagram-docs-overlay").length,
          bars: sr ? sr.querySelectorAll(".bar").length : 0,
          // The bar and the notice carry the marker attribute too — only the paper's
          // own hosts are chips.
          chips: paper ? paper.querySelectorAll(sel).length : 0,
          v1: !!paper?.textContent.includes("DOCVERSION1"),
          v2: !!paper?.textContent.includes("DOCVERSION2"),
          title: sr?.querySelector(".bar .t")?.textContent ?? "",
          refreshable: refresh ? !refresh.disabled : false,
        };
      }, BADGE_SEL);
    const chipped = (page, marker) =>
      page.waitForFunction(
        ([sel, want]) => {
          const paper = document.getElementById("anagram-docs-overlay")?.shadowRoot?.querySelector(".paper");
          return !!paper && paper.textContent.includes(want) && paper.querySelectorAll(sel).length >= 2;
        },
        [BADGE_SEL, marker],
        { timeout: 25000 },
      ).then(() => true).catch(() => false);

    const doc = await context.newPage();
    await doc.goto(`https://docs.google.com/document/d/${DOC}/edit`, { waitUntil: "load" });
    const clickFab = () =>
      doc.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector("#anagram-action")?.click());
    await doc
      .waitForFunction(
        () => document.getElementById("anagram-fab")?.shadowRoot?.querySelector("#anagram-action")?.textContent === "Analyze document",
        null,
        { timeout: 20000 },
      )
      .catch(() => {});
    await clickFab();
    const opened = await chipped(doc, "DOCVERSION1");
    const before = await readOverlay(doc);

    version = 2;
    await doc.evaluate(() =>
      document.getElementById("anagram-docs-overlay")?.shadowRoot?.querySelector("#anagram-ovl-refresh")?.click(),
    );
    const swapped = await chipped(doc, "DOCVERSION2");
    await doc.waitForTimeout(1500);
    const after = await readOverlay(doc);

    broken = true;
    await doc.evaluate(() =>
      document.getElementById("anagram-docs-overlay")?.shadowRoot?.querySelector("#anagram-ovl-refresh")?.click(),
    );
    await doc.waitForTimeout(2500);
    const failed = await readOverlay(doc);
    await doc.screenshot({ path: artifact("scn-docs-refresh.png") }).catch(() => {});
    await doc.close();
    await context.unroute("https://docs.google.com/**");

    record(
      "ui",
      "the Docs reading overlay re-reads the document in place",
      opened && swapped && before.v1 && before.chips === 2 &&
        after.v2 && !after.v1 && after.chips === 2 && after.hosts === 1 && after.bars === 1 &&
        after.title.includes("v2") && after.refreshable,
      JSON.stringify({ before, after }),
    );
    record(
      "ui",
      "a failed re-read leaves the snapshot on screen",
      failed.v2 && !failed.v1 && failed.chips === 2 && failed.hosts === 1 && failed.refreshable,
      JSON.stringify(failed),
    );
  }
  // Reading surfaces: Google Drive's preview read in place, and an ordinary page left alone.
  await surfaceScenarios({ context, fixture, record, artifact, BADGE_SEL, fixturesDir: join(__dirname, "fixtures"), ordinaryUrl: fixturesUrl });

  // A30–A34: a real PDF is handed to the full PDF.js viewer and shown as-is, with the
  // ORDINARY pipeline over them: the same chips, the same underlines, the same ball and
  // panel, the same copied report. The reconstruction is invisible and is only asserted
  // through what it decides: what reaches the fixture, and where a chip lands.
  const extId = sw ? new URL(sw.url()).host : null;
  /** Use the normal source-tab handoff, including the source permission/ticket checks. */
  const openReader = (path) => openPdfInReader(context, fileUrl(path));
  const readerReady = (page) => page.waitForFunction(
    () => !!window.PDFViewerApplication?.pdfDocument && !!document.querySelector("#viewer .textLayer span"),
    null, { timeout: 30000 },
  );
  // The upstream viewer scrolls its own container and materializes nearby text layers.
  const visitPdfPage = async (page, number) => {
    await page.locator("#pageNumber").fill(String(number));
    await page.locator("#pageNumber").press("Enter");
    await page.waitForFunction((n) => window.PDFViewerApplication.page === n &&
      window.PDFViewerApplication.pdfViewer.getPageView(n - 1)?.renderingState === 3 &&
      !!document.querySelector(`#viewer .page[data-page-number="${n}"] .textLayer span`),
      number, { timeout: 30000 });
  };
  const visitShortPdf = async (page) => {
    await readerReady(page);
    const count = await page.evaluate(() => window.PDFViewerApplication.pdfDocument.numPages);
    for (let number = 1; number <= count; number++) await visitPdfPage(page, number);
    await visitPdfPage(page, 1);
  };

  /** Everything about the reader page that a check below reads, in one pass. */
  const readReader = (p) =>
    p.evaluate((sel) => {
      const chips = [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill"));
      const spans = [...document.querySelectorAll(".textLayer span")];
      const rects = spans.map((s) => s.getBoundingClientRect());
      const placed = chips.map((h) => {
        const r = h.getBoundingClientRect();
        const box = h.closest(".page").getBoundingClientRect();
        return {
          page: Number(h.closest(".page").dataset.pageNumber),
          inPage:
            r.left >= box.left - 1 && r.right <= box.right + 1 &&
            r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
          // Half a pixel of tolerance: a chip that ends exactly where a span begins is
          // beside the text, not over it.
          overText: rects.some(
            (s) => s.width > 0 && r.left < s.right - 0.5 && s.left + 0.5 < r.right &&
                   r.top < s.bottom - 0.5 && s.top + 0.5 < r.bottom,
          ),
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
        notice: document.getElementById("notice").textContent,
      };
    }, BADGE_SEL);

  if (extId) {
    const p = await context.newPage();
    const extErrors = [];
    p.on("console", (m) => {
      // Only what OUR page said. The tab starts on the PDF itself, and the browser's own
      // viewer asking the fixture server for a favicon it does not serve is not our news.
      if (m.type() === "error" && (m.location()?.url ?? "").startsWith("chrome-extension://")) {
        extErrors.push(m.text().slice(0, 140));
      }
    });
    const mark = fixture.textMark(); // what THIS document sends, not the whole run
    await p.goto(fileUrl("/doc.pdf"), { waitUntil: "load" }).catch(() => {});
    await handOverPdf(p);
    await visitShortPdf(p);
    // The reader's own chrome (the bar, the notice, the pages) carries the same
    // data-anagram marker as a badge host, so a chip here is a host with a pill in it.
    await p
      .waitForFunction((sel) => {
        const pills = [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill"));
        return pills.length >= 3 && !pills.some((h) => h.shadowRoot.querySelector(".pill.pending"));
      }, BADGE_SEL, { timeout: 20000 })
      .catch(() => {});

    const page = await readReader(p);
    const sent = fixture.textsSince(mark);
    const first = PDF_PARAS[0].join(" "), last = PDF_PARAS[3].join(" ");
    const continuation = PDF_PARAS[1].join(" ").replace("hyphen- ation", "hyphenation").replace("state-of-the- art", "state-of-the-art");
    const tail = PDF_PARAS[2].join(" ");
    // A rendered page may be scored before its neighbor arrives. Only these exact
    // source-derived units are valid; the final map must include the joined paragraph.
    const allowed = new Set([first, continuation, tail, `${continuation} ${tail}`, last]);

    record(
      "ui",
      "PDF reader: rendered paragraphs reach the fixture and adjacent pages join without invented text",
      sent.includes(first) && sent.includes(last) && sent.includes(`${continuation} ${tail}`) &&
        sent.every((text) => allowed.has(text)),
      JSON.stringify({ sent: sent.map((t) => t.slice(0, 32)) }),
    );
    record(
      "ui",
      "PDF reader: the running head and the page numbers never leave the page for the fixture",
      sent.every((t) => !t.includes(PDF_HEAD)) &&
        sent.every((t) => !/\s[12]\s/.test(t)) &&
        // …and they are still THERE, because the reader shows the document as it is.
        page.text.includes(PDF_HEAD),
      JSON.stringify({ inSent: sent.some((t) => t.includes(PDF_HEAD)), onPage: page.text.includes(PDF_HEAD) }),
    );
    record(
      "ui",
      "PDF reader: a broken word is mended and a real compound keeps its hyphen",
      sent.join(" ").includes("hyphenation mark is joined") &&
        !sent.join(" ").includes("hyphen- ation") &&
        sent.join(" ").includes("compound such as state-of-the-art keeps"),
      JSON.stringify({ sample: sent[1]?.slice(60, 210) }),
    );
    record(
      "ui",
      "PDF reader: the real pages are drawn, with a selectable text layer over every one",
      page.pages === 2 &&
        page.drawn === 2 &&
        page.spans > 0 &&
        PDF_PARAS.every((lines) => page.text.includes(lines[0])) &&
        page.text.includes(PDF_HEADING) &&
        page.title === "doc.pdf" &&
        extErrors.length === 0,
      JSON.stringify({ pages: page.pages, drawn: page.drawn, spans: page.spans, errors: extErrors.slice(0, 2) }),
    );
    record(
      "ui",
      "PDF reader: one chip per scored paragraph, inside its page and never over the text",
      page.chips === 3 &&
        page.placed.every((c) => c.inPage) &&
        page.placed.every((c) => !c.overText),
      JSON.stringify({ chips: page.chips, placed: page.placed }),
    );
    record(
      "ui",
      "PDF reader: the marks lie on the paragraph's own glyphs, not on the whole page",
      page.marks >= 20 &&
        page.marked.some((t) => t.startsWith("Anagram rebuilds this document")) &&
        page.marked.every((t) => !t.includes(PDF_HEAD)),
      JSON.stringify({ marks: page.marks, first: page.marked[0]?.slice(0, 40) }),
    );

    // Upstream may replace text nodes on zoom. Anagram must restore mapping and use cached scores.
    const requestsBefore = fixture.stats.requests;
    await p.locator("#zoomInButton").click();
    await visitShortPdf(p);
    await p.waitForFunction((sel) => [...document.querySelectorAll(sel)].filter((host) =>
      host.shadowRoot?.querySelector(".pill:not(.pending)")).length === 3, BADGE_SEL, { timeout: 15000 });
    const zoomed = await readReader(p);
    record(
      "ui",
      "PDF reader: zoom restores chips and mapped marks without requesting the same scores again",
      zoomed.scale > page.scale && zoomed.chips === page.chips &&
        zoomed.marks === page.marks &&
        zoomed.placed.every((c) => c.inPage && !c.overText) &&
        fixture.stats.requests === requestsBefore,
      JSON.stringify({ from: page.scale.toFixed(2), to: zoomed.scale.toFixed(2), chips: zoomed.chips, marks: zoomed.marks }),
    );

    // The ball, its panel, and the report — the report must name the PDF, not the
    // chrome-extension:// address of the page it happens to be rendered on.
    // PDF.js is still re-rendering pages after the zoom above, and the reader re-reads each
    // page it re-renders: for a moment that page's paragraphs are waiting for their (cached)
    // verdicts again. The panel is drawn when it opens and the report when it is copied, so
    // the two are compared once the reader has settled — the panel reopened each time.
    let panel = { open: false, items: -1 };
    let report = null;
    let flagged;
    for (let attempt = 0; attempt < 10; attempt++) {
      await clearClipboard(p);
      panel = await p.evaluate(async () => {
        const sr = document.getElementById("anagram-fab")?.shadowRoot;
        const toggle = () => sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        if (sr?.querySelector(".panel.open")) {
          toggle();
          await new Promise((r) => setTimeout(r, 200));
        }
        toggle();
        await new Promise((r) => setTimeout(r, 400));
        sr?.querySelector(".pcopy")?.click();
        return { open: !!sr?.querySelector(".panel.open"), items: sr?.querySelectorAll(".pitem").length ?? -1 };
      });
      report = await readCopiedReport(p);
      flagged = (report ?? "").match(/· Flagged: (\d+)/)?.[1];
      if (panel.items === Number(flagged)) break;
      await p.waitForTimeout(500);
    }
    record(
      "ui",
      "PDF reader: the panel lists the flagged paragraphs and Copy report carries the scope note",
      panel.open &&
        panel.items === Number(flagged) &&
        typeof report === "string" &&
        // Reports omit titles and URLs unless the user opts in, so the PDF is named by its scope note only.
        report.startsWith("# Anagram analysis report") &&
        report.includes("not a complete document assessment"),
      JSON.stringify({ panel, flagged, head: (report ?? "").slice(0, 60) }),
    );
    await p.screenshot({ path: artifact("scn-pdf-reader.png"), fullPage: false }).catch(() => {});
    await p.close();
  }

  // A30b: the SHORT paragraphs of a paper. On a web page three short paragraphs of one
  // voice are read together and the chip says ×3; in a PDF they used to be dropped one by
  // one. The rules are now the same ones (lib/plan/group.ts), with the reconstruction
  // supplying the barriers — so the three under the first heading are one unit and the two
  // under the second, 48 words with nothing of their section to join, are read by nobody.
  if (extId) {
    const mark = fixture.textMark();
    const p = await openReader("/grouped.pdf");
    await visitShortPdf(p);
    await p
      .waitForFunction((sel) => {
        const pills = [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill"));
        return pills.length >= 1 && !pills.some((h) => h.shadowRoot.querySelector(".pill.pending"));
      }, BADGE_SEL, { timeout: 20000 })
      .catch(() => {});
    const grouped = await readReader(p);
    const groupedSent = fixture.textsSince(mark);
    const chipNum = await p.evaluate((sel) => {
      const host = [...document.querySelectorAll(sel)].find((h) => h.shadowRoot?.querySelector(".pill"));
      return host?.shadowRoot.querySelector(".num")?.textContent ?? null;
    }, BADGE_SEL);
    record(
      "ui",
      "PDF reader: three short paragraphs under a heading are read as ONE unit, and nothing crosses the heading",
      groupedSent.length === 1 && groupedSent[0] === GROUPED_UNIT_TEXT,
      JSON.stringify({ sent: groupedSent.map((t) => t.slice(0, 48)) }),
    );
    record(
      "ui",
      "PDF reader: the grouped chip says ×3, sits inside its page and never over the text",
      grouped.chips === 1 &&
        /×3$/.test(chipNum ?? "") &&
        grouped.placed.every((c) => c.inPage && !c.overText),
      JSON.stringify({ chips: grouped.chips, chipNum, placed: grouped.placed }),
    );
    record(
      "ui",
      "PDF reader: the marks lie on all three paragraphs of the group",
      GROUPED_PARAS.slice(0, 3).every((para) => grouped.marked.some((t) => t.includes(para[0]))),
      JSON.stringify({ marks: grouped.marks, marked: grouped.marked.slice(0, 4).map((t) => t.slice(0, 32)) }),
    );
    await p.close();
  }

  // A31: upstream materializes text and pixels near the viewport. Navigating to a
  // distant page must render it, and returning must restore recycled source mapping.
  if (extId) {
    const p = await openReader("/tall.pdf");
    await readerReady(p);
    const far = await p.evaluate(() => {
      const last = document.querySelector('#viewer .page[data-page-number="30"]');
      return {
        pages: window.PDFViewerApplication.pdfDocument.numPages,
        textOnLast: !!last?.querySelector(".textLayer span"),
        drawn: [...document.querySelectorAll("#viewer .page canvas")].filter((c) => c.width > 0).length,
        lastDrawn: (last?.querySelector("canvas")?.width ?? 0) > 0,
      };
    });
    await visitPdfPage(p, 30);
    const last = await p.evaluate(() => ({
      page: window.PDFViewerApplication.page,
      text: document.querySelector('#viewer .page[data-page-number="30"] .textLayer')?.textContent,
    }));
    await visitPdfPage(p, 1);
    await p.waitForFunction(() => [...document.querySelectorAll('.anagramPdfChips [data-anagram="host"]')]
      .some((el) => el.closest('.page')?.dataset.pageNumber === "1" && el.shadowRoot?.querySelector('.pill:not(.pending)')),
      null, { timeout: 20000 });
    const returned = await readReader(p);
    record(
      "ui",
      "PDF reader: distant pages do not eagerly allocate text layers or canvases",
      far.pages === 30 && !far.textOnLast && !far.lastDrawn && far.drawn > 0 && far.drawn <= 10,
      JSON.stringify(far),
    );
    record(
      "ui",
      "PDF reader: page navigation renders distant text and restores annotations on return",
      last.page === 30 && !!last.text && returned.placed.some((chip) => chip.page === 1) && returned.marks > 0,
      JSON.stringify({ last: last.page, restoredChips: returned.chips, restoredMarks: returned.marks }),
    );
    await p.close();
  }

  // A32: the two ways a PDF refuses to be read, each said in one line — and the scan,
  // which is now SHOWN rather than refused: its pages are the faithful thing to render.
  if (extId) {
    const stateFor = async (path) => {
      const p = await openReader(path);
      const state = await p
        .waitForFunction(() => {
          const n = document.getElementById("notice").textContent.trim();
          return n !== "Loading…" && n !== "";
        }, null, { timeout: 15000 })
        .then(() =>
          p.evaluate(() => ({
            notice: document.getElementById("notice").textContent,
            pages: document.querySelectorAll(".page").length,
            drawn: [...document.querySelectorAll(".page canvas")].filter((c) => c.width > 0).length,
          })),
        )
        .catch(() => null);
      await p.close();
      return state;
    };
    const scanned = await stateFor("/scanned.pdf");
    const broken = await stateFor("/broken.pdf");
    record(
      "ui",
      "PDF reader: a scan is still shown and says it has no text; a corrupt file says so instead",
      scanned?.notice === "This PDF has no text layer." &&
        scanned.pages === 1 &&
        scanned.drawn === 1 &&
        broken?.notice === "This file could not be read as a PDF." &&
        broken.pages === 0,
      JSON.stringify({ scanned, broken }),
    );
  }

  // A33: a tab already showing a PDF. Chrome wraps its viewer in an outer document that
  // content scripts do run in, so the ball is there — and it is the ball that has to be
  // ABOVE the plugin's own chrome, or nothing about this way in works. The chip asks the
  // worker to swap the tab for the reader, which a content script cannot do itself.
  if (extId) {
    const p = await context.newPage();
    await p.goto(fileUrl("/doc.pdf"), { waitUntil: "load" }).catch(() => {});
    await p.waitForTimeout(3000);
    const chip = await p
      .evaluate(() => {
        const host = document.getElementById("anagram-fab");
        const el = host?.shadowRoot?.querySelector(".action");
        if (!el) return { contentType: document.contentType, label: null };
        const r = el.getBoundingClientRect();
        return {
          contentType: document.contentType,
          label: el.textContent,
          onTop: document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) === host,
        };
      })
      .catch(() => null);
    if (chip?.label) {
      await p.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".action").click());
      await p.waitForURL(/reader\.html/, { timeout: 10000 }).catch(() => {});
    }
    const landed = p.url();
    record(
      "ui",
      "PDF tab: the ball offers Analyze PDF above the viewer, and it swaps the tab for the reader",
      chip?.contentType === "application/pdf" &&
        chip.label === "Analyze PDF" &&
        chip.onTop === true &&
        landed.startsWith(`chrome-extension://${extId}/reader.html?src=`) &&
        new URL(landed).searchParams.get("src") === fileUrl("/doc.pdf"),
      JSON.stringify({ chip, landed: landed.slice(0, 70) }),
    );
    await p.close();
  }

  // A34: the drop zone — the reader opened with no source takes a file, and the document
  // it shows is scored like any other. This is also the only path a file:// PDF has when
  // the user has not allowed file access.
  if (extId) {
    const p = await context.newPage();
    await p.goto(`chrome-extension://${extId}/reader.html`, { waitUntil: "load" });
    await p.waitForSelector("#drop:not([hidden])");
    const empty = await p.evaluate(() => ({
      drop: !document.getElementById("drop").hidden,
      pages: !!window.PDFViewerApplication.pdfDocument,
    }));
    await p.setInputFiles("#file", { name: "dropped.pdf", mimeType: "application/pdf", buffer: TEST_PDF });
    await visitShortPdf(p);
    await p
      .waitForFunction((sel) => [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill:not(.pending)")).length >= 3, BADGE_SEL, { timeout: 20000 })
      .catch(() => {});
    const loaded = await p.evaluate((sel) => ({
      drop: !document.getElementById("drop").hidden,
      pages: document.querySelectorAll(".page").length,
      chips: [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill")).length,
      title: document.title,
    }), BADGE_SEL);
    record(
      "ui",
      "PDF reader: with no source it offers a drop zone, and a chosen file is shown and scored",
      empty.drop && !empty.pages && !loaded.drop && loaded.pages === 2 && loaded.chips === 3 && loaded.title === "dropped.pdf",
      JSON.stringify({ empty, loaded }),
    );
    await p.close();
  }

  // A34b: TWO documents, one after the other, in both completion orders. The second one
  // the reader is given owns the view from the moment it is given — a thirty-page book
  // that was still parsing when a two-page note replaced it must not come back and take
  // the pages, the title or an error line with it. This is the defect the audit found:
  // nothing used to own a load and nothing could be cancelled.
  if (extId) {
    const race = async (first, second) => {
      const p = await context.newPage();
      await p.goto(`chrome-extension://${extId}/reader.html`, { waitUntil: "load" });
      await p.waitForSelector("#drop:not([hidden])");
      await p.setInputFiles("#file", first);
      await p.setInputFiles("#file", second);
      // Long enough that the LOSER would certainly have finished by now.
      await p.waitForTimeout(12000);
      const state = await p.evaluate(() => ({
        title: document.title,
        pages: document.querySelectorAll(".page").length,
        notice: document.getElementById("notice").textContent,
        reading: !window.PDFViewerApplication.pdfDocument,
      }));
      await p.close();
      return state;
    };
    const big = { name: "book.pdf", mimeType: "application/pdf", buffer: TALL_PDF };
    const small = { name: "note.pdf", mimeType: "application/pdf", buffer: TEST_PDF };
    // The one that matters: the slow one was asked for FIRST, so it finishes LAST.
    const slowFirst = await race(big, small);
    const slowSecond = await race(small, big);
    record(
      "ui",
      "PDF reader: the document asked for last is the one on screen, whichever finishes first",
      slowFirst.title === "note.pdf" && slowFirst.pages === 2 && slowFirst.notice === "" &&
        slowSecond.title === "book.pdf" && slowSecond.pages === 30 && slowSecond.notice === "",
      JSON.stringify({ slowFirst, slowSecond }),
    );
  }

}

// The engine dying under the pages' work, in a browser of its own (test/scenario-crash.mjs).
await crashScenarios({ record });

// =====================================================================================
// PHASE B — live sites (soft: unreachable → SKIP; loaded-but-wrong → FAIL)
// =====================================================================================
const LIVE = [
  // Two chips: the abstract's 65-word paragraph, under the 75-word floor, is read with the one before it.
  { name: "hf-paper", url: "https://huggingface.co/papers/2606.12385", min: 2, chromeMax: 0 },
  { name: "wiki-en", url: "https://en.wikipedia.org/wiki/Alan_Turing", min: 10, chromeMax: 0 },
  { name: "wiki-ar-rtl", url: "https://ar.wikipedia.org/wiki/%D8%A2%D9%84%D8%A7%D9%86_%D8%AA%D9%88%D8%B1%D9%86%D8%BA", min: 3 },
  { name: "wiki-ja-cjk", url: "https://ja.wikipedia.org/wiki/%E3%82%A2%E3%83%A9%E3%83%B3%E3%83%BB%E3%83%81%E3%83%A5%E3%83%BC%E3%83%AA%E3%83%B3%E3%82%B0", min: 3 },
  { name: "mdn", url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview", min: 5, chromeMax: 0 },
  { name: "paulgraham", url: "https://www.paulgraham.com/greatwork.html", min: 50 },
  { name: "arxiv-abs", url: "https://arxiv.org/abs/2301.10226", min: 1 },
  { name: "stackoverflow", url: "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array", min: 1, noPre: true },
  { name: "github-readme", url: "https://github.com/nodejs/node", min: 1, noPre: true },
  { name: "rfc-txt", url: "https://www.rfc-editor.org/rfc/rfc768.txt", min: 1 },
  { name: "samaltman-blog", url: "https://blog.samaltman.com/", min: 1 },
  { name: "hackernews-zero", url: "https://news.ycombinator.com/", max: 0 },
  { name: "bbc-near-zero", url: "https://www.bbc.com/news", max: 2 },
];

if (!LOCAL_ONLY) {
  for (const site of LIVE) {
    const page = await context.newPage();
    const extErrors = [];
    page.on("console", (m) => {
      const u = m.location()?.url ?? "";
      if (m.type() === "error" && u.startsWith("chrome-extension://") && !u.startsWith("chrome-extension://invalid"))
        extErrors.push(m.text().slice(0, 140));
    });
    let loaded = true;
    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch {
      loaded = false;
    }
    if (!loaded) {
      record("live", site.name, null, "goto failed — network/flake");
      await page.close();
      continue;
    }
    // Anti-bot interstitials (Cloudflare "Verifying you are human", "Just a moment…")
    // carry no prose; they say nothing about the extension.
    const botWall = await page
      .evaluate(() => /verifying you are human|just a moment|attention required|checking your browser/i.test(document.title + " " + (document.body?.innerText ?? "").slice(0, 600)))
      .catch(() => false);
    if (botWall) {
      record("live", site.name, null, "bot-check interstitial (Cloudflare) — not a page");
      await page.close();
      continue;
    }
    await page.waitForSelector(BADGE_SEL, { timeout: 10000 }).catch(() => {});
    // Lazy sections (HF community comments) need a patient sweep + settle.
    await sweep(page, 6);
    await page.waitForTimeout(3200);

    const stats = await page
      .evaluate((sel) => {
        const hosts = [...document.querySelectorAll(sel)];
        const anchors = hosts.map((h) => h.parentElement).filter(Boolean);
        let chrome = 0;
        let inPre = 0;
        for (const el of anchors) {
          if (el.closest("nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]")) chrome++;
          if (el.closest("pre")) inPre++;
        }
        return { badges: hosts.length, chrome, inPre, sample: (anchors[0]?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60) };
      }, BADGE_SEL)
      .catch(() => null);

    await page.screenshot({ path: artifact(`scn-${site.name}.png`) }).catch(() => {});
    if (!stats) {
      record("live", site.name, null, "evaluate failed");
      await page.close();
      continue;
    }

    let ok = true;
    const notes = [`badges=${stats.badges}`, `chrome=${stats.chrome}`];
    if (site.min !== undefined && stats.badges < site.min) ok = false;
    if (site.max !== undefined && stats.badges > site.max) ok = false;
    if (site.chromeMax !== undefined && stats.chrome > site.chromeMax) ok = false;
    if (site.noPre && stats.inPre > 0) { ok = false; notes.push(`inPre=${stats.inPre}`); }
    if (extErrors.length > 0) { ok = false; notes.push(`extErrors=${extErrors.length}`); }
    if (stats.sample) notes.push(`“${stats.sample}”`);
    record("live", site.name, ok, notes.join("  "));
    await page.close();
  }
}

// ---- summary -------------------------------------------------------------------------
await context.close();
await server.close();
await fileServer.close();
await fixture.close();

console.log("\n=== SCENARIO RESULTS ===");
for (const r of results) {
  console.log(`${r.status.padEnd(4)}  [${r.phase}]  ${r.name}${r.note ? `  —  ${r.note}` : ""}`);
}
const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
console.log(`\n${results.length - fails.length - skips.length} pass / ${fails.length} fail / ${skips.length} skip`);
console.log(fails.length === 0 ? "✅ SCENARIOS GREEN" : "❌ SCENARIO FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
