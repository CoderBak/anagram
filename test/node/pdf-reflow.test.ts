// test/node/pdf-reflow.test.ts — the paragraph reconstruction, on synthetic pages.
//
// Every case here is a page built by hand out of text runs at coordinates, because that
// is all a PDF ever gives us: the rules in lib/pdf/reflow.ts are the whole of the PDF
// feature's quality, and geometry is the only input they have. The helpers below place
// lines the way a typesetter would — a left margin, a constant pitch, a measure — so a
// test reads as the page it describes.
import { describe, expect, it } from "vitest";
import { reflowPdf, type PdfPageText, type PdfTextItem } from "../../lib/pdf/reflow";
import { looksLikePdfUrl, pdfNameFromUrl, readerQuery } from "../../lib/pdf/source";

const WIDTH = 612;
const HEIGHT = 792;
const SIZE = 11;
const PITCH = 14;
/** Helvetica at 11 pt runs to about this much per character — close enough for geometry. */
const CHAR = 5.1;

interface Placed {
  text: string;
  x?: number;
  y: number;
  size?: number;
  font?: string;
  rotated?: boolean;
  /** Force the run's width instead of measuring it: a justified line fills its measure. */
  width?: number;
}

function run(p: Placed): PdfTextItem {
  const size = p.size ?? SIZE;
  return {
    str: p.text,
    x: p.x ?? 72,
    y: p.y,
    width: p.width ?? p.text.length * CHAR * (size / SIZE),
    height: size,
    fontName: p.font ?? "body",
    rotated: p.rotated,
  };
}

function page(n: number, placed: Placed[]): PdfPageText {
  return { page: n, width: WIDTH, height: HEIGHT, items: placed.map(run) };
}

/** A column of lines from `top` down, all flush left and all the same measure. */
function column(lines: string[], top: number, x = 72, measure = 460): Placed[] {
  return lines.map((text, i) => ({ text, x, y: top + i * PITCH, width: measure }));
}

const texts = (blocks: { text: string }[]): string[] => blocks.map((b) => b.text);

describe("reflowPdf — single column", () => {
  it("joins the lines of a paragraph and separates two paragraphs by their gap", () => {
    const blocks = reflowPdf([
      page(1, [
        ...column(["the first paragraph runs", "over two lines here"], 100),
        ...column(["The second one starts", "after a blank line"], 100 + 2 * PITCH + PITCH * 1.8),
      ]),
    ]);
    expect(texts(blocks)).toEqual([
      "the first paragraph runs over two lines here",
      "The second one starts after a blank line",
    ]);
  });

  it("starts a paragraph at a first-line indent with no extra leading", () => {
    const blocks = reflowPdf([
      page(1, [
        ...column(["a paragraph set solid", "with no space between"], 100),
        { text: "Indented, so a new one begins", x: 72 + SIZE, y: 100 + 2 * PITCH, width: 440 },
        { text: "and it continues here", x: 72, y: 100 + 3 * PITCH, width: 460 },
      ]),
    ]);
    expect(texts(blocks)).toEqual([
      "a paragraph set solid with no space between",
      "Indented, so a new one begins and it continues here",
    ]);
  });

  it("breaks after a last line that stopped short when the next one starts a sentence", () => {
    const blocks = reflowPdf([
      page(1, [
        { text: "a paragraph whose measure is full", y: 100, width: 460 },
        { text: "and whose last line stops early", y: 100 + PITCH, width: 180 },
        { text: "Another paragraph begins here", y: 100 + 2 * PITCH, width: 460 },
        { text: "and runs to the measure again", y: 100 + 3 * PITCH, width: 460 },
      ]),
    ]);
    expect(texts(blocks)).toEqual([
      "a paragraph whose measure is full and whose last line stops early",
      "Another paragraph begins here and runs to the measure again",
    ]);
  });

  it("keeps a superscript on the line it was raised from", () => {
    const blocks = reflowPdf([
      page(1, [
        { text: "a claim with a footnote", y: 100, width: 120 },
        { text: "3", x: 192, y: 100 - 3, size: 7, width: 4 },
        { text: "and the rest of the sentence", x: 200, y: 100, width: 140 },
      ]),
    ]);
    expect(texts(blocks)).toEqual(["a claim with a footnote3 and the rest of the sentence"]);
  });
});

