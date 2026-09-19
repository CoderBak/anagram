// lib/pdf/reflow.ts — turning a PDF's text runs back into paragraphs.
//
// A PDF has no paragraphs. It has glyph runs placed at coordinates, and every
// paragraph the reader sees is an inference from geometry: which runs share a
// baseline, which baselines belong to the same column, where one block of text
// ends and the next begins. This is where the quality of the whole PDF feature is
// decided, so it lives here — pure, free of the DOM and of pdf.js types, and
// covered by test/node/pdf-reflow.test.ts with synthetic pages.
//
// COORDINATES. Everything is in page units with the origin at the page's TOP-LEFT
// and y growing DOWNWARD (lib/pdf/extract.ts flips pdf.js's bottom-up space), so
// "the top margin" is simply a small y and lines sort by y ascending.
//
// WHAT IT DOES NOT DO. Footnotes, reference lists, tables and formula fragments
// are left as the paragraphs and lines they look like. Being clever there means
// guessing, and the walker's own filters (name lists, symbol noise, link density,
// the 50-word floor) already skip most of it — a table row never reaches the
// daemon anyway. Ligatures are kept exactly as the PDF gives them; the scorer's
// canonical form folds ﬁ/ﬂ itself.

/** One run of glyphs as the extractor hands it over. */
export interface PdfTextItem {
  /** The run's text, exactly as the PDF encodes it. */
  str: string;
  /** Left edge of the run. */
  x: number;
  /** The run's baseline, measured DOWN from the top of the page. */
  y: number;
  /** Advance width of the run. */
  width: number;
  /** Rendered glyph height (the effective font size). */
  height: number;
  /** The extractor's opaque id for the font this run is set in ("g_d0_f3"). */
  fontName?: string;
  /** The PDF marked a line break after this run. Advisory: many producers lie. */
  hasEOL?: boolean;
  /**
   * The run is not horizontal left-to-right. arXiv stamps every page 1 with a
   * 90°-rotated identifier down the left margin, which lands on top of the body
   * text once you look at x/width alone — rotated runs are dropped outright.
   */
  rotated?: boolean;
}

/** One page's runs plus the page box they were placed in. */
export interface PdfPageText {
  /** 1-based page number, the way the reader prints it. */
  page: number;
  width: number;
  height: number;
  items: PdfTextItem[];
}

/** A block of reading-order text: what the reader renders as <h2> or <p>. */
export interface ReflowBlock {
  kind: "heading" | "paragraph";
  text: string;
  /** The page the block starts on. */
  page: number;
}

// ---- tuning ---------------------------------------------------------------------------
// Every constant below is a RATIO of something the page itself supplies (its own font
// size, its own line pitch, its own width), never an absolute point value: the same
// rules have to hold for a 6-point footnote and a 40-point slide.

/** Two runs share a line while their baselines are within this much of the larger size. */
const BASELINE_TOL = 0.55;
/** A gap wider than this share of the font size is a word space, not kerning. */
const SPACE_GAP = 0.2;
/** Below this many lines a page is a title page — not enough of a layout to read. */
const MIN_LINES_FOR_COLUMNS = 6;
/**
 * A column holds at least this share of an even split of the page's runs — half of a
 * 1/N share. At two columns that is the 0.25 the two-column rule always used; at three
 * it is 0.167, which a table's stray gap or a ragged indent never reaches.
 */
const COLUMN_EVEN_SHARE = 0.5;
/** A gutter narrower than this share of the page width is just word spacing. */
const GUTTER_MIN_WIDTH = 0.015;
/**
 * A gutter runs the height of the page. Cut the page's text into horizontal bands and a
 * real gutter is clear, with text on BOTH sides of it, in at least this share of the
 * bands that hold any text at all — which a table's column gaps (a few bands deep) and
 * the ragged indent of a list (text on one side only) never manage. Below half rather
 * than above, because a full-width title, abstract, spanning table or figure legitimately
 * covers the gutter for a third of the page and the columns below it are still columns.
 */
const GUTTER_BAND_SHARE = 0.45;
/** How many horizontal bands that test cuts a page into. */
const GUTTER_BANDS = 12;
/** How finely the page is scanned across for run-free columns of white. */
const GUTTER_CELLS = 400;
/** More columns than a newspaper prints: past this the page is a grid, not a text page. */
const MAX_COLUMNS = 5;
/**
 * A run has to cross a gutter by half its own type size on BOTH sides before it counts
 * as spanning it. A justified column's last word can end a point or two into the white
 * the gutter finder measured, and treating that as a spanning line would put the whole
 * line — both columns of it — back into one piece of reading order.
 */
const STRADDLE_TOL = 0.5;
/**
 * The margin bands, as a share of the page height. They are not symmetric because the
 * furniture is not: a running head sits just under the top edge, while a page number
 * sits ON the one-inch bottom margin, at 0.90 of the height, which the last line of a
 * densely set page can come within a few points of.
 */
