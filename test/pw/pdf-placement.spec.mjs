// Where the reader draws a paragraph's chip and underline: on the paragraph's own lines.
//
// A chip stands beside the last line of its paragraph. On a page of two columns there is no
// room for it in the gutter, and the page's right margin is the left column's only across
// the right column's lines: a left paragraph's chip drawn there stands beside another
// paragraph's text. The fixture is one such page (test/pdf-fixture.mjs buildColumnsPdf), read
// through Zotero's structure and through the reflow; the two papers the bug was reported on
// (arXiv 2507.01297 and 2004.04906) are checked too when they are in
// ~/anagram-bench/pdf-placement/ (a plain download of https://arxiv.org/pdf/<id>), and
// skipped when they are not. They are never in the repository.
//
//   npx playwright test pdf-placement
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { test as base, expect, BADGE_SEL } from "./kit.mjs";
import { fakeScore } from "../fake-native.mjs";
import { buildPdf, buildColumnsPdf, openPdfInReader, readerRead, readerReady } from "../pdf-fixture.mjs";
import { documentOptions, loadPipeline } from "../pdf-bench/anagram.mjs";

const REAL = process.env.ANAGRAM_PDF_PLACEMENT || join(homedir(), "anagram-bench", "pdf-placement");
const PAPERS = ["2507.01297", "2004.04906"];
const { pdf: COLUMNS_PDF, paragraphs: COLUMNS } = buildColumnsPdf();

const test = base.extend({
  pdfs: async ({ pages }, use) => {
    const files = { "/columns.pdf": COLUMNS_PDF };
    for (const id of PAPERS) if (existsSync(join(REAL, `${id}.pdf`))) files[`/${id}.pdf`] = readFileSync(join(REAL, `${id}.pdf`));
    pages.serve(files);
    await use({ url: pages.url });
  },
});

test("the fallback keeps ruled table rows together and out of scoring", async () => {
  // Segmented horizontal rules, enclosing sides and no cell backgrounds.
  const words = ["Human reading observations", "Later reading observations", "Final reading observations"];
  const content = words.flatMap((text, i) => [
    { text, x: 65, y: 680 - 30 * i, size: 12 }, { text: "Ref " + (i + 1), x: 265, y: 680 - 30 * i, size: 12 },
  ]);
  const drawing = [700, 670, 640, 610].map((y) => `60 ${y} 200 1 re f\n260 ${y} 100 1 re f\n`).join("") +
    "60 610 1 91 re f\n359 610 1 91 re f\n";
  const { pipeline, pdfjs } = await loadPipeline();
  const task = pdfjs.getDocument(documentOptions(new Uint8Array(buildPdf([content], { drawings: [drawing] }))));
  try {
    const page = await (await task.promise).getPage(1);
    const blocks = pipeline.reflowPdf([await pipeline.extractPageText(page)]);
    expect(blocks.map((b) => [b.kind, b.text])).toEqual(words.map((w, i) => ["table", w + " Ref " + (i + 1)]));
    expect(pipeline.unitsOf(blocks, 1)).toEqual([]);
  } finally {
    await task.destroy();
  }
});

test("the fallback preserves all 21 rows in an untagged borderless PDF", async () => {
  const rows = Array.from({ length: 21 }, (_, i) => ["Subject " + (i + 1), "Reference " + (i + 1), String(i + 1)]);
  const content = rows.flatMap((row, i) => row.map((text, k) => ({text, x: [50, 270, 495][k], y: 690 - 24 * i, size: 11})));
  const { pipeline, pdfjs } = await loadPipeline();
  const task = pdfjs.getDocument(documentOptions(new Uint8Array(buildPdf([content]))));
  try {
    const page = await (await task.promise).getPage(1);
    const blocks = pipeline.reflowPdf([await pipeline.extractPageText(page)]);
    expect(blocks.map((b) => [b.kind, b.text])).toEqual(rows.map((row) => ["table", row.join(" ")]));
    expect(pipeline.unitsOf(blocks, 1)).toEqual([]);
  } finally { await task.destroy(); }
});

