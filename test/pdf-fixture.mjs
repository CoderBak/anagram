// test/pdf-fixture.mjs — a real PDF for the suites that open one, and a server for it.
//
// The PDF checks need a file that is genuinely a PDF — pdf.js parses it, its worker runs,
// its fonts are resolved — but a binary fixture in the repository would be opaque and a
// PDF library would be a dependency bought for one test. A PDF set in one of the standard
// fourteen fonts is a few hundred bytes of text, so this writes its own. Two suites open
// it: test/scenarios.mjs in Chromium and test/firefox.mjs in Firefox, and they must read
// the SAME document — a second copy of this would drift the moment one of them changed.
import http from "node:http";
import { createHash } from "node:crypto";

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
    "on for long enough to clear the seventy-five word floor the extension applies to every",
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
    "later reads the copied report and asks where each of these paragraphs came from, and",
    "why the same line of furniture turns up in every one of them.",
  ],
];

/** Lay rows out as a column of 11 pt lines from `top` downward (PDF y grows upward). */
export const pdfColumn = (rows, top) => rows.map((text, i) => ({ x: 72, y: top - i * 14, size: 11, text }));

// ---- encryption ---------------------------------------------------------------------------
//
// A password-protected PDF, written here for the same reason the plain one is: qpdf is not
// on this machine and a binary fixture in the repository would be opaque. This is the
// standard security handler at its oldest and simplest — /V 1 /R 2, a 40-bit RC4 key — which
// is what "encrypted PDF" meant for fifteen years and what pdf.js still opens. RC4 is a
// stream cipher, so an encrypted content stream is exactly as long as the plain one and the
// /Length written above it needs no adjusting.
//
// Algorithms 2, 3, 4 and 1 of the PDF specification's §7.6.3, in that order. Nothing here
// is a security claim: it is a lock a test needs a key for.

/** The specification's padding string, appended to every password and truncated to 32. */
const PAD = Buffer.from([
  0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08,
  0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a,
]);
/** A fixed file ID, so the same password always produces the same bytes. */
const FILE_ID = Buffer.from("anagram-test-pdf", "latin1");
/** Everything permitted; the reserved high bits are what makes it -1 rather than 0. */
const PERMISSIONS = -1;

const md5 = (buf) => createHash("md5").update(buf).digest();
const padPassword = (password) => Buffer.concat([Buffer.from(password, "latin1"), PAD]).subarray(0, 32);

