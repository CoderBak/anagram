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