test("an untagged text table follows its rows, while the same fields painted as separate lists follow columns", async () => {
  const rows = [["Title","Genre","Country"], ["Hamlet","Tragedy","Denmark"], ["Macbeth","Tragedy","Scotland"],
    ["Othello","Tragedy","Italy"], ["Emma","Novel","England"], ["Rebecca","Novel","England"], ["Dune","Fiction","Arrakis"],
    ["Persuasion","Novel","England"], ["Odyssey","Epic","Greece"], ["Iliad","Epic","Troy"], ["Faust","Drama","Germany"], ["Heidi","Novel","Switzerland"]];
  const grid = rows.map((row, i) => row.map((text, j) => ({text, x: [60, 255, 450][j], y: 680 - i * 22, size: 11})));
  const columns = [0, 1, 2].flatMap((j) => grid.map((r) => r[j]));
  const { pipeline, pdfjs } = await loadPipeline();
  for (const rowFirst of [true, false]) {
    const task = pdfjs.getDocument(documentOptions(new Uint8Array(buildPdf([rowFirst ? grid.flat() : columns]))));
    try {
      const p = await pipeline.extractPageText(await (await task.promise).getPage(1));
      const blocks = pipeline.reflowPdf([p]);
      if (rowFirst) {
        expect(blocks.map((b) => [b.kind, b.text])).toEqual(rows.map((row) => ["table", row.join(" ")]));
        expect(pipeline.unitsOf(blocks, 1)).toEqual([]);
      } else {
        expect(blocks.every((b) => b.kind !== "table")).toBe(true);
        expect(blocks.map((b) => b.text).join(" ")).toBe(columns.map((x) => x.text).join(" "));
      }
    } finally { await task.destroy(); }
  }
});

test("PDF table tags describe wrapped cells even when other text shares their baselines", async () => {
  const content = [["West", 50, 650], ["Trade", 215, 650], ["winds", 215, 634], ["East", 50, 610],
    ["Westerlies", 215, 610], ["An independent note on the same line.", 370, 650], ["Region", 50, 680], ["Wind", 215, 680]]
    .map(([text, x, y]) => ({text, x, y, size: 11}));
  const rows = [[[6], [7]], [[0], [1,2]], [[3], [4]]];
  const { pipeline, pdfjs } = await loadPipeline();
  const task = pdfjs.getDocument(documentOptions(new Uint8Array(buildPdf([content], { taggedRows: [rows] }))));
  try {
    const page = await (await task.promise).getPage(1);
    const p = await pipeline.extractPageText(page);
    expect(p.taggedRows).toHaveLength(3);
    const blocks = pipeline.reflowPdf([p]);
    expect(blocks.filter((b) => b.kind === "table").map((b) => b.text)).toEqual(["Region Wind", "West Trade winds", "East Westerlies"]);
    expect(blocks.filter((b) => b.kind !== "table").map((b) => b.text)).toEqual(["An independent note on the same line."]);
    for (const b of blocks) for (const run of b.runs)
      expect(b.text.slice(run.at, run.at + run.length)).toBe(p.items[run.item].str.slice(run.from, run.from + run.length));
  } finally { await task.destroy(); }
});

test("a printed table beside a paragraph leaves the entire paragraph available for scoring", async () => {
  const body = [
    "During the night the water rose above the bank",
    "and reached the bridge before the rain stopped.",
    "The next morning we walked along the old path",
    "to see how far the current had carried the stones.",
    "We found them in the sand under the trees",
    "and marked their positions in the field notebook.",
  ];
  const rows = [["Plant", "Season"], ["Crocus", "Spring"], ["Aster", "Autumn"]];
  const content = [...body.map((text, i) => ({ text, x: 55, y: 680 - i * 16, size: 10 })),
    ...rows.flatMap((row, i) => row.map((text, j) => ({ text, x: 350 + j * 85, y: 664 - i * 16, size: 10 })))];
  const drawing = [672, 656, 640, 624].map((y) => `345 ${y} 85 1 re f\n430 ${y} 85 1 re f\n`).join("") +
    "345 624 1 49 re f\n514 624 1 49 re f\n";
  const { pipeline, pdfjs } = await loadPipeline();
  const task = pdfjs.getDocument(documentOptions(new Uint8Array(buildPdf([content], { drawings: [drawing] }))));
  try {
    const p = await pipeline.extractPageText(await (await task.promise).getPage(1));
    expect(p.tables).toHaveLength(3);
    const blocks = pipeline.reflowPdf([p]);
    expect(blocks.map((b) => b.text)).toEqual([body.join(" "), ...rows.map((r) => r.join(" "))]);
    expect(pipeline.unitsOf(blocks).map((u) => u.text)).toEqual([body.join(" ")]);
  } finally { await task.destroy(); }
});