const MARGIN_TOP = 0.09;
const MARGIN_BOTTOM = 0.88;
/** A repeating margin line must appear on at least this share of the pages. */
const RUNNING_MIN_SHARE = 0.5;
/** …and on at least this many, so a two-page document still loses its header. */
const RUNNING_MIN_PAGES = 2;
/**
 * A bound book runs two different heads: the author's name on the left-hand pages and
 * the title on the right-hand ones, so each of them appears on only half the document.
 * A head that keeps to one parity is judged against the pages of THAT parity, but it has
 * to have repeated this many times first — twice is what a section heading landing high
 * on two odd pages also does.
 */
const RUNNING_MIN_PARITY_PAGES = 3;
/** A vertical gap wider than this many line pitches starts a new paragraph. */
const PARA_GAP = 1.45;
/** A first-line indent of at least this much of the font size starts a paragraph. */
const INDENT = 0.5;
/** A line ending this far short of the column's right edge is a last line. */
const SHORT_LINE = 2;
/** Type this much larger than the document's body size reads as a heading. */
const HEADING_SIZE = 1.12;
/** A heading is short; anything longer is a paragraph set in display type. */
const HEADING_MAX_WORDS = 20;
/** A face carrying less than this share of the document's text is a display face. */
const DISPLAY_FONT_SHARE = 0.06;
/** "2", "3.1", "IV." — how a printed section announces itself. */
const SECTION_NUMBER = /^(?:\d+(?:\.\d+)*\.?|[IVXLC]+\.)\s+\p{Lu}/u;
/**
 * How an item of a list announces itself: a bullet, a number, a letter in brackets, a
 * reference's [7]. Each item is a block of its own — welding a list into one paragraph
 * gives the scorer a run of unrelated half-sentences, and every item after the first has
 * its own verdict to earn. The marker must be followed by a space, which is what keeps
 * "3.1" (a section) and "(2020)" (a citation opening a line) out of it.
 */
const LIST_MARKER = /^(?:[•▪◦‣·∙*–—]|\(?\d{1,3}[.)]|\[\d{1,3}\]|\(\p{L}\))\s/u;

// ---- small helpers --------------------------------------------------------------------

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
}