describe("reflowPdf — hyphenation", () => {
  /**
   * A word broken over two lines. Both lines fill the measure, because that is the only
   * way a typesetter's break happens: the rest of the word did not fit.
   */
  const broken = (first: string, second: string): string =>
    reflowPdf([
      page(1, [
        { text: first, y: 100, width: 455 },
        { text: second, y: 100 + PITCH, width: 460 },
      ]),
    ])[0].text;

  it("mends a word the typesetter broke", () => {
    expect(broken("the reconstruction is straightfor-", "ward once the lines are grouped")).toBe(
      "the reconstruction is straightforward once the lines are grouped",
    );
  });

  it("keeps the hyphen of a compound broken after one of its own hyphens", () => {
    expect(broken("a genuine state-of-the-", "art result stands here")).toBe(
      "a genuine state-of-the-art result stands here",
    );
  });

  it("keeps the hyphen when the continuation carries the rest of the compound", () => {
    expect(broken("a genuine state-", "of-the-art result stands here")).toContain(
      "state-of-the-art",
    );
  });

  it("keeps the hyphen when the compound is spelled out elsewhere in the document", () => {
    const blocks = reflowPdf([
      page(1, [
        { text: "risks from third-party software are", y: 100, width: 460 },
        { text: "hard to measure, and a third-", y: 100 + PITCH, width: 460 },
        { text: "party audit does not settle them", y: 100 + 2 * PITCH, width: 460 },
      ]),
    ]);
    expect(blocks[0].text).toContain("a third-party audit");
  });

  it("keeps the hyphen of a compound the document spells out only much later", () => {
    const blocks = reflowPdf([
      page(1, column(["we report an in-", "depth reading of the corpus"], 100)),
      page(2, column(["the in-depth reading is set out", "in the appendix that follows."], 100)),
    ]);
    expect(blocks[0].text).toContain("an in-depth reading");
  });

  it("mends a compound the document writes as one word elsewhere, list or no list", () => {
    const blocks = reflowPdf([
      page(1, [
        { text: "a nonlinear response was measured", y: 100, width: 460 },
        { text: "throughout, and the non-", y: 100 + PITCH, width: 460 },
        { text: "linear term dominates the fit", y: 100 + 2 * PITCH, width: 460 },
      ]),
    ]);
    expect(blocks[0].text).toContain("the nonlinear term");
  });

  it("keeps the hyphen of an acronym compound and before a capital or a digit", () => {
    expect(broken("the results are AI-", "generated throughout the text")).toContain("AI-generated");
    expect(broken("a study of Anglo-", "Saxon place names in England")).toContain("Anglo-Saxon");
    expect(broken("we report the type-", "1 error rate for each run")).toContain("type-1");
  });

  it("keeps the hyphen after a one-letter stem", () => {
    expect(broken("he sent an e-", "mail about it the next day")).toContain("e-mail");
  });

  it("keeps the hyphen after a modifier that is never a syllable break", () => {
    expect(broken("the model is trained self-", "supervised on raw text alone")).toContain(
      "self-supervised",
    );
  });

  it("keeps the hyphen of a line that stopped far short of its measure", () => {
    const blocks = reflowPdf([
      page(1, [
        { text: "the committee took a long-", y: 100, width: 200 },
        { text: "term view of the whole matter", y: 100 + PITCH, width: 460 },
        { text: "and reported in the spring of", y: 100 + 2 * PITCH, width: 460 },
      ]),
    ]);
    expect(blocks[0].text).toContain("a long-term view");
  });

  it("fuses a compound the document never spells out — the one cost of the rule", () => {
    // Accepted and documented in lib/pdf/reflow.ts: with no attestation anywhere in the
    // document and lower case on both sides of the break, the hyphen goes. Spending a
    // kept hyphen on every such word would leave far more real words broken.
    expect(broken("a thorough and highly in-", "depth analysis of the corpus")).toContain(
      "indepth",
    );
  });
});