test("the fallback keeps the measured results of arXiv 2004.04906 Table 4 out of prose scores", async () => {
  const file = join(REAL, "2004.04906.pdf");
  test.skip(!existsSync(file), "arXiv placement fixture unavailable");
  const { pipeline, pdfjs } = await loadPipeline();
  const task = pdfjs.getDocument(documentOptions(new Uint8Array(readFileSync(file))));
  try {
    const page = await (await task.promise).getPage(8);
    const blocks = pipeline.reflowPdf([await pipeline.extractPageText(page)]);
    const rows = blocks.filter((b) => b.kind === "table");
    expect(rows.some((b) => b.text.includes("BM25+BERT") && b.text.includes("26.5") && b.text.endsWith("33.2"))).toBe(true);
    expect(rows.some((b) => b.text.includes("BM25+DPR") && b.text.endsWith("35.8"))).toBe(true);
    expect(blocks.filter((b) => b.kind === "paragraph").some((b) => b.text.includes("47.1"))).toBe(false);
  } finally { await task.destroy(); }
});

/**
 * Every chip of the page area with the line of text nearest to it along its own row (pdf.js
 * cuts a line into spans, a word each in the fixture's Courier), and every underline with its
 * place. Coordinates are the page's own.
 */
const measure = (page) =>
  page.evaluate((sel) => {
    const pills = [...document.querySelectorAll(sel)].filter((h) => h.shadowRoot?.querySelector(".pill") && h.closest(".anagramPdfChips"));
    const out = { chips: [], marks: [], lines: [], pending: pills.filter((h) => h.shadowRoot.querySelector(".pill").classList.contains("pending")).length, pages: [] };
    for (const layer of document.querySelectorAll("#viewer .page")) {
      const box = layer.getBoundingClientRect();
      const number = Number(layer.dataset.pageNumber);
      const spans = [...layer.querySelectorAll(".textLayer span")]
        .map((s) => ({ text: s.textContent, rect: s.getBoundingClientRect() }))
        // (arXiv's identifier up the margin is one tall rotated span, not a line)
        .filter((s) => s.text.trim() && s.rect.width > 0 && s.rect.height > 0 && !(s.rect.height > 80 && s.rect.height > s.rect.width * 3));
      // Lines: spans on one row (a superscript's centre is within a line's) that follow each other closely.
      const lines = [];
      const spanLine = [];
      const order = spans.map((_, i) => i).sort((x, y) => spans[x].rect.left - spans[y].rect.left);
      for (const i of order) {
        const s = spans[i], mid = (s.rect.top + s.rect.bottom) / 2;
        let line = lines.find((l) => Math.abs((l.top + l.bottom) / 2 - mid) < Math.max(l.bottom - l.top, s.rect.height) * 0.6 && s.rect.left >= l.left - 1 && s.rect.left - l.right < s.rect.height);
        if (!line) lines.push(line = { parts: [], left: s.rect.left, right: s.rect.right, top: s.rect.top, bottom: s.rect.bottom });
        line.parts.push(s.text.trim());
        line.right = Math.max(line.right, s.rect.right);
        line.top = Math.min(line.top, s.rect.top);
        line.bottom = Math.max(line.bottom, s.rect.bottom);
        spanLine[i] = lines.indexOf(line);
      }
      out.pages.push({ number, text: spans.map((s) => s.text.replace(/\s+/g, "")), spanLine });
      for (const l of lines) out.lines.push({ page: number, text: l.parts.join(" "), left: l.left - box.left, right: l.right - box.left, top: l.top - box.top, bottom: l.bottom - box.top });
      for (const h of pills) {
        if (h.closest(".page") !== layer) continue;
        const r = h.getBoundingClientRect();
        const cy = (r.top + r.bottom) / 2;
        const nearest = (items, of) => {
          let at = null, gap = Infinity;
          items.forEach((it, i) => {
            const b = of(it);
            if (b.top >= cy || b.bottom <= cy) return;
            const g = Math.max(b.left - r.right, r.left - b.right, 0);
            if (g < gap) { gap = g; at = i; }
          });
          return { at, gap };
        };
        const line = nearest(lines, (l) => l);
        out.chips.push({
          page: number, cy: cy - box.top, gap: line.gap, nearLineIndex: line.at,
          score: (h.shadowRoot.textContent.match(/(\.\d\d|1\.0)(?!\d)/) ?? [])[1] ?? null,
          nearLine: line.at === null ? null : lines[line.at].parts.join(" "),
        });
      }
    }
    for (const [, highlight] of CSS.highlights ?? []) for (const range of highlight) {
      const layer = range.startContainer.parentElement?.closest(".page");
      if (!layer) continue;
      const box = layer.getBoundingClientRect(), r = range.getBoundingClientRect();
      out.marks.push({ page: Number(layer.dataset.pageNumber), cx: (r.left + r.right) / 2 - box.left, cy: (r.top + r.bottom) / 2 - box.top, text: range.toString() });
    }
    return out;
  }, BADGE_SEL);

