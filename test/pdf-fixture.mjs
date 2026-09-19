// test/pdf-fixture.mjs — a real PDF for the suites that open one, and a server for it.
//
// The PDF checks need a file that is genuinely a PDF — pdf.js parses it, its worker runs,
// its fonts are resolved — but a binary fixture in the repository would be opaque and a
// PDF library would be a dependency bought for one test. A PDF set in one of the standard
// fourteen fonts is a few hundred bytes of text, so this writes its own. Two suites open
// it: test/scenarios.mjs in Chromium and test/firefox.mjs in Firefox, and they must read
// the SAME document — a second copy of this would drift the moment one of them changed.
import http from "node:http";

// The document is built to exercise the reflow rules that matter: a running head and a
// page number on both pages (dropped), a heading in larger type, a paragraph whose last
// line stops short before a capitalised one (a break), a word the typesetter broke with a
// hyphen (mended), a compound broken after its own hyphen (kept), and a paragraph whose
// last line on page 1 ends with no punctuation at all (sewn onto page 2).
export const PDF_HEAD = "ANAGRAM TEST DOCUMENT";
export const PDF_HEADING = "Reading a PDF";
export const PDF_PARAS = [
  [
    "Anagram rebuilds this document from the text runs the file places on each page, so",
    "that every paragraph can be read in order and handed to the local scoring daemon in",
    "exactly the shape a reader would see it, which is the only shape the model has ever",
    "been asked to judge. The page itself carries no paragraphs at all: it carries glyphs",
    "at coordinates, and the reconstruction has to infer the rest from the geometry alone,",
    "which is what the reflow rules in this extension exist to do for two column papers,",
    "for single column reports written in an office suite, and for slide decks exported",
    "from a presentation tool by somebody in a hurry on a Friday afternoon in December.",
    "That is the whole idea.",
  ],
  [
    "Sentences that run past the end of a line are put back together here, and a word the",
    "typesetter broke across two lines with a hyphen-",
    "ation mark is joined again, while a genuine compound such as state-of-the-",
    "art keeps the hyphen it was written with in the first place. This paragraph carries",
    "on for long enough to clear the fifty word floor that the extension applies to every",
    "unit it sends to the daemon, and it does not stop at the bottom of this page either,",
    "because the final line of it ends with no punctuation at all and simply runs on, so",
  ],
  [
    "that the paragraph is sewn back together across the page break by the reading rules",
    "rather than being left as two halves that neither the walker nor the model would",
    "recognise as one piece of writing by one person on one afternoon in one sitting.",
  ],
  [
    "Running heads and page numbers are furniture, not writing, and the reader leaves",
    "them out of the text it renders so that the same line does not turn up at the top of",
    "every single unit that the extension sends off to be scored by the local daemon on",
    "this computer, which would be both wasteful and actively misleading to anybody who",
    // The fake daemon's verdicts are a pure function of the text, and this wording is
    // the one that lands in a FLAGGED band — the panel and the copied report both need
    // at least one flagged paragraph to have anything to show.
    "later reads the copied report and asks where each of these paragraphs came from.",
  ],
];

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

export const TEST_PDF = buildPdf([
  [
    { x: 72, y: 742, size: 9, text: PDF_HEAD },
    { x: 300, y: 50, size: 10, text: "1" },
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
/** A valid PDF whose single page places no text at all — a scan, as far as we can tell. */
export const SCANNED_PDF = buildPdf([[]]);

/** A file that says it is a PDF and is not one — the "cannot be read" line. */
export const BROKEN_PDF = Buffer.from("%PDF-1.7\nthis file claims to be a PDF and is not one\n", "latin1");

/**
 * Serve the PDFs over http. The reader fetches BYTES from a `?src=` address, so these
 * need a server that answers `application/pdf` — the suites' page server answers
 * everything as text/html, which a PDF is not.
 */
export async function servePdfs(files = { "/doc.pdf": TEST_PDF, "/scanned.pdf": SCANNED_PDF, "/broken.pdf": BROKEN_PDF }) {
  const server = http.createServer((req, res) => {
    const body = files[req.url.split("?")[0]];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/pdf", "content-length": body.length });
    res.end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  return { url: (path) => `http://localhost:${port}${path}`, close: () => new Promise((r) => server.close(() => r())) };
}