/** RC4. Node's OpenSSL dropped it years ago, and it is fifteen lines. */
function rc4(key, data) {
  const s = new Uint8Array(256);
  for (let i = 0; i < 256; i++) s[i] = i;
  let j = 0;
  for (let i = 0; i < 256; i++) {
    j = (j + s[i] + key[i % key.length]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
  }
  const out = Buffer.alloc(data.length);
  let i = 0;
  j = 0;
  for (let n = 0; n < data.length; n++) {
    i = (i + 1) & 255;
    j = (j + s[i]) & 255;
    [s[i], s[j]] = [s[j], s[i]];
    out[n] = data[n] ^ s[(s[i] + s[j]) & 255];
  }
  return out;
}

/** The /Encrypt dictionary's own entries, and the key every object is encrypted under. */
function standardSecurity(password) {
  const owner = rc4(md5(padPassword(password)).subarray(0, 5), padPassword(password));
  const p = Buffer.alloc(4);
  p.writeInt32LE(PERMISSIONS);
  const key = md5(Buffer.concat([padPassword(password), owner, p, FILE_ID])).subarray(0, 5);
  return { owner, user: rc4(key, PAD), key };
}

/** The per-object key: the file key salted with the object and generation numbers. */
function objectKey(key, objectNumber) {
  const salt = Buffer.from([objectNumber & 255, (objectNumber >> 8) & 255, (objectNumber >> 16) & 255, 0, 0]);
  return md5(Buffer.concat([key, salt])).subarray(0, Math.min(key.length + 5, 16));
}

/**
 * A PDF from pages of placed lines. Objects are written in order, their byte offsets
 * collected for the cross-reference table, and the whole thing encoded as latin1 so that
 * the /Length of each content stream is the byte count the parser will find.
 *
 * With `password`, the content streams are encrypted and the trailer carries /Encrypt and
 * /ID — the document is then unreadable until somebody types that password.
 *
 * `padBytes` adds a stream object nothing refers to, which is how a file of a stated SIZE
 * is written without giving pdf.js anything more to parse: the size caps and the relay are
 * about bytes on the wire, and a fifty-megabyte document made of real pages would take
 * minutes to open for a measurement that has nothing to do with its pages.
 */
export function buildPdf(pages, { password = null, padBytes = 0 } = {}) {
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const objects = [];
  const add = (body) => objects.push(body) && objects.length;
  const security = password === null ? null : standardSecurity(password);

  const catalog = add(null);
  const pageTree = add(null);
  const regular = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const bold = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");

  const pageIds = [];
  for (const lines of pages) {
    const plain =
      "BT\n" +
      lines
        .map((l) => `/${l.bold ? "F2" : "F1"} ${l.size} Tf\n1 0 0 1 ${l.x} ${l.y} Tm\n(${esc(l.text)}) Tj`)
        .join("\n") +
      "\nET\n";
    const contents = objects.length + 1; // the object number this stream is about to take
    const body = security
      ? rc4(objectKey(security.key, contents), Buffer.from(plain, "latin1")).toString("latin1")
      : plain;
    add(`<< /Length ${Buffer.byteLength(plain, "latin1")} >>\nstream\n${body}endstream`);
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pageTree} 0 R /MediaBox [0 0 612 792] ` +
          `/Resources << /Font << /F1 ${regular} 0 R /F2 ${bold} 0 R >> >> /Contents ${contents} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pageTree} 0 R >>`;
  objects[pageTree - 1] = `<< /Type /Pages /Kids [${pageIds.map((n) => `${n} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  if (padBytes > 0) add(`<< /Length ${padBytes} >>\nstream\n${"\n".repeat(padBytes)}endstream`);
  // The /Encrypt dictionary is itself never encrypted, which is why it comes last: its
  // object number takes part in nothing.
  const encrypt = security
    ? add(
        `<< /Filter /Standard /V 1 /R 2 /Length 40 ` +
          `/O <${security.owner.toString("hex")}> /U <${security.user.toString("hex")}> /P ${PERMISSIONS} >>`,
      )
    : null;

  let pdf = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const startxref = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) pdf += `${String(off).padStart(10, "0")} 00000 n \n`;
  const id = FILE_ID.toString("hex");
  pdf +=
    `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R` +
    (encrypt ? ` /Encrypt ${encrypt} 0 R /ID [<${id}> <${id}>]` : "") +
    ` >>\nstartxref\n${startxref}\n%%EOF\n`;
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

// A document of SHORT paragraphs — the case a paper is full of and the reader used to drop
// on the floor. Three paragraphs of about 30 words each under a heading are read together,
// the way three short <p>s of one voice are on a web page; the heading under them is a
// barrier, so the two paragraphs after it (48 words, under the 75-word floor with nothing
// of their own section to join) are read by nobody. Every line starts in lower case and every
// paragraph is set to the same measure, so the only thing separating two of them is the
// blank line between — nothing here tests the reflow's cleverness, only the grouping.
export const GROUPED_HEADINGS = ["Short paragraphs", "Another section"];
export const GROUPED_PARAS = [
  [
    "the reader keeps every short paragraph of a paper in view",
    "and joins it to the ones that stand right beside it",
    "so that nothing written here goes unread by anybody today.",
  ],
  [
    "a second short paragraph follows the first one closely",
    "and carries its own small handful of quiet ordinary words",
    "which nobody would ever think of judging on their own.",
  ],
  [
    "the third one closes this run of three short paragraphs",
    "and brings the whole group well past the evidence floor",
    "where the model can finally read all of them together.",
  ],
  [
    "under the second heading two more paragraphs sit",
    "and they are shorter than the floor allows",
    "so nothing here reaches the daemon at all.",
  ],
  [
    "the heading between them is a hard barrier",
    "which no group of paragraphs ever reads across",
    "however short the paragraphs on either side are.",
  ],
];
/** The three paragraphs as the daemon sees them: one unit, each paragraph on a line of its own. */
export const GROUPED_UNIT_TEXT = GROUPED_PARAS.slice(0, 3).map((p) => p.join(" ")).join("\n");

export const GROUPED_PDF = buildPdf([
  [
    { x: 72, y: 700, size: 16, bold: true, text: GROUPED_HEADINGS[0] },
    ...pdfColumn(GROUPED_PARAS[0], 670),
    ...pdfColumn(GROUPED_PARAS[1], 614),
    ...pdfColumn(GROUPED_PARAS[2], 558),
    { x: 72, y: 502, size: 16, bold: true, text: GROUPED_HEADINGS[1] },
    ...pdfColumn(GROUPED_PARAS[3], 474),
    ...pdfColumn(GROUPED_PARAS[4], 418),
  ],
]);

/** The password the locked fixture below is locked with. */
export const PDF_PASSWORD = "anagram";
/** The same document, behind a password: the reader has to ask for it and be answered. */
export const LOCKED_PDF = buildPdf(
  [[{ x: 72, y: 700, size: 16, bold: true, text: PDF_HEADING }, ...pdfColumn(PDF_PARAS[0], 670)]],
  { password: PDF_PASSWORD },
);

/**
 * A long two-column paper. Two suites need a document that does not fit on one screen:
 * the scenarios, to prove that a page far down the stack has its TEXT (and so its units,
 * its chips and the panel's rows) long before it has any pixels, and test/perf.mjs, for
 * the budgets that only a real stack of pages can state. Every paragraph is twenty-two
 * lines of five words, which clears the 75-word floor, and no line repeats, so nothing but
 * the running head and the page number is taken for furniture.
 */
export function buildTwoColumnPdf(pageCount) {
  // Short words only: a 200 pt column of 11 pt Helvetica holds about 39 characters, and a
  // line that overruns its column would close the gutter and turn the page into one that
  // reads straight across — which is a different test from the one this file is for.
  const WORDS = "the quick brown fox jumps over a lazy dog rain falls on roofs and children read books near warm rooms long quiet nights before a timetable moved off paper until trains ran on time".split(" ");
  // A cheap hash of the line's own address, so no two lines of the document are alike:
  // identical paragraphs are deduplicated on their way to the daemon, and a document of
  // one repeated paragraph would arrive there as a single block.
  const word = (n) => WORDS[Math.abs(Math.imul(n, 2654435761) >>> 7) % WORDS.length];
  const line = (seed) => Array.from({ length: 5 }, (_, i) => word(seed * 31 + i)).join(" ");
  const LINES = 22; // 114 words a paragraph — well clear of the evidence floor
  const PER_COLUMN = 2; // paragraphs, which fill the column down to the page number
  const pages = [];
  for (let p = 0; p < pageCount; p++) {
    const items = [
      { x: 72, y: 742, size: 9, text: PDF_HEAD },
      { x: 300, y: 50, size: 10, text: `${p + 1}` },
    ];
    for (const [c, x] of [[0, 72], [1, 320]]) {
      for (let para = 0; para < PER_COLUMN; para++) {
        const id = (p * 2 * PER_COLUMN + c * PER_COLUMN + para) * 101;
        for (let i = 0; i < LINES; i++) {
          const text = i === LINES - 1 ? `${line(id + i)} and so it ends.` : line(id + i);
          items.push({ x, y: 700 - (para * (LINES + 1) + i) * 14, size: 11, text });
        }
      }
    }
    pages.push(items);
  }
  return buildPdf(pages);
}

/** Thirty pages of it — enough that most of the stack is nowhere near the viewport. */
export const TALL_PDF = buildTwoColumnPdf(30);

/** A file that says it is a PDF and is not one — the "cannot be read" line. */
export const BROKEN_PDF = Buffer.from("%PDF-1.7\nthis file claims to be a PDF and is not one\n", "latin1");

/**
 * Serve the PDFs over http. The tab showing a PDF re-reads it and hands the BYTES to the
 * reading mode, so these need a server that answers `application/pdf` — the suites' page
 * server answers everything as text/html, which a PDF is not.
 */
export async function servePdfs(
  files = {
    "/doc.pdf": TEST_PDF,
    "/grouped.pdf": GROUPED_PDF,
    "/scanned.pdf": SCANNED_PDF,
    "/broken.pdf": BROKEN_PDF,
    "/tall.pdf": TALL_PDF,
  },
) {
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

/** Open through the authorized tab handoff; a reader `src` query never fetches bytes. */
export async function openPdfInReader(context, url, { timeout = 25000 } = {}) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "load" }).catch(() => {});
  await handOverPdf(page, { timeout });
  return page;
}

/** The same, for a tab already sitting on a PDF: press the ball's chip and wait. */
export async function handOverPdf(page, { timeout = 25000 } = {}) {
  if (new URL(page.url()).pathname === "/reader.html") return page;
  await page
    .waitForFunction(
      () => !!document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".action"),
      null,
      { timeout },
    )
    .catch(() => {});
  await page
    .evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".action").click())
    .catch(() => {});
  await page.waitForURL(/reader\.html/, { timeout }).catch(() => {});
  return page;
}