describe("reflowPdf — two columns", () => {
  /** A page whose columns are printed level with each other: the hard case. */
  const twoColumnPage = (n: number, left: string[], right: string[], spanning?: string): PdfPageText =>
    page(n, [
      ...(spanning ? [{ text: spanning, x: 72, y: 80, size: 16, font: "display", width: 468 }] : []),
      ...column(left, 120, 72, 200),
      ...column(right, 120, 320, 200),
    ]);

  const LEFT = ["the left column holds", "these six lines and", "they belong together", "as one paragraph of", "prose that has to be", "read on its own."];
  const RIGHT = ["The right column holds", "six lines of its own,", "which must not be", "interleaved with the", "ones beside them on", "the printed page."];

  it("reads the left column before the right one, not line by line across the page", () => {
    const blocks = reflowPdf([twoColumnPage(1, LEFT, RIGHT)]);
    expect(texts(blocks)).toEqual([LEFT.join(" "), RIGHT.join(" ")]);
  });

  it("reads a full-width line before the columns it sits above", () => {
    const blocks = reflowPdf([twoColumnPage(1, LEFT, RIGHT, "A Title Across The Page")]);
    expect(blocks[0]).toEqual({ kind: "heading", text: "A Title Across The Page", page: 1 });
    expect(texts(blocks.slice(1))).toEqual([LEFT.join(" "), RIGHT.join(" ")]);
  });

  it("joins a paragraph that continues in the next column", () => {
    const left = ["a paragraph that fills the", "left column right down to", "its foot and carries on", "straight past the end with", "no punctuation at all to", "stop it going, and"];
    const right = ["so the right column takes", "it up again in lower case", "and finishes the sentence", "over there instead, on the", "very same printed page as", "the one it started on."];
    const blocks = reflowPdf([twoColumnPage(1, left, right)]);
    expect(texts(blocks)).toEqual([[...left, ...right].join(" ")]);
  });

  it("leaves a single-column page as one column", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `line number ${i} of an ordinary page`);
    const blocks = reflowPdf([page(1, column(lines, 100))]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toBe(lines.join(" "));
  });

  it("cuts the columns where every line leaves white, not in the middle of the gap", () => {
    // A justified column's lines stop at slightly different places, so the left half of
    // the white between the columns is clear only on the lines that ran short. Cutting
    // there would fall inside the longest lines' last word and make them spanning lines.
    const left = Array.from({ length: 10 }, (_, i) => `left line number ${i} of this page.`);
    const right = Array.from({ length: 10 }, (_, i) => `Right line number ${i} of the page.`);
    const blocks = reflowPdf([
      page(1, [
        ...column(left, 120, 72, 200).map((p, i) => (i % 3 === 0 ? { ...p, width: 218 } : p)),
        ...column(right, 120, 306, 218),
      ]),
    ]);
    expect(texts(blocks)).toEqual([left.join(" "), right.join(" ")]);
  });

  it("reads a page whose second column stops half way as two columns still", () => {
    const left = Array.from({ length: 12 }, (_, i) => `left line ${i} of the page.`);
    const right = Array.from({ length: 6 }, (_, i) => `Right line ${i} of it.`);
    const blocks = reflowPdf([
      page(1, [...column(left, 120, 72, 200), ...column(right, 120, 320, 200)]),
    ]);
    expect(texts(blocks)).toEqual([left.join(" "), right.join(" ")]);
  });
});

