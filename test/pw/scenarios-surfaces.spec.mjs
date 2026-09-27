// Sites the walk cannot read: the Google Docs reading overlay refreshing in place, Google
// Drive's preview and a PDF in OneDrive's pdf.js preview read in place (lib/surfaces/), and an
// ordinary page that loads none of it. The sites' addresses are served from fixtures
// (test/fixtures/surfaces/, test/fixtures/docs-reading.mjs): nothing here is about reaching
// Google or Microsoft, only about what the content script does once it is on such a page.
//
//   npx playwright test scenarios-surfaces
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect, BADGE_SEL, PARA, settledChips } from "./kit.mjs";
import { docsReadingHtml } from "../fixtures/docs-reading.mjs";
import { DRIVE } from "../unit-surfaces.mjs";

const FIXTURES = join(import.meta.dirname, "..", "fixtures");

const test = base.extend({
  /** How many times each page asked for the surfaces chunk: the content script imports it by
   *  URL, which the browser attributes to the page. */
  chunkLoads: async ({ context }, use) => {
    const loads = new Map();
    const onRequest = (req) => {
      if (!/\/vendor\/surfaces\.min\.mjs$/.test(new URL(req.url()).pathname)) return;
      const page = req.frame()?.page();
      if (page) loads.set(page, (loads.get(page) ?? 0) + 1);
    };
    context.on("request", onRequest);
    await use(loads);
    context.off("request", onRequest);
  },
});

