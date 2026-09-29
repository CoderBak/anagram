// Where the reader draws a paragraph's chip and underline: on the paragraph's own lines.
//
// A chip stands on the row of the last line of its paragraph. The chip layer is the page's
// padding box, inside pdf.js's 9 px transparent border, and the chip's place is a share of it:
// measured from the border box the chip was up to 9 px off, and on the tight leading of a
// paper that is half a line, beside the next paragraph. The fixture is one page of two narrow
// columns whose paragraphs end near the top and near the bottom of the page, read through
// Zotero's structure and through the reflow, at 100% and at page width.
//
//   npx playwright test pdf-placement
import { test as base, expect, BADGE_SEL } from "./kit.mjs";
import { buildColumnsPdf, openPdfInReader, readerRead, readerReady } from "../pdf-fixture.mjs";

const { pdf: COLUMNS_PDF, paragraphs: COLUMNS } = buildColumnsPdf();

const test = base.extend({
  pdfs: async ({ pages }, use) => {
    const files = { "/columns.pdf": COLUMNS_PDF };
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
  test(`PDF reader, ${mode}: on a page of two narrow columns each chip stands on its paragraph's last line and every underline lies on its own lines, at 100% and at page width`, async ({ context, pdfs, storage }) => {
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
          if (!last) { failures.push(`${p.tag}: its last line is not on the page`); continue; }
          const off = Math.min(...m.chips.map((c) => Math.abs(c.cy - (last.top + last.bottom) / 2)));
          if (!(off <= 3)) failures.push(`${p.tag}: the nearest chip is ${Math.round(off)} px off its last line`);
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