describe("reflowPdf — three columns", () => {
  /** Three measures of 150 points with a 21-point gutter between them. */
  const XS = [60, 231, 402];
  const MEASURE = 150;
  const across = (columns: string[][], top: number): Placed[] =>
    columns.flatMap((lines, i) => column(lines, top, XS[i], MEASURE));

  const COLS = [
    ["the first column of", "a three column page", "holds these lines", "and they belong", "together as one", "paragraph of prose."],
    ["The middle column is", "separate from both", "of its neighbours", "and has to be read", "second of the three", "in the final order."],
    ["The third column ends", "the page and must be", "read last of all the", "three rather than", "woven into either of", "the ones beside it."],
  ];
  const joined = COLS.map((lines) => lines.join(" "));

  it("reads three columns one after another, not line by line across the page", () => {
    const blocks = reflowPdf([page(1, across(COLS, 120))]);
    expect(texts(blocks)).toEqual(joined);
  });

  it("reads full-width matter in its place between the columns it separates", () => {
    const abstract = ["a full width abstract opens the page and", "runs the whole measure before the columns", "below it begin, as a paper's first page does."];
    const caption = "Figure 1: a figure spanning the full width of the page.";
    const below = COLS.map((lines) => lines.slice(0, 5).map((t) => `${t} again`));
    const blocks = reflowPdf([
      page(1, [
        ...column(abstract, 100, 60, 492),
        ...across(COLS, 170),
        { text: caption, x: 60, y: 270, size: 9, font: "caption", width: 492 },
        ...across(below, 300),
      ]),
    ]);
    expect(texts(blocks)).toEqual([
      abstract.join(" "),
      ...joined,
      caption,
      ...below.map((lines) => lines.join(" ")),
    ]);
  });

  it("does not take a table's column gaps for gutters", () => {
    const rows = ["one", "two", "three", "four", "five"].map((n, i) => [
      { text: `row ${n} left`, x: 72, y: 100 + i * PITCH, width: 100 },
      { text: `row ${n} middle`, x: 220, y: 100 + i * PITCH, width: 100 },
      { text: `row ${n} right`, x: 380, y: 100 + i * PITCH, width: 100 },
    ]);
    const prose = Array.from({ length: 10 }, (_, i) => `prose line ${i} under the table`);
    const blocks = reflowPdf([page(1, [...rows.flat(), ...column(prose, 220, 72, 240)])]);
    expect(blocks[0].text).toContain("row one left row one middle row one right");
    expect(texts(blocks)).toContain(prose.join(" "));
  });

  it("does not take the wide word spaces of justified text for a gutter", () => {
    // Every line is set with one space stretched wider than the type, near the middle of
    // the measure but never in the same place twice — which is what justification does,
    // and what a gutter never does.
    const gaps = [246, 292, 264, 338, 310, 274, 324, 254, 300, 346, 282, 316];
    const items = gaps.flatMap((gap, i) => [
      { text: `the first half of justified line ${i}`, x: 72, y: 100 + i * PITCH, width: gap - 72 },
      { text: "and the second half of it here", x: gap + 16, y: 100 + i * PITCH, width: 532 - gap - 16 },
    ]);
    const blocks = reflowPdf([page(1, items)]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain("the first half of justified line 0 and the second half of it here");
  });
});

describe("reflowPdf — front matter", () => {
  const ABSTRACT = [
    "We describe a method for rebuilding the",
    "paragraphs of a PDF from the geometry of",
    "its text runs, and evaluate it on a corpus",
    "of scholarly papers set in one, two and",
    "three columns throughout their pages.",
  ];
  /** A paper's first page: a centred title block over a flush-left abstract. */
  const firstPage = (): PdfPageText =>
    page(1, [
      { text: "A Study of Paragraph Reconstruction", x: 130, y: 100, size: 17, font: "title", width: 350 },
      { text: "Jane Doe", x: 180, y: 140, size: 12, width: 60 },
      { text: "John Smith", x: 330, y: 140, size: 12, width: 70 },
      { text: "University of Somewhere", x: 150, y: 158, size: 10, width: 120 },
      { text: "Institute of Elsewhere", x: 320, y: 158, size: 10, width: 110 },
      { text: "jane@example.edu", x: 170, y: 176, size: 10, width: 90 },
      { text: "john@elsewhere.ac.uk", x: 320, y: 176, size: 10, width: 100 },
      { text: "Abstract", x: 285, y: 210, size: 11, font: "display", width: 50 },
      // The abstract opens from a first-line indent, as an abstract usually does.
      { text: ABSTRACT[0], x: 114, y: 234, width: 396 },
      ...ABSTRACT.slice(1).map((text, i) => ({ text, x: 100, y: 234 + (i + 1) * PITCH, width: 410 })),
    ]);

  it("keeps the authors, their affiliations and their addresses out of the prose", () => {
    const blocks = reflowPdf([firstPage()]);
    expect(blocks).toEqual([
      { kind: "heading", text: "A Study of Paragraph Reconstruction", page: 1 },
      { kind: "paragraph", text: "Jane Doe John Smith", page: 1 },
      { kind: "paragraph", text: "University of Somewhere Institute of Elsewhere", page: 1 },
      { kind: "paragraph", text: "jane@example.edu john@elsewhere.ac.uk", page: 1 },
      { kind: "heading", text: "Abstract", page: 1 },
      { kind: "paragraph", text: ABSTRACT.join(" "), page: 1 },
    ]);
  });

  it("never joins the front matter to the text that follows it", () => {
    // The e-mail line ends in no punctuation and the abstract opens in lower case: every
    // test a cross-segment join makes would say "join these", and it must still not.
    const blocks = reflowPdf([
      page(1, [
        { text: "A Study of Paragraph Reconstruction", x: 130, y: 100, size: 17, font: "title", width: 350 },
        { text: "jane@example.edu", x: 170, y: 140, size: 11, width: 90 },
        ...["the text of the paper opens here", "and runs on over several lines", "of prose set flush to the left", "margin of the page, as prose is."].map(
          (text, i) => ({ text, x: 100, y: 170 + i * PITCH, width: 410 }),
        ),
      ]),
    ]);
    expect(blocks[1]).toEqual({ kind: "paragraph", text: "jane@example.edu", page: 1 });
    expect(blocks[2].text).toBe(
      "the text of the paper opens here and runs on over several lines of prose set flush to the left margin of the page, as prose is.",
    );
  });

  it("stops the front matter at a numbered section heading when there is no abstract", () => {
    const body = ["The paragraphs of a PDF have to be", "rebuilt from the geometry of its runs,", "and this is how the work is done here.", "Every rule has a reason behind it."];
    const blocks = reflowPdf([
      page(1, [
        { text: "A Study of Paragraph Reconstruction", x: 130, y: 100, size: 17, font: "title", width: 350 },
        { text: "Jane Doe and John Smith", x: 200, y: 140, size: 12, width: 190 },
        { text: "1 Introduction", x: 100, y: 180, size: 12, font: "display", width: 90 },
        ...body.map((text, i) => ({ text, x: 100, y: 210 + i * PITCH, width: 410 })),
      ]),
    ]);
    expect(blocks[1]).toEqual({ kind: "paragraph", text: "Jane Doe and John Smith", page: 1 });
    expect(blocks[2]).toEqual({ kind: "heading", text: "1 Introduction", page: 1 });
    expect(blocks[3].text).toBe(body.join(" "));
  });

  it("finds no front matter on a first page that opens with prose", () => {
    const lines = ["The report opens with prose and has", "no title page of any kind at all, so", "nothing here is front matter and the", "text reads exactly as it is printed.", "A second paragraph follows below it."];
    expect(texts(reflowPdf([page(1, column(lines, 100))]))).toEqual([lines.join(" ")]);
  });

  it("leaves the second page's title block alone — front matter is a first-page thing", () => {
    const heading = { text: "A Centred Heading On Page Two", x: 180, y: 100, size: 17, font: "title", width: 240 };
    const body = ["the section under it runs on for", "several lines of ordinary prose", "set flush to the left margin here."];
    const blocks = reflowPdf([
      page(1, column(["a first page of ordinary prose.", "It fills the page with lines."], 100)),
      page(2, [heading, ...body.map((text, i) => ({ text, x: 100, y: 140 + i * PITCH, width: 410 }))]),
    ]);
    expect(blocks[1]).toEqual({ kind: "heading", text: heading.text, page: 2 });
    expect(blocks[2].text).toBe(body.join(" "));
  });
});

describe("reflowPdf — furniture", () => {
  const body = (n: number): string[] => [
    `page ${n} opens with a line`,
    `and then a second line`,
    `and then a third line here.`,
  ];
  const withFurniture = (n: number): PdfPageText =>
    page(n, [
      { text: "Annual Report", y: 40, size: 9, width: 120 },
      ...column(body(n), 120),
      { text: String(n), x: 300, y: 745, size: 9, width: 6 },
    ]);

  it("drops a running head and a bare page number", () => {
    const blocks = reflowPdf([withFurniture(1), withFurniture(2), withFurniture(3)]);
    expect(texts(blocks)).toEqual([1, 2, 3].map((n) => body(n).join(" ")));
  });

  it("drops a running head whose only difference between pages is its number", () => {
    const head = (n: number): PdfPageText =>
      page(n, [{ text: `Section ${n} of the report`, y: 40, size: 9, width: 140 }, ...column(body(n), 120)]);
    const blocks = reflowPdf([head(1), head(2), head(3)]);
    expect(texts(blocks)).toEqual([1, 2, 3].map((n) => body(n).join(" ")));
  });

  it("drops a page number written out, and a rule around it", () => {
    const numbered = (n: number): PdfPageText =>
      page(n, [...column(body(n), 120), { text: `— ${n} —`, x: 290, y: 750, size: 9, width: 24 }]);
    const blocks = reflowPdf([numbered(1), numbered(2)]);
    expect(texts(blocks)).toEqual([body(1).join(" "), body(2).join(" ")]);
  });

  it("keeps a heading that only looks like a running head because it sits high", () => {
    const titles = ["Introduction", "Methods", "Results"];
    const heading = (n: number): PdfPageText =>
      page(n, [{ text: titles[n - 1], y: 40, size: 18, width: 90 }, ...column(body(n), 120)]);
    const blocks = reflowPdf([heading(1), heading(2), heading(3)]);
    expect(texts(blocks)).toEqual([1, 2, 3].flatMap((n) => [titles[n - 1], body(n).join(" ")]));
  });

  it("leaves out the rotated stamp arXiv prints down the margin of page 1", () => {
    const blocks = reflowPdf([
      page(1, [
        { text: "arXiv:2301.10226v7 [cs.LG] 16 Jun 2024", x: 32, y: 500, width: 340, rotated: true },
        ...column(["the paper itself starts here", "and goes on from there."], 120),
      ]),
    ]);
    expect(texts(blocks)).toEqual(["the paper itself starts here and goes on from there."]);
  });
});

describe("reflowPdf — across pages", () => {
  it("joins a paragraph that continues on the next page", () => {
    const blocks = reflowPdf([
      page(1, column(["a paragraph that reaches the", "foot of the page and simply"], 120)),
      page(2, column(["runs on from there without", "a break of any kind at all."], 120)),
    ]);
    expect(texts(blocks)).toEqual([
      "a paragraph that reaches the foot of the page and simply runs on from there without a break of any kind at all.",
    ]);
  });

  it("leaves two paragraphs apart when the first one finished its sentence", () => {
    const blocks = reflowPdf([
      page(1, column(["a paragraph that reaches the", "foot of the page and ends."], 120)),
      page(2, column(["another paragraph opens the", "page that follows it."], 120)),
    ]);
    expect(blocks).toHaveLength(2);
  });

  it("names the page each block starts on", () => {
    const blocks = reflowPdf([
      page(1, column(["the first page says this."], 120)),
      page(2, column(["The second page says this."], 120)),
    ]);
    expect(blocks.map((b) => b.page)).toEqual([1, 2]);
  });
});

describe("reflowPdf — headings", () => {
  it("marks a short line set in larger type as a heading", () => {
    const blocks = reflowPdf([
      page(1, [
        { text: "Results", y: 100, size: 16, font: "display", width: 60 },
        ...column(["the section body follows", "immediately underneath it."], 100 + 24),
      ]),
    ]);
    expect(blocks[0]).toEqual({ kind: "heading", text: "Results", page: 1 });
    expect(blocks[1].kind).toBe("paragraph");
  });

  it("marks a numbered section title as a heading even at the body size", () => {
    const body = Array.from({ length: 10 }, (_, i) => `body line number ${i} of the section`);
    const blocks = reflowPdf([
      page(1, [
        { text: "3.1 Related Work", y: 100, width: 100 },
        ...column(body, 100 + PITCH * 2),
      ]),
    ]);
    expect(blocks[0].kind).toBe("heading");
  });

  it("leaves a long block of display type as a paragraph", () => {
    const long = "a pull quote set large enough to look like a heading but far too long to be one and running on well past any title";
    const blocks = reflowPdf([page(1, [{ text: long, y: 100, size: 16, width: 460 }])]);
    expect(blocks[0].kind).toBe("paragraph");
  });
});

describe("reflowPdf — other scripts", () => {
  it("joins CJK lines without inventing a word space", () => {
    const blocks = reflowPdf([
      page(1, [
        { text: "这是一个测试段落，用来检查", y: 100, width: 300 },
        { text: "中文的换行是否会插入空格。", y: 100 + PITCH, width: 300 },
      ]),
    ]);
    expect(blocks[0].text).toBe("这是一个测试段落，用来检查中文的换行是否会插入空格。");
  });

  it("joins CJK runs on one line without inventing a word space", () => {
    // pdf.js cuts a line of CJK into runs wherever the font changes; the gaps between
    // them are kerning, and a space in the middle of a sentence is damage.
    const blocks = reflowPdf([
      page(1, [
        { text: "这是一个", x: 72, y: 100, width: 44 },
        { text: "测试段落", x: 119, y: 100, width: 44 },
        { text: "，用来检查换行。", x: 166, y: 100, width: 88 },
      ]),
    ]);
    expect(blocks[0].text).toBe("这是一个测试段落，用来检查换行。");
  });

  it("keeps a space where CJK text is set a whole ideograph apart", () => {
    const blocks = reflowPdf([
      page(1, [
        { text: "第一列", x: 72, y: 100, width: 33 },
        { text: "第二列", x: 160, y: 100, width: 33 },
      ]),
    ]);
    expect(blocks[0].text).toBe("第一列 第二列");
  });

  it("joins a CJK paragraph that continues on the next page", () => {
    const blocks = reflowPdf([
      page(1, [{ text: "这一段落在第一页的末尾结束，但是句子", x: 72, y: 700, width: 400 }]),
      page(2, [{ text: "还没有写完，它在下一页继续写下去。", x: 72, y: 100, width: 400 }]),
    ]);
    expect(texts(blocks)).toEqual([
      "这一段落在第一页的末尾结束，但是句子还没有写完，它在下一页继续写下去。",
    ]);
  });

  it("reads a right-to-left page without failing", () => {
    const blocks = reflowPdf([
      page(1, [
        { text: "هذه فقرة تجريبية مكتوبة", x: 300, y: 100, width: 200 },
        { text: "باللغة العربية لاختبار", x: 300, y: 100 + PITCH, width: 200 },
      ]),
    ]);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].text).toContain("العربية");
  });

  it("returns nothing for a page with no text layer at all", () => {
    expect(reflowPdf([page(1, [])])).toEqual([]);
    expect(reflowPdf([])).toEqual([]);
  });
});