async function settle(page, count, structure) {
  await (structure ? readerRead(page) : readerReady(page));
  await expect.poll(async () => { const m = await measure(page); return { chips: m.chips.length, pending: m.pending }; }, { message: `${count} settled chips` }).toEqual({ chips: count, pending: 0 });
}

for (const mode of ["structure", "reflow"]) {
  test(`PDF reader, ${mode}: on a page of two narrow columns each chip stands beside its own paragraph's last line and every underline lies on its own lines, at 100% and at page width`, async ({ context, pdfs, storage }) => {
    if (mode === "reflow") await storage.set({ pdfStructure: false });
    const page = await openPdfInReader(context, pdfs.url("/columns.pdf"));
    await settle(page, COLUMNS.length, mode === "structure");
    if (mode === "reflow") {
      expect(await page.evaluate(() => performance.getEntriesByName("anagram-structured").length), "the reflow read it").toBe(0);
    }
    for (const scale of ["1", "page-width"]) {
      await page.evaluate((s) => { window.PDFViewerApplication.pdfViewer.currentScaleValue = s; }, scale);
      const where = `PDF reader (${mode}, zoom ${scale})`;
      await expect.poll(async () => {
        const m = await measure(page), lines = m.lines;
        const failures = [];
        if (m.chips.length !== COLUMNS.length) failures.push(`${m.chips.length} chips`);
        for (const p of COLUMNS) {
          const last = lines.find((l) => l.text === p.lines.at(-1));
          const chip = m.chips.find((c) => c.nearLine === p.lines.at(-1));
          if (!last || !chip) { failures.push(`${p.tag}: no chip beside its last line`); continue; }
          if (Math.abs(chip.cy - (last.top + last.bottom) / 2) > 3) failures.push(`${p.tag}: chip ${Math.round(chip.cy - (last.top + last.bottom) / 2)} px off its last line`);
          if (m.chips.filter((c) => c.nearLine === p.lines.at(-1)).length !== 1) failures.push(`${p.tag}: more than one chip`);
        }
        // Every underline lies on the line whose words it marks (only the flagged sentences
        // are underlined, and the fixture's scores decide which).
        if (m.marks.length < 5) failures.push(`${m.marks.length} underlines`);
        for (const mark of m.marks) {
          const line = lines.find((l) => mark.cx >= l.left - 1 && mark.cx <= l.right + 1 && mark.cy >= l.top - 1 && mark.cy <= l.bottom + 1);
          const words = mark.text.trim().split(/\s+/).join(" ");
          if (!line || !line.text.includes(words)) failures.push(`an underline of "${words.slice(0, 20)}" lies on ${line ? `"${line.text}"` : "no line"}`);
        }
        return failures;
      }, { message: `${where}: chips and underlines on their paragraphs' lines` }).toEqual([]);
    }
  });
}

/** A verdict as its chip writes it: ".35" or "1.0". */
const written = (score) => (score >= 1 ? "1.0" : score.toFixed(2).slice(1));

/**
 * Which of a page's chips stand beside the last line of their own paragraph. The fixture host
 * scores a text by a function of the text alone, so a chip's score names the paragraphs it
 * can be (`fakeScore`), and where that is one paragraph it is found on the page by its last twelve characters,
 * in the page's text without the citation marks the reader drops before it sends one. A chip
 * whose paragraph is found and does not end on its nearest line is beside something else;
 * a chip whose score names several paragraphs, or whose paragraph is not found (a formula,
 * a paragraph cut in windows or across pages), is not judged.
 */
