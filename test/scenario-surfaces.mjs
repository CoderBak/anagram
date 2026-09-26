// test/scenario-surfaces.mjs — the reading surfaces (lib/surfaces/) with the real extension,
// run by test/scenarios.mjs (phase A, local).
//
// The site's address is served from the surface's fixture (test/fixtures/surfaces/), the way
// the Docs checks serve docs.google.com: nothing here is about reaching Google, only about
// what the content script does once it is on such a page — loads the surface, reads the
// document, sends its paragraphs and draws on the page — and about what it leaves alone.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DRIVE } from "./unit-surfaces.mjs";

export async function surfaceScenarios({ context, fixture, record, artifact, BADGE_SEL, fixturesDir, ordinaryUrl }) {
  // Which pages asked for the chunk: the content script imports it by URL, which the browser
  // attributes to the page (once under the session's dynamic URL, once under the extension's).
  const chunkLoads = new Map();
  const onRequest = (req) => {
    if (!/\/vendor\/surfaces\.min\.mjs$/.test(new URL(req.url()).pathname)) return;
    const page = req.frame()?.page();
    if (page) chunkLoads.set(page, (chunkLoads.get(page) ?? 0) + 1);
  };
  context.on("request", onRequest);

  // S1: Google Drive's preview. Four units on the two loaded pages, a fifth when page 3
  // loads; what the engine is sent is the document's paragraphs, not the viewer's lines.
  {
    const html = readFileSync(join(fixturesDir, "surfaces", "drive-preview.html"), "utf8");
    await context.route("https://drive.google.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    const sentBefore = fixture.stats.texts.length;
    const page = await context.newPage();
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto("https://drive.google.com/file/d/ANAGRAMDRIVEFIXTURE/view", { waitUntil: "load" });
    const chipsOnPages = (n) =>
      page
        .waitForFunction(
          ([sel, want]) => document.querySelectorAll(`.kd-page > [data-anagram] > [data-chip] > ${sel}`).length >= want,
          [BADGE_SEL, n],
          { timeout: 25000 },
        )
        .then(() => true)
        .catch(() => false);
    const firstPages = await chipsOnPages(4);
    // Page 3 loads, as scrolling to it would.
    await page.evaluate(() => {
      const slot = document.querySelector('[data-page-slot="3"]');
      slot.replaceWith(document.getElementById("page-3").content.firstElementChild.cloneNode(true));
    });
    const thirdPage = await chipsOnPages(5);
    await page.waitForTimeout(800);
    const r = await page.evaluate((sel) => ({
      bars: document.querySelectorAll(".kd-page > [data-anagram] > div:not([hidden])").length,
      inLayer: document.querySelectorAll(`.kd-layer ${sel}`).length,
      chips: document.querySelectorAll(sel).length,
    }), BADGE_SEL);
    await page.screenshot({ path: artifact("scn-drive-preview.png") }).catch(() => {});
    // The engine is sent the model's form of a unit, one line break between paragraphs.
    const flat = (t) => t.replace(/\s+/g, " ");
    const sent = fixture.stats.texts.slice(sentBefore);
    const want = [DRIVE.p1, `${DRIVE.p2} ${DRIVE.p3}`, DRIVE.p4, DRIVE.p5, DRIVE.p6];
    const missing = want.filter((t) => !sent.some((s) => flat(s) === t)).map((t) => t.slice(0, 40));
    const lines = sent.filter((t) => t.includes("north-") || /show\s*\n\s*the stones/.test(t));
    record(
      "ui",
      "Google Drive preview: the document's paragraphs are read (lines joined, hyphens mended, pages sewn), chips and marks drawn over the page",
      firstPages && thirdPage && missing.length === 0 && lines.length === 0 && r.bars > 20 && r.chips === 5 && r.inLayer === 0 &&
        (chunkLoads.get(page) ?? 0) > 0,
      JSON.stringify({ firstPages, thirdPage, missing, lines: lines.length, ...r, chunk: chunkLoads.get(page) ?? 0 }),
    );
    await page.close();
    await context.unroute("https://drive.google.com/**");
  }

  // S2: a PDF in OneDrive's pdf.js preview. Its two columns and two pages are read as four
  // units in reading order, a hyphen mended, and nothing is drawn inside pdf.js's own layer.
  {
    const html = readFileSync(join(fixturesDir, "surfaces", "pdfjs-viewer.html"), "utf8");
    await context.route("https://onedrive.live.com/**", (route) =>
      route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }),
    );
    const sentBefore = fixture.stats.texts.length;
    const page = await context.newPage();
    await page.setViewportSize({ width: 1100, height: 900 });
    await page.goto("https://onedrive.live.com/?id=ANAGRAMPDFJSFIXTURE", { waitUntil: "load" });
    const chipped = await page
      .waitForFunction(
        (sel) => document.querySelectorAll(`.page > [data-anagram] > [data-chip] > ${sel}`).length >= 4,
        BADGE_SEL,
        { timeout: 25000 },
      )
      .then(() => true)
      .catch(() => false);
    await page.waitForTimeout(800);
    const r = await page.evaluate((sel) => ({
      bars: document.querySelectorAll(".page > [data-anagram] > div:not([hidden])").length,
      inLayer: document.querySelectorAll(`.textLayer ${sel}, .textLayer [data-anagram]`).length,
    }), BADGE_SEL);
    await page.screenshot({ path: artifact("scn-pdfjs-viewer.png") }).catch(() => {});
    const sent = fixture.stats.texts.slice(sentBefore);
    const mended = sent.some((t) => t.includes("notice what is different about each one"));
    const acrossColumns = sent.some((t) => t.includes("the boy who brought the supplies from the harbour"));
    const acrossPages = sent.some((t) => t.includes("by the afternoon boat. The new keeper"));
    record(
      "ui",
      "OneDrive's pdf.js preview: paragraphs read in reading order across columns and pages, chips and marks over the page",
      chipped && mended && acrossColumns && acrossPages && r.bars > 20 && r.inLayer === 0 && (chunkLoads.get(page) ?? 0) > 0,
      JSON.stringify({ chipped, mended, acrossColumns, acrossPages, ...r, sent: sent.length }),
    );
    await page.close();
    await context.unroute("https://onedrive.live.com/**");
  }

  // S3: an ordinary page never loads the chunk, and is read exactly as before.
  {
    const page = await context.newPage();
    await page.goto(ordinaryUrl, { waitUntil: "load" });
    const chipped = await page
      .waitForSelector(BADGE_SEL, { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    await page.waitForTimeout(500);
    record(
      "ui",
      "an ordinary page loads no surface: the chunk is never asked for and the page is walked as always",
      chipped && !chunkLoads.has(page),
      JSON.stringify({ chipped, chunk: chunkLoads.get(page) ?? 0 }),
    );
    await page.close();
  }

  context.off("request", onRequest);
}