describe("recognising a PDF and naming it", () => {
  it("goes by the path, so a query string cannot fool it either way", () => {
    expect(looksLikePdfUrl("https://example.com/papers/2301.10226.pdf")).toBe(true);
    expect(looksLikePdfUrl("https://example.com/paper.PDF?download=1")).toBe(true);
    expect(looksLikePdfUrl("file:///Users/me/Downloads/report.pdf")).toBe(true);
    expect(looksLikePdfUrl("https://example.com/viewer?file=paper.pdf")).toBe(false);
    expect(looksLikePdfUrl("https://example.com/pdf")).toBe(false);
    expect(looksLikePdfUrl(undefined)).toBe(false);
    expect(looksLikePdfUrl("not a url at all")).toBe(false);
  });

  it("names the document after the file, decoded", () => {
    expect(pdfNameFromUrl("https://example.com/a/b/Annual%20Report.pdf")).toBe("Annual Report.pdf");
    expect(pdfNameFromUrl("file:///tmp/x.pdf")).toBe("x.pdf");
  });

  it("escapes the source into the reader's query", () => {
    expect(readerQuery("https://x.test/a b.pdf?v=1&w=2")).toBe(
      "?src=https%3A%2F%2Fx.test%2Fa%20b.pdf%3Fv%3D1%26w%3D2",
    );
  });
});