/** CJK and friends set text without word spaces — joining their lines must not add one. */
const CJK = /[⺀-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;

/**
 * …and the same holds WITHIN a line. CJK is set solid and pdf.js cuts its runs wherever
 * the font or the positioning changes, so a small gap between two ideographs is kerning,
 * never a word space — a space in CJK is a whole ideograph wide. Only a gap that wide is
 * a deliberate separation (a table cell, a column of a form) and keeps its space.
 */
const CJK_SPACE_GAP = 1;

/** Sentence-final punctuation, including the CJK and quoted-close forms. */
const SENTENCE_END = /[.!?。！？…](["'”’)\]]|\s)*$/u;

// ---- lines ----------------------------------------------------------------------------

/** One reconstructed line of text. `items` survive because columns are split per run. */
interface Line {
  page: number;
  /** Baseline of the line's dominant run, from the top of the page. */
  y: number;
  x0: number;
  x1: number;
  /** The dominant run's glyph height — a superscript never decides a line's size. */
  size: number;
  font: string;
  text: string;
  /** 0 = the only or the left column, 1 = the right column, -1 = spans the gutter. */
  col: number;
  items: PdfTextItem[];
}

/** Runs worth reading: something other than whitespace, and set the normal way round. */
function readableItems(page: PdfPageText): PdfTextItem[] {
  return page.items.filter((it) => !it.rotated && it.str.trim() !== "");
}

/**
 * Build one line from the runs that share its baseline. The DOMINANT run — the widest
 * one — supplies the baseline, the size and the font, so a superscript marker or a
 * footnote number cannot make a body line look small or start it half a line high.
 */
function makeLine(page: number, items: PdfTextItem[]): Line {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  let dominant = sorted[0];
  for (const it of sorted) if (it.width > dominant.width) dominant = it;

  let text = "";
  let prevRight = Number.NEGATIVE_INFINITY;
  for (const it of sorted) {
    const gap = it.x - prevRight;
    const size = Math.max(it.height, dominant.height);
    const solid = CJK.test(text.slice(-1)) && CJK.test(it.str.slice(0, 1));
    const needsSpace =
      text !== "" &&
      gap > size * (solid ? CJK_SPACE_GAP : SPACE_GAP) &&
      !/\s$/.test(text) &&
      !/^\s/.test(it.str);
    text += (needsSpace ? " " : "") + it.str;
    prevRight = it.x + it.width;
  }

  return {
    page,
    y: dominant.y,
    x0: Math.min(...sorted.map((i) => i.x)),
    x1: Math.max(...sorted.map((i) => i.x + i.width)),
    size: dominant.height,
    font: dominant.fontName ?? "",
    text: text.replace(/\s+/g, " ").trim(),
    col: 0,
    items: sorted,
  };
}

/**
 * Group a page's runs into lines by baseline. The tolerance is relative to the taller
 * of the two runs, which is what makes sub- and superscripts join the line they belong
 * to instead of opening one of their own.
 */
function groupIntoLines(page: PdfPageText): Line[] {
  const items = readableItems(page).sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: PdfTextItem[][] = [];
  let current: PdfTextItem[] = [];
  let base = 0;
  let size = 0;
  for (const it of items) {
    if (current.length === 0) {
      current = [it];
      base = it.y;
      size = it.height;
      continue;
    }
    if (it.y - base <= Math.max(size, it.height) * BASELINE_TOL) {
      current.push(it);
      size = Math.max(size, it.height);
    } else {
      rows.push(current);
      current = [it];
      base = it.y;
      size = it.height;
    }
  }
  if (current.length > 0) rows.push(current);
  return rows.map((r) => makeLine(page.page, r)).filter((l) => l.text !== "");
}

// ---- columns --------------------------------------------------------------------------

/** A candidate gutter: where it runs, and the share of the page's height it divides. */
interface Band {
  /** The middle of the best-divided part of the band — where the columns are cut. */
  at: number;
  width: number;
  divides: number;
}

/**
 * Where do this page's gutters run, if it has any?
 *
 * The test is made on RUNS, not on lines: two columns printed level with each other
 * share a baseline, so at this point nearly every line of a two-column page already
 * spans the full width and asking which lines cross a candidate split would answer
 * "all of them" on exactly the pages that have a gutter. A run is different — it is a
 * piece of one column — so a gutter is a vertical band no run covers.
 *
 * The page is cut into horizontal bands and scanned across into narrow cells. A cell
 * DIVIDES a band when no run covers it there and runs stand on both sides of it within
 * that band; a gutter is a run of neighbouring cells, wider than the type, that divide
 * most of the bands holding text. Asking it band by band rather than page-wide is what
 * tells a gutter from everything that looks like one: a table's column gaps divide only
 * the bands the table occupies, a ragged list's indent has text on one side only, and a
 * wide word space in justified text would have to fall in the same place in every line
 * of half the page. A spanning title costs the gutter only the bands it covers.
 *
 * Three columns are as ordinary as two — newspapers, posters, reference sections — so
 * the bands that divide best are taken in turn until the columns they would leave stop
 * carrying a real share of the page's runs, rather than one gutter being sought in the
 * middle of the page.
 */
function findGutters(lines: Line[], pageWidth: number): number[] {
  if (lines.length < MIN_LINES_FOR_COLUMNS) return [];
  const items = lines.flatMap((l) => l.items);
  const left = Math.min(...lines.map((l) => l.x0));
  const right = Math.max(...lines.map((l) => l.x1));
  const span = right - left;
  if (span < pageWidth * 0.4) return [];
  const size = median(lines.map((l) => l.size));
  const minWidth = Math.max(pageWidth * GUTTER_MIN_WIDTH, size * 1.2);

  const cell = span / GUTTER_CELLS;
  const top = Math.min(...items.map((it) => it.y));
  const depth = (Math.max(...items.map((it) => it.y)) - top) / GUTTER_BANDS || 1;
  // Which cells each band's runs cover, accumulated as differences so one pass over the
  // runs is enough however finely the page is scanned.
  const covers = Array.from({ length: GUTTER_BANDS }, () => new Float64Array(GUTTER_CELLS + 1));
  for (const it of items) {
    const band = Math.min(GUTTER_BANDS - 1, Math.max(0, Math.floor((it.y - top) / depth)));
    const from = Math.min(GUTTER_CELLS - 1, Math.max(0, Math.floor((it.x - left) / cell)));
    const to = Math.min(GUTTER_CELLS - 1, Math.ceil((it.x + it.width - left) / cell) - 1);
    if (to < from) continue;
    covers[band][from] += 1;
    covers[band][to + 1] -= 1;
  }

  const divides = new Int32Array(GUTTER_CELLS);
  let withText = 0;
  for (const band of covers) {
    const covered = new Uint8Array(GUTTER_CELLS);
    let first = -1;
    let last = -1;
    let depthCount = 0;
    for (let c = 0; c < GUTTER_CELLS; c++) {
      depthCount += band[c];
      if (depthCount > 0) {
        covered[c] = 1;
        if (first < 0) first = c;
        last = c;
      }
    }
    if (first < 0) continue; // a band of the page with no text in it at all
    withText++;
    for (let c = first + 1; c < last; c++) if (!covered[c]) divides[c] += 1;
  }
  if (withText === 0) return [];

  const bands: Band[] = [];
  let open = -1;
  for (let c = 0; c <= GUTTER_CELLS; c++) {
    const share = c < GUTTER_CELLS ? divides[c] / withText : 0;
    if (share >= GUTTER_BAND_SHARE) {
      if (open < 0) open = c;
      continue;
    }
    if (open >= 0) {
      if ((c - open) * cell >= minWidth) bands.push(bandOf(divides, open, c, left, cell, withText));
      open = -1;
    }
  }

  // The bands that divide best first, each kept only while every column it would leave
  // behind still carries its share of the runs.
  bands.sort((a, b) => b.divides - a.divides || b.width - a.width);
  const chosen: number[] = [];
  for (const band of bands) {
    if (chosen.length >= MAX_COLUMNS - 1) break;
    const next = [...chosen, band.at].sort((a, b) => a - b);
    if (columnsHold(items, next)) chosen.splice(0, chosen.length, ...next);
  }
  return chosen;
}

/**
 * Where inside a band of white the columns are actually cut. Not its middle: a justified
 * column's lines end at slightly different places, so the left half of the band is white
 * only in the bands whose lines ran short, and a cut there falls inside the longest
 * lines' last word. The cut goes through the part of the band that divides the MOST of
 * the page — the white every line leaves — which is the gutter proper.
 */
function bandOf(
  divides: Int32Array,
  from: number,
  to: number,
  left: number,
  cell: number,
  withText: number,
): Band {
  let best = 0;
  for (let c = from; c < to; c++) best = Math.max(best, divides[c]);
  let start = from;
  let run = 0;
  let longest = 0;
  for (let c = from; c <= to; c++) {
    if (c < to && divides[c] === best) {
      run += 1;
      continue;
    }
    if (run > longest) {
      longest = run;
      start = c - run;
    }
    run = 0;
  }
  return {
    at: left + (start + longest / 2) * cell,
    width: (to - from) * cell,
    divides: best / withText,
  };
}

/** Would these gutters leave every column with a real share of the page's runs? */
function columnsHold(items: PdfTextItem[], gutters: number[]): boolean {
  const counts = new Array<number>(gutters.length + 1).fill(0);
  for (const it of items) {
    const col = columnOf(it, gutters);
    if (col >= 0) counts[col]++;
  }
  const floor = (items.length * COLUMN_EVEN_SHARE) / counts.length;
  return counts.every((n) => n >= floor);
}

/** Which column a run sits in, or -1 when it spans a gutter and belongs to none. */
function columnOf(it: PdfTextItem, gutters: number[]): number {
  const tol = it.height * STRADDLE_TOL;
  const x1 = it.x + it.width;
  let col = 0;
  for (const g of gutters) {
    if (it.x < g - tol && x1 > g + tol) return -1;
    if ((it.x + x1) / 2 >= g) col++;
  }
  return col;
}

/**
 * Tag each line with its column, splitting the ones that only LOOK full-width: columns
 * printed level with each other share a baseline, so they arrive as one line with holes
 * in the middle. A line with a run that actually straddles a gutter is the real thing —
 * a title, a spanning header — and stays whole.
 */
function splitColumns(lines: Line[], gutters: number[]): Line[] {
  const out: Line[] = [];
  for (const line of lines) {
    const parts = new Map<number, PdfTextItem[]>();
    let spans = false;
    for (const it of line.items) {
      const col = columnOf(it, gutters);
      if (col < 0) {
        spans = true;
        break;
      }
      const part = parts.get(col);
      if (part) part.push(it);
      else parts.set(col, [it]);
    }
    if (spans) {
      out.push({ ...line, col: -1 });
      continue;
    }
    const cols = [...parts.keys()].sort((a, b) => a - b);
    if (cols.length <= 1) {
      out.push({ ...line, col: cols[0] ?? 0 });
      continue;
    }
    for (const col of cols) out.push({ ...makeLine(line.page, parts.get(col) ?? []), col });
  }
  return out;
}

/**
 * Reading order for a page in columns: a full-width line closes whatever every column
 * has collected and is read in place, so a paper's title and abstract come before its
 * columns and a spanning figure separates the columns above it from the ones below.
 */
function orderColumns(lines: Line[], columns: number): Line[] {
  const out: Line[] = [];
  let held: Line[][] = Array.from({ length: columns }, () => []);
  const flush = (): void => {
    for (const column of held) out.push(...column);
    held = Array.from({ length: columns }, () => []);
  };
  for (const line of lines) {
    if (line.col < 0 || line.col >= columns) {
      flush();
      out.push({ ...line, col: -1 });
    } else held[line.col].push(line);
  }
  flush();
  return out;
}

// ---- front matter -----------------------------------------------------------------------

/** An e-mail address or a URL: not something a paragraph of prose has in it. */
const CONTACT = /\S+@\S+|https?:\/\/|www\./;
/** The front matter never reaches past this share of the first page. */
const FRONT_MATTER_MAX_Y = 0.5;
/** …nor past this many lines, however centred the page under them goes on being. */
const FRONT_MATTER_MAX_LINES = 24;
/**
 * Two lines starting within this much of the font size of each other are flush. Tight,
 * because prose really is set to the same left edge to the point: what it has to survive
 * is the odd centred author line landing by chance under the one above it.
 */
const FLUSH_TOL = 0.15;
/** …and this many lines in a row have to be flush before the prose is believed. */
const FLUSH_RUN = 3;
/**
 * A paragraph's first line is indented by a few ems at most. A centred line sits far
 * further in than that, which is how the line that opens the abstract is told from the
 * centred label above it.
 */
const FIRST_LINE_INDENT_MAX = 4;
/** A label closing the front matter ("Abstract", "Summary") is at most this many words. */
const FRONT_MATTER_LABEL_WORDS = 3;

/**
 * The block between the first page's title and the document's first prose: the authors,
 * their affiliations and e-mail addresses, the word "Abstract". It is short, unpunctuated
 * and set in the wrong size to be body text, which is exactly why the heading rule takes
 * it and why a paragraph rule welds it to the abstract underneath.
 *
 * It starts at the title, which is the largest line in the top half of the first page —
 * anything above the title (a licence note, a journal's stamp) is the publisher talking
 * and reads as ordinary text. Every line under it is set on its own measure — centred, or
 * ranged under one of several columns of authors — so no two lines of it in a row start
 * in the same place. Body text is the opposite: flush left, line after line, justified or
 * ragged, in every language and every script. That one difference is the whole rule, and
 * it needs no keyword. The block ends at the first pair of flush lines, at the first
 * numbered section heading, or half way down the page, whichever comes first.
 *
 * Naming it buys two things: it is a segment of its own, so the authors can never be
 * welded to the abstract, and its blocks are not headings — except the title, and a short
 * label closing the block, because neither of those is what goes wrong. Everything in it
 * is short enough that the walker's 50-word floor leaves it unscored, which is right: an
 * author list is not prose and has no business carrying a verdict.
 */
function frontMatterOf(lines: Line[], pageHeight: number, bodySize: number): Set<Line> {
  const front = new Set<Line>();
  const limit = Math.min(lines.length, FRONT_MATTER_MAX_LINES);
  let title = -1;
  let largest = 0;
  for (let i = 0; i < limit; i++) {
    if (lines[i].y > pageHeight * FRONT_MATTER_MAX_Y) break;
    if (lines[i].size > largest) {
      largest = lines[i].size;
      title = i;
    }
  }
  if (title < 0 || largest < bodySize * HEADING_SIZE) return front;

  for (let i = title; i < limit; i++) {
    const line = lines[i];
    if (line.y > pageHeight * FRONT_MATTER_MAX_Y) break;
    if (i > title && SECTION_NUMBER.test(line.text)) break;
    if (isProse(lines, i)) break;
    front.add(line);
  }
  return front;
}

/**
 * Does the document's text start here? Three lines in a row set to the same left edge:
 * one coincidence of centring is common, three in a row is a paragraph. The line that
 * opens such a block from a first-line indent belongs to it, which is what keeps the
 * first line of an indented abstract out of the front matter and with its own paragraph.
 */
function isProse(lines: Line[], at: number): boolean {
  if (isFlushRun(lines, at)) return true;
  const line = lines[at];
  const first = lines[at + 1];
  if (line === undefined || first === undefined || !isFlushRun(lines, at + 1)) return false;
  const indent = line.x0 - first.x0;
  return indent > 0 && indent <= line.size * FIRST_LINE_INDENT_MAX;
}

/** Are the lines from here on set to the same left edge, line after line? */
function isFlushRun(lines: Line[], at: number): boolean {
  for (let i = at; i < at + FLUSH_RUN - 1; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    if (line === undefined || next === undefined) return false;
    if (Math.abs(next.x0 - line.x0) > line.size * FLUSH_TOL) return false;
    // A column of e-mail addresses is a list of authors, not a paragraph.
    if (CONTACT.test(line.text) || CONTACT.test(next.text)) return false;
  }
  return true;
}

// ---- running headers, footers and page numbers ----------------------------------------

/** "Page 3 of 12", "— 3 —", "iv", "3." — a page number in any of its usual costumes. */
const PAGE_NUMBER = /^[\s\-–—|·•[\]()]*(?:page\s*)?(?:\d{1,5}|[ivxlcdm]{1,7})(?:\s*(?:of|\/)\s*\d{1,5})?[.\s\-–—|·•[\]()]*$/i;

/** Digits vary from page to page; everything else about a running header does not. */
function runningKey(line: Line): string {
  return line.text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

/**
 * The lines to leave out: page numbers and running heads. A bare number in a margin
 * band goes on its own evidence; anything else has to prove itself by REPEATING at the
 * same height on most of the document's pages, which is the one thing a real first or
 * last paragraph never does.
 */
function findMarginLines(perPage: Line[][], pages: PdfPageText[]): Set<Line> {
  const drop = new Set<Line>();
  const candidates: { line: Line; band: "top" | "bottom"; rel: number }[] = [];

  perPage.forEach((lines, i) => {
    const height = pages[i].height || 1;
    for (const line of lines) {
      const rel = line.y / height;
      const band = rel <= MARGIN_TOP ? "top" : rel >= MARGIN_BOTTOM ? "bottom" : null;
      if (!band) continue;
      if (PAGE_NUMBER.test(line.text)) {
        drop.add(line);
        continue;
      }
      // A margin line that is a whole sentence is body text that happens to sit high
      // or low on the page — a running head is a label, not prose.
      if (line.text.split(/\s+/).length <= 14) candidates.push({ line, band, rel });
    }
  });

  const byKey = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const key = `${c.band}|${runningKey(c.line)}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(c);
    else byKey.set(key, [c]);
  }
  const evens = pages.filter((p) => p.page % 2 === 0).length;
  for (const bucket of byKey.values()) {
    const onPages = new Set(bucket.map((c) => c.line.page));
    if (onPages.size < RUNNING_MIN_PAGES) continue;
    const parities = new Set([...onPages].map((n) => n % 2));
    const against =
      parities.size === 1 && onPages.size >= RUNNING_MIN_PARITY_PAGES
        ? parities.has(0)
          ? evens
          : pages.length - evens
        : pages.length;
    if (onPages.size < against * RUNNING_MIN_SHARE) continue;
    // Same text at the same height: a header that moves is a heading, not furniture.
    const mid = median(bucket.map((c) => c.rel));
    for (const c of bucket) if (Math.abs(c.rel - mid) <= 0.02) drop.add(c.line);
  }
  return drop;
}

// ---- hyphenation ----------------------------------------------------------------------

/**
 * Prefixes English keeps hyphenated even when a line break lands right after them.
 * Deliberately short, and the test for an entry is strict: no common word may have a
 * syllable break immediately after it. "follow" fails that test ("follow-ing"), and so
 * does "long" ("long-est") and "in" ("in-formation") — which is exactly why "in-depth",
 * "follow-up" and "long-term" cannot be rescued by a list at all, and are left to the
 * document's own vocabulary below. Every entry here is a word we then fail to rejoin
 * when it really was a syllable break, so the list stays this short on purpose.
 */
const KEEP_HYPHEN = new Set([
  "self",
  "non",
  "semi",
  "quasi",
  "pseudo",
  "anti",
  "multi",
  "cross",
  "co",
  "ex",
  "well",
  "so",
]);

/** Hyphens that are NOT at a line end: the document telling us its own compounds. */
const INLINE_COMPOUND = /(\p{L}{2,})-(\p{L}{2,})/gu;

/** Whole words, for the fused spellings a document that writes "nonlinear" attests. */
const WORD = /\p{L}{3,}/gu;

/**
 * A line that stops this much of its column's measure short of the right edge was not
 * broken by the typesetter: a hyphenation break happens because the rest of the word did
 * not fit, so it leaves the line all but full. A quarter of the measure standing empty
 * means the hyphen is the word's own.
 */
const HYPHEN_MEASURE = 0.25;

/**
 * What the document says about its own compounds — the only dictionary available, and a
 * better one than any list we could ship, because it is this document's usage.
 */
interface Vocabulary {
  /** Compounds written WITH a hyphen where no line break forced it: "third-party". */
  hyphenated: Set<string>;
  /** Their first elements: "third", for the compound met only in its broken form. */
  heads: Set<string>;
  /** Every word written as one: "nonlinear" attests the mend of "non-/linear". */
  fused: Set<string>;
}

/** Collect the evidence once per document — it is read at every broken line. */
function vocabularyOf(texts: string[]): Vocabulary {
  const vocab: Vocabulary = { hyphenated: new Set(), heads: new Set(), fused: new Set() };
  for (const text of texts) {
    const lower = text.toLowerCase();
    for (const m of lower.matchAll(INLINE_COMPOUND)) {
      vocab.hyphenated.add(`${m[1]}-${m[2]}`);
      vocab.heads.add(m[1]);
    }
    for (const m of lower.matchAll(WORD)) vocab.fused.add(m[0]);
  }
  return vocab;
}

/**
 * Was the hyphen at the end of a line put there by the typesetter (drop it) or is it
 * part of the word (keep it)? Nothing short of a dictionary can answer that for every
 * case, so the rule weighs only the evidence the document itself supplies, in this order:
 *
 *   (a) the document writes "in-depth" somewhere no line break forced it to  → keep;
 *       it writes "straightforward" as one word somewhere                    → join.
 *       This is the strongest signal there is and it outranks everything below.
 *   (b) the stem carries a hyphen of its own ("state-of-the-/art")           → keep,
 *       and so does the continuation ("state-/of-the-art").
 *   (c) the continuation opens in upper case or with a digit ("Anglo-/Saxon",
 *       "COVID-/19"), or the stem is an acronym ("AI-/generated"), or the stem is a
 *       single letter ("e-/mail", "x-/ray")                                  → keep.
 *   (d) the stem is one of the modifiers above                               → keep.
 *   (e) lower case broken to lower case, with nothing said against it        → join,
 *       which is what a line break in running text nearly always is.
 *
 * The cost of (e) is visible and accepted: a compound the document never spells out and
 * no rule above catches — "in-/depth" in a document that writes it exactly once, broken
 * — comes back fused. Spending a kept hyphen on every unattested compound instead would
 * leave far more real words ("straightfor-ward") broken, which reads worse to a scorer.
 */
function dehyphenates(stem: string, head: string, vocab: Vocabulary): boolean {
  if (!/^\p{Ll}/u.test(head)) return false;
  if (!/^\p{L}{2,}$/u.test(stem)) return false;
  if (stem === stem.toUpperCase()) return false;
  const next = /^\p{L}+(?:-\p{L}+)*/u.exec(head)?.[0] ?? "";
  if (next.includes("-")) return false;
  const lower = stem.toLowerCase();
  const tail = next.toLowerCase();
  if (vocab.hyphenated.has(`${lower}-${tail}`)) return false;
  if (vocab.fused.has(lower + tail)) return true;
  if (vocab.heads.has(lower)) return false;
  return !KEEP_HYPHEN.has(lower);
}

/** How a line ended, for the two decisions that need more than the text itself. */
interface Break {
  /** The line stopped so far short of its measure that no break was forced on it. */
  short?: boolean;
}

/** Append `next` to a paragraph that already reads `text`, mending the break. */
function appendLine(text: string, next: string, vocab: Vocabulary, br: Break = {}): string {
  if (text === "") return next;
  // The whole token is captured, hyphens and all, so "state-of-the-" arrives at the
  // test below as "state-of-the" and is refused for carrying a hyphen of its own.
  const hyphen = /(\S+)[-‐­]$/u.exec(text);
  if (hyphen && !br.short && dehyphenates(hyphen[1], next, vocab)) return text.slice(0, -1) + next;
  if (hyphen) return text + next; // a real hyphen: no space swallowed the break
  if (CJK.test(text.slice(-1)) && CJK.test(next.slice(0, 1))) return text + next;
  return text + " " + next;
}

// ---- blocks ---------------------------------------------------------------------------

/** A block still knowing which run of lines it came from, so joins can be judged. */
interface Draft {
  kind: "heading" | "paragraph";
  text: string;
  page: number;
  /** Identifies the page+column the block was set in — the unit a join crosses. */
  segment: string;
  size: number;
  font: string;
  /** The block's last line stopped short of the column's right edge. */
  endsShort: boolean;
  /** The block is part of the first page's front matter, and reads as none of the rest. */
  front: boolean;
}

/**
 * A maximal run of consecutive lines set in the same column of the same page — and the
 * front matter is a column of its own, so nothing of it can share a block with the text.
 */
function segments(lines: Line[], front: Set<Line>): Line[][] {
  const out: Line[][] = [];
  let current: Line[] = [];
  let key = "";
  for (const line of lines) {
    const k = `${line.page}:${line.col}:${front.has(line) ? "front" : ""}`;
    if (k !== key && current.length > 0) {
      out.push(current);
      current = [];
    }
    key = k;
    current.push(line);
  }
  if (current.length > 0) out.push(current);
  return out;
}

/**
 * Cut one column's lines into paragraphs. Four signals, any one of which is enough:
 * a vertical gap wider than the column's own line pitch, a first-line indent where the
 * line before was flush, a change of type size, and a last line that stopped short
 * followed by a line that starts like a new sentence. Together they cover both of the
 * paragraph conventions printed text uses — blank line, and indent — without needing
 * to know which one the document chose.
 */
function paragraphsOf(lines: Line[], vocab: Vocabulary, front: boolean): Draft[] {
  const pitches: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const d = lines[i].y - lines[i - 1].y;
    if (d > 0) pitches.push(d);
  }
  const pitch = median(pitches) || median(lines.map((l) => l.size)) * 1.2 || 1;
  const leftEdge = percentile(lines.map((l) => l.x0), 0.15);
  const rightEdge = percentile(lines.map((l) => l.x1), 0.85);
  const measure = Math.max(rightEdge - leftEdge, 1);

  const out: Draft[] = [];
  let group: Line[] = [];
  const flush = (): void => {
    if (group.length === 0) return;
    let text = "";
    let previous: Line | null = null;
    for (const l of group) {
      const short = previous !== null && previous.x1 < rightEdge - measure * HYPHEN_MEASURE;
      text = appendLine(text, l.text, vocab, { short });
      previous = l;
    }
    text = text.replace(/\s+/g, " ").trim();
    if (text !== "") {
      const last = group[group.length - 1];
      let widest = group[0];
      for (const l of group) if (l.x1 - l.x0 > widest.x1 - widest.x0) widest = l;
      out.push({
        kind: "paragraph",
        text,
        page: group[0].page,
        segment: `${group[0].page}:${group[0].col}${front ? ":front" : ""}`,
        size: median(group.map((l) => l.size)),
        font: widest.font,
        endsShort: last.x1 < rightEdge - last.size * SHORT_LINE,
        front,
      });
    }
    group = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // A line that ends mid-word is never a paragraph's last line, whatever else the
    // geometry says — the hyphen is the typesetter telling us so.
    if (i > 0 && !/[-‐­]$/.test(lines[i - 1].text)) {
      const prev = lines[i - 1];
      const gap = line.y - prev.y;
      // A list item's second line is ranged under its text, past the marker, and that
      // hanging indent is not a new paragraph — it is the same item still being read.
      const hanging = LIST_MARKER.test(prev.text);
      const indented =
        !hanging &&
        line.x0 > leftEdge + line.size * INDENT &&
        prev.x0 <= leftEdge + prev.size * INDENT;
      const item = LIST_MARKER.test(line.text);
      const resized = Math.abs(line.size - prev.size) > Math.max(line.size, prev.size) * 0.15;
      const shortBefore = prev.x1 < rightEdge - prev.size * SHORT_LINE;
      const startsFresh = /^[\p{Lu}\p{Lt}\d"“'‘([]/u.test(line.text);
      // In the front matter every line is its own item — a name, an address, a label —
      // unless it is flush with the line above it and so a continuation of it.
      const moved = front && Math.abs(line.x0 - prev.x0) > line.size * FLUSH_TOL;
      if (
        gap > pitch * PARA_GAP ||
        indented ||
        item ||
        resized ||
        moved ||
        (shortBefore && startsFresh)
      ) {
        flush();
      }
    }
    group.push(line);
  }
  flush();
  return out;
}

/**
 * Sew a paragraph back together across a column or page break. A paragraph that really
 * continues never ends in sentence punctuation and never resumes in upper case, and a
 * broken word at the boundary is mended exactly as one inside a paragraph is.
 */
function joinAcrossSegments(drafts: Draft[], vocab: Vocabulary): Draft[] {
  const out: Draft[] = [];
  for (const d of drafts) {
    const prev = out[out.length - 1];
    const continues =
      prev &&
      prev.kind === "paragraph" &&
      d.kind === "paragraph" &&
      !prev.front &&
      !d.front &&
      prev.segment !== d.segment &&
      !prev.endsShort &&
      !SENTENCE_END.test(prev.text) &&
      // Lower case is what a continuation looks like in a cased script. CJK has no case,
      // so an ideograph opening the block is the most its script can say, and the tests
      // above — a full last line and no sentence end — carry the decision there.
      (/^\p{Ll}/u.test(d.text) || CJK.test(d.text.slice(0, 1)));
    if (continues) {
      prev.text = appendLine(prev.text, d.text, vocab);
      prev.endsShort = d.endsShort;
      continue;
    }
    out.push({ ...d });
  }
  return out;
}

/**
 * Headings are the one structural distinction worth drawing: the walker never scores a
 * heading and treats it as a topic boundary, so getting them right keeps two unrelated
 * sections out of the same verdict. Three kinds of evidence, all requiring a short
 * block: type larger than the document's body, a face the document barely uses
 * elsewhere, and a printed section number at the front.
 */
function classifyHeadings(drafts: Draft[], bodySize: number, displayFonts: Set<string>): void {
  for (const d of drafts) {
    if (d.front) continue;
    if (d.text.split(/\s+/).length > HEADING_MAX_WORDS) continue;
    const display = displayFonts.has(d.font) || SECTION_NUMBER.test(d.text);
    if (d.size >= bodySize * HEADING_SIZE || (display && !SENTENCE_END.test(d.text))) {
      d.kind = "heading";
    }
  }
  classifyFrontMatter(drafts.filter((d) => d.front), bodySize);
}

/**
 * The front matter keeps two headings and no more: the title, which is the largest thing
 * on the page and the one heading a reader would agree with, and a short label closing
 * the block ("Abstract", "Summary"), which announces the text under it. The authors, the
 * affiliations and the addresses between them are blocks of their own — not headings,
 * because a heading is a topic boundary to the walker, and not prose, because nothing
 * joins them to the paragraph below.
 */
function classifyFrontMatter(front: Draft[], bodySize: number): void {
  if (front.length === 0) return;
  const largest = Math.max(...front.map((d) => d.size));
  front.forEach((d, i) => {
    const words = d.text.split(/\s+/).length;
    const title = d.size === largest && d.size >= bodySize * HEADING_SIZE;
    const label =
      i === front.length - 1 && words <= FRONT_MATTER_LABEL_WORDS && !CONTACT.test(d.text);
    d.kind = (title && words <= HEADING_MAX_WORDS) || label ? "heading" : "paragraph";
  });
}

// ---- the entry point ------------------------------------------------------------------

/**
 * Rebuild a document's paragraphs from its pages' text runs. Pages may be a prefix of
 * the document (the reader extracts progressively); running-head detection then works
 * from what it has, which is why the reader only renders once it holds several pages.
 */
export function reflowPdf(pages: PdfPageText[]): ReflowBlock[] {
  if (pages.length === 0) return [];

  const perPage = pages.map((p) => {
    const lines = groupIntoLines(p);
    const gutters = findGutters(lines, p.width);
    return gutters.length === 0
      ? lines
      : orderColumns(splitColumns(lines, gutters), gutters.length + 1);
  });

  const drop = findMarginLines(perPage, pages);
  const lines = perPage.flat().filter((l) => !drop.has(l));
  if (lines.length === 0) return [];

  // The body size is the size most CHARACTERS are set in, not the size most lines are:
  // a page of footnotes must not redefine what "normal" means for the document.
  const weighted: number[] = [];
  for (const l of lines) {
    const weight = Math.max(1, Math.round(l.text.length / 8));
    for (let i = 0; i < weight; i++) weighted.push(l.size);
  }
  const bodySize = median(weighted);

  // A face carrying almost none of the document's text is a display face — the bold
  // used for section titles, the small caps of a running head that escaped the margin
  // rule. It is the only way to tell a bold heading from body text at the same size.
  const charsByFont = new Map<string, number>();
  let totalChars = 0;
  for (const l of lines) {
    charsByFont.set(l.font, (charsByFont.get(l.font) ?? 0) + l.text.length);
    totalChars += l.text.length;
  }
  const displayFonts = new Set<string>();
  for (const [font, chars] of charsByFont) {
    if (font !== "" && chars < totalChars * DISPLAY_FONT_SHARE) displayFonts.add(font);
  }

  // Heading classification comes BEFORE the cross-segment join, so a section title at
  // the top of a column can never be swallowed by the paragraph that ended above it.
  const vocab = vocabularyOf(lines.map((l) => l.text));
  const front = frontMatterOf(perPage[0].filter((l) => !drop.has(l)), pages[0].height, bodySize);
  const drafts = segments(lines, front).flatMap((s) => paragraphsOf(s, vocab, front.has(s[0])));
  classifyHeadings(drafts, bodySize, displayFonts);

  return joinAcrossSegments(drafts, vocab).map(({ kind, text, page }) => ({ kind, text, page }));
}