function judge(m, sentTexts, number) {
  const p = m.pages.find((q) => q.number === number);
  const owner = [];
  p.text.forEach((t, k) => { for (let c = 0; c < t.length; c++) owner.push(k); });
  const whole = p.text.join("");
  const dropped = new Set();
  for (const cite of whole.matchAll(/\[[\d,\u2013-]+\]/g)) for (let c = cite.index; c < cite.index + cite[0].length; c++) dropped.add(c);
  const kept = Array.from({ length: whole.length }, (_, c) => c).filter((c) => !dropped.has(c));
  const flat = kept.map((c) => whole[c]).join("");
  const endLine = (text) => {
    const tail = text.replace(/\s+/g, "").slice(-12);
    const i = tail.length < 8 ? -1 : flat.indexOf(tail);
    return i < 0 || flat.indexOf(tail, i + 1) >= 0 ? null : p.spanLine[owner[kept[i + tail.length - 1]]];
  };
  const byScore = new Map();
  for (const text of new Set(sentTexts)) {
    const key = written(fakeScore(text).score);
    byScore.set(key, [...(byScore.get(key) ?? []), text]);
  }
  const judged = { chips: 0, wrong: [] };
  for (const chip of m.chips.filter((c) => c.page === number)) {
    // Scores are two digits, so several paragraphs share one: only a score that names a
    // single paragraph tells whose chip this is.
    const named = byScore.get(chip.score) ?? [];
    const ends = named.length === 1 ? named.map(endLine).filter((e) => e !== null) : [];
    if (!ends.length) continue;
    judged.chips++;
    if (!ends.includes(chip.nearLineIndex)) judged.wrong.push(`p${number} ${chip.score}: "${(chip.nearLine ?? "").slice(-40)}"`);
  }
  return judged;
}

/**
 * The two papers, when they were downloaded, through Zotero's structure and through the
 * reflow: at 100% on every page and at page width on the first four, the chips stand beside
 * the last lines of their own paragraphs.
 */
for (const id of PAPERS) for (const mode of ["structure", "reflow"]) {
  test(`PDF reader, ${mode}: the chips of arXiv ${id} stand beside the ends of their paragraphs`, async ({ context, pdfs, storage, nativeHost }) => {
    test.skip(!existsSync(join(REAL, `${id}.pdf`)), `${id}.pdf is not in ${REAL}`);
    test.setTimeout(300_000);
    if (mode === "reflow") await storage.set({ pdfStructure: false });
    const mark = nativeHost.textMark();
    const page = await openPdfInReader(context, pdfs.url(`/${id}.pdf`));
    await (mode === "structure" ? readerRead(page, { timeout: 60_000 }) : readerReady(page, { timeout: 60_000 }));
    const count = await page.evaluate(() => window.PDFViewerApplication.pdfDocument.numPages);
    const total = { chips: 0, wrong: [] };
    for (const [scale, last] of [["1", count], ["page-width", Math.min(count, 4)]]) {
      await page.evaluate((s) => { window.PDFViewerApplication.pdfViewer.currentScaleValue = s; }, scale);
      for (let n = 1; n <= last; n++) {
        await page.evaluate((k) => { window.PDFViewerApplication.page = k; }, n);
        await page.waitForFunction((k) => window.PDFViewerApplication.pdfViewer.getPageView(k - 1)?.renderingState === 3 && !!document.querySelector(`#viewer .page[data-page-number="${k}"] .textLayer span`), n, { timeout: 30_000 });
        // The page's chips are all up: none pending, and the same number twice running.
        let seen = -1;
        await expect.poll(async () => {
          const m = await measure(page);
          const now = m.chips.filter((c) => c.page === n).length;
          const steady = m.pending === 0 && now === seen;
          seen = now;
          return steady;
        }, { message: `page ${n} at ${scale}: chips settled`, intervals: [400] }).toBe(true);
        const got = judge(await measure(page), nativeHost.textsSince(mark), n);
        total.chips += got.chips; total.wrong.push(...got.wrong);
      }
    }
    const message = `arXiv ${id}, ${mode}: ${total.chips} chips judged`;
    expect.soft(total.chips, message).toBeGreaterThan(20);
    // A few in a hundred may be a paragraph the reading sent in another shape than the page shows it (an appendix of examples).
    expect.soft(total.wrong.length, `${message}: beside something else than their paragraph's last line: ${total.wrong.join(" | ")}`).toBeLessThanOrEqual(Math.ceil(total.chips * 0.05));
  });
}