// The overlay shows a snapshot of the document, so its Refresh button reads the static view
// again and swaps the paper's content: the old paragraphs leave with their chips, the new ones
// arrive and are analyzed, and none of the overlay's own chrome is rebuilt. A failed re-read
// must leave the snapshot on screen and give the button back. A real document needs an
// account, and nothing here is about Google's own markup.
test("the Docs reading overlay re-reads the document in place, and a failed re-read leaves the snapshot on screen", async ({ context, page }) => {
  const EDITOR = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Refresh fixture - Google Docs</title></head>
<body><canvas width="600" height="400"></canvas></body></html>`;
  const mobilebasic = (v) => docsReadingHtml([PARA(`DOCVERSION${v}ONE`), PARA(`DOCVERSION${v}TWO`)], v);
  let version = 1;
  let broken = false;
  let refused = 0;
  await context.route("https://docs.google.com/**", (route) => {
    const isStatic = route.request().url().includes("/mobilebasic");
    if (isStatic && broken) {
      refused++;
      return route.fulfill({ status: 500, contentType: "text/html", body: "no" });
    }
    return route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: isStatic ? mobilebasic(version) : EDITOR });
  });
  const overlay = () =>
    page.evaluate((sel) => {
      const sr = document.getElementById("anagram-docs-overlay")?.shadowRoot;
      const paper = sr?.querySelector(".paper");
      const refresh = sr?.querySelector("#anagram-ovl-refresh");
      return {
        hosts: document.querySelectorAll("#anagram-docs-overlay").length,
        bars: sr ? sr.querySelectorAll(".bar").length : 0,
        // The bar and the notice carry the marker attribute too: only the paper's own hosts are chips.
        chips: paper ? [...paper.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill:not(.pending)")).length : 0,
        v1: !!paper?.textContent.includes("DOCVERSION1"),
        v2: !!paper?.textContent.includes("DOCVERSION2"),
        title: sr?.querySelector(".bar .t")?.textContent ?? "",
        refreshable: refresh ? !refresh.disabled : false,
      };
    }, BADGE_SEL);
  const refresh = () => page.evaluate(() => document.getElementById("anagram-docs-overlay").shadowRoot.querySelector("#anagram-ovl-refresh").click());

  await page.goto("https://docs.google.com/document/d/ANAGRAMREFRESHFIXTURE/edit", { waitUntil: "load" });
  const action = page.locator("#anagram-fab #anagram-action");
  await expect(action).toHaveText("Analyze document");
  await action.click();
  const rereads = "the Docs reading overlay re-reads the document in place";
  await expect.poll(overlay, { message: `${rereads} (opened)` }).toMatchObject({ v1: true, chips: 2 });

  version = 2;
  await refresh();
  await expect.poll(overlay, { message: rereads }).toMatchObject({ hosts: 1, bars: 1, chips: 2, v1: false, v2: true, refreshable: true });
  expect((await overlay()).title, rereads).toContain("v2");

  broken = true;
  await refresh();
  const failed = "a failed re-read leaves the snapshot on screen";
  await expect.poll(() => refused, { message: `${failed} (the re-read was refused)` }).toBeGreaterThan(0);
  await expect.poll(overlay, { message: failed }).toMatchObject({ hosts: 1, chips: 2, v1: false, v2: true, refreshable: true });
});

// Page 1 alone is two units, the second of them the two short paragraphs read with the first
// half of P4; page 2 is drawn once those have their chips, and P4 is then one paragraph across
// the page break, P2 and P3 are read again without it, and P5 is read: four units. Page 3
// makes a fifth. What the engine is sent is the document's paragraphs, not the viewer's lines.
test("Google Drive preview: the document's paragraphs are read (lines joined, hyphens mended, pages sewn — a page drawn after the first units were sent joins the paragraph running onto it), chips and marks drawn over the page", async ({ context, page, nativeHost, chunkLoads }) => {
  const fixture = readFileSync(join(FIXTURES, "surfaces", "drive-preview.html"), "utf8");
  const from = fixture.indexOf('<div class="kd-page" data-page-slot="2"');
  const to = fixture.indexOf('<div class="kd-page" data-page-slot="3"');
  const html =
    fixture.slice(0, from) +
    '<div class="kd-page" data-page-slot="2" style="padding-bottom: 129.4118%;"></div>\n' +
    fixture.slice(to).replace("</body>", `<template id="page-2">${fixture.slice(from, to)}</template></body>`);
  await context.route("https://drive.google.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
  const mark = nativeHost.textMark();
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto("https://drive.google.com/file/d/ANAGRAMDRIVEFIXTURE/view", { waitUntil: "load" });
  const drive = "Google Drive preview: the document's paragraphs are read (lines joined, hyphens mended, pages sewn — a page drawn after the first units were sent joins the paragraph running onto it), chips and marks drawn over the page";
  const onPages = () => page.evaluate((sel) => document.querySelectorAll(`.kd-page > [data-anagram] > [data-chip] > ${sel}`).length, BADGE_SEL);
  // Pages load as scrolling to them would.
  const draw = (n) => page.evaluate((n) => {
    document.querySelector(`[data-page-slot="${n}"]`).replaceWith(document.getElementById(`page-${n}`).content.firstElementChild.cloneNode(true));
  }, n);
  await expect.poll(onPages, { message: `${drive} (page 1)` }).toBeGreaterThanOrEqual(2);
  // A pending chip can answer that wait before the batch leaves: wait for page 1's two units
  // to reach the engine, so "sent before page 2 was drawn" means what it says.
  await expect.poll(() => nativeHost.textsSince(mark).length, { message: `${drive} (page 1 sent)` }).toBeGreaterThanOrEqual(2);
  const beforeDraw = nativeHost.textsSince(mark).length;
  await draw(2);
  await expect.poll(onPages, { message: `${drive} (pages 1 and 2)` }).toBeGreaterThanOrEqual(4);
  await draw(3);
  await expect.poll(onPages, { message: `${drive} (page 3)` }).toBeGreaterThanOrEqual(5);
  // The engine is sent the model's form of a unit, one line break between paragraphs.
  const flat = (t) => t.replace(/\s+/g, " ");
  const want = [DRIVE.p1, `${DRIVE.p2} ${DRIVE.p3}`, DRIVE.p4, DRIVE.p5, DRIVE.p6];
  await expect.poll(() => want.filter((t) => !nativeHost.textsSince(mark).some((s) => flat(s) === t)).map((t) => t.slice(0, 40)), { message: `${drive} (the paragraphs)` }).toEqual([]);
  const r = () => page.evaluate((sel) => ({
    chips: document.querySelectorAll(sel).length,
    inLayer: document.querySelectorAll(`.kd-layer ${sel}`).length,
  }), BADGE_SEL);
  await expect.poll(r, { message: drive }).toEqual({ chips: 5, inLayer: 0 });
  expect.soft(await page.locator(".kd-page > [data-anagram] > div:not([hidden])").count(), `${drive} (marks drawn)`).toBeGreaterThan(20);
  const sent = nativeHost.textsSince(mark);
  expect.soft(sent.filter((t) => t.includes("north-") || /show\s*\n\s*the stones/.test(t)).map((t) => t.slice(0, 40)), `${drive} (no viewer lines)`).toEqual([]);
  // Page 1 alone read P4's first half with P2 and P3 before page 2 was drawn.
  expect.soft(sent.slice(0, beforeDraw).some((s) => flat(s).startsWith(DRIVE.p2) && flat(s).endsWith("We had never heard of these")), `${drive} (half of P4 read before page 2)`).toBe(true);
  expect.soft(chunkLoads.get(page) ?? 0, `${drive} (the surfaces chunk)`).toBeGreaterThan(0);
});

// Its two columns and two pages are read as four units in reading order, a hyphen mended, and
// nothing is drawn inside pdf.js's own layer.
test("OneDrive's pdf.js preview: paragraphs read in reading order across columns and pages, chips and marks over the page", async ({ context, page, nativeHost, chunkLoads }) => {
  const html = readFileSync(join(FIXTURES, "surfaces", "pdfjs-viewer.html"), "utf8");
  await context.route("https://onedrive.live.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: html }));
  const mark = nativeHost.textMark();
  await page.setViewportSize({ width: 1100, height: 900 });
  await page.goto("https://onedrive.live.com/?id=ANAGRAMPDFJSFIXTURE", { waitUntil: "load" });
  const onedrive = "OneDrive's pdf.js preview: paragraphs read in reading order across columns and pages, chips and marks over the page";
  await expect.poll(() => page.evaluate((sel) => document.querySelectorAll(`.page > [data-anagram] > [data-chip] > ${sel}`).length, BADGE_SEL), { message: onedrive }).toBeGreaterThanOrEqual(4);
  const read = () => {
    const sent = nativeHost.textsSince(mark);
    return {
      mended: sent.some((t) => t.includes("notice what is different about each one")),
      acrossColumns: sent.some((t) => t.includes("the boy who brought the supplies from the harbour")),
      acrossPages: sent.some((t) => t.includes("by the afternoon boat. The new keeper")),
    };
  };
  await expect.poll(read, { message: onedrive }).toEqual({ mended: true, acrossColumns: true, acrossPages: true });
  await expect.poll(() => page.locator(".page > [data-anagram] > div:not([hidden])").count(), { message: `${onedrive} (marks drawn)` }).toBeGreaterThan(20);
  expect.soft(await page.locator(`.textLayer ${BADGE_SEL}, .textLayer [data-anagram]`).count(), `${onedrive} (nothing inside pdf.js's layer)`).toBe(0);
  expect.soft(chunkLoads.get(page) ?? 0, `${onedrive} (the surfaces chunk)`).toBeGreaterThan(0);
});

test("an ordinary page loads no surface: the chunk is never asked for and the page is walked as always", async ({ page, pages, chunkLoads }) => {
  pages.serve({ "/ui-fixtures.html": readFileSync(join(import.meta.dirname, "..", "ui-fixtures.html"), "utf8") });
  await page.goto(pages.url("/ui-fixtures.html"), { waitUntil: "load" });
  const ordinary = "an ordinary page loads no surface: the chunk is never asked for and the page is walked as always";
  await expect(settledChips(page, "#topedge"), ordinary).toHaveCount(1);
  await expect(settledChips(page, "#vertical"), ordinary).toHaveCount(1);
  expect(chunkLoads.has(page), ordinary).toBe(false);
});
