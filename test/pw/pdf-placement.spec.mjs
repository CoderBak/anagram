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
import { buildColumnsPdf, openPdfInReader, readerRead, readerReady } from "../pdf-fixture.mjs";

const REAL = join(homedir(), "anagram-bench", "pdf-placement");
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
