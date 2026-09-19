// test/a11y-pdf.mjs — a real PDF, written out by hand, for the accessibility suite.
//
// The reader page (reader.html) only has something to render when it is handed a file
// that pdf.js can actually parse, and a binary fixture in the repository would be opaque
// while a PDF library would be a dependency bought for one test. A PDF set in one of the
// standard fourteen fonts is a few hundred bytes of text, so the suite writes its own.
//
// DUPLICATION, ON PURPOSE. `buildPdf` is a verbatim copy of the function of the same name
// in test/scenarios.mjs. That file is a script, not a module: importing it would launch a
// browser and run the whole scenario matrix as a side effect, and the only way to share
// the function would be to edit scenarios.mjs — which this branch deliberately does not
// touch (other agents are working in that file). Should the two ever need to agree, the
// place to put it is a test/pdf-fixture.mjs that both import; until then, these ~60 lines
// are copied and this comment is the note saying so.

/** Lay rows out as a column of 11 pt lines from `top` downward (PDF y grows upward). */
export const pdfColumn = (rows, top) => rows.map((text, i) => ({ x: 72, y: top - i * 14, size: 11, text }));

/**
 * A PDF from pages of placed lines. Objects are written in order, their byte offsets
 * collected for the cross-reference table, and the whole thing encoded as latin1 so that
 * the /Length of each content stream is the byte count the parser will find.
 */
export function buildPdf(pages) {
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;

  const catalog = add(null);
  const pageTree = add(null);
  const regular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  const pageIds = [];
  for (const lines of pages) {
    const stream =
      "BT\n" +
      lines
        .map((l) => `/${l.bold ? "F2" : "F1"} ${l.size} Tf\n1 0 0 1 ${l.x} ${l.y} Tm\n(${esc(l.text)}) Tj`)
        .join("\n") +
      "\nET\n";
    const contents = add(`<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${contents} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
  objects[pageTree - 1] = `<< /Type /Pages /Kids [${pageIds.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${startxref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

/** One page, one heading and two paragraphs — enough for the reader to render and chip. */
export const SMALL_PDF = buildPdf([
  [
    { x: 72, y: 700, size: 16, bold: true, text: "Reading a PDF" },
    ...pdfColumn(
      [
        "Anagram rebuilds this document from the text runs the file places on each page, so",
        "that every paragraph can be read in order and handed to the local scoring daemon in",
        "exactly the shape a reader would see it, which is the only shape the model has ever",
        "been asked to judge. The page itself carries no paragraphs at all: it carries glyphs",
        "at coordinates, and the reconstruction has to infer the rest from the geometry alone,",
        "which is what the reflow rules in this extension exist to do for two column papers,",
        "for single column reports written in an office suite, and for slide decks exported",
        "from a presentation tool by somebody in a hurry on a Friday afternoon in December.",
      ],
      670,
    ),
    ...pdfColumn(
      [
        "Running heads and page numbers are furniture, not writing, and the reader leaves",
        "them out of the text it renders so that the same line does not turn up at the top of",
        "every single unit that the extension sends off to be scored by the local daemon on",
        "this computer, which would be both wasteful and actively misleading to anybody who",
        "later reads the copied report and asks where each of these paragraphs came from.",
      ],
      540,
    ),
  ],
]);
