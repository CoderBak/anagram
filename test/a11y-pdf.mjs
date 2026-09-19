// test/a11y-pdf.mjs — the small PDF the accessibility suite hands to the reader page.
//
// The reader page (reader.html) only has something to render when it is handed a file
// that pdf.js can actually parse. The writer lives in test/pdf-fixture.mjs, shared with the
// scenario and Firefox suites; this file only says what is on the one page this suite needs.
import { buildPdf, pdfColumn } from "./pdf-fixture.mjs";

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
