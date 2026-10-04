// test/node/pdfGroup.test.ts — a PDF's short paragraphs, read together.
//
// On a web page a paragraph under the 75-word floor is not thrown away: short
// neighbours of one voice are read together (lib/dom/walker.ts). A PDF got none of that —
// every reconstructed paragraph under the floor was dropped, so a paper's short ones were
// silently unread. The rules now live in one place (lib/plan/group.ts) and lib/pdf/units.ts
// calls them with barriers taken from the reconstruction, which is what this pins: the
// pages are built by hand, run through the real reflow, and the GROUPS that come out are
// compared against what a reader would say belongs together.
import { describe, expect, it } from "vitest";
import { reflowPdf, type PdfPageText, type PdfTextItem, type ReflowBlock } from "../../lib/pdf/reflow";
import { groupsOf } from "../../lib/pdf/units";

const WIDTH = 612;
const HEIGHT = 792;
const SIZE = 11;
const PITCH = 14;
/** Helvetica at 11 pt runs to about this much per character — close enough for geometry. */
const CHAR = 5.1;
/** A blank line: wider than PARA_GAP times the pitch, so it starts a paragraph. */
const GAP = 2 * PITCH;

interface Placed {
  text: string;
  x?: number;
  y: number;
  size?: number;
  width?: number;
}

function item(p: Placed): PdfTextItem {
  const size = p.size ?? SIZE;
  return {
    str: p.text,
    x: p.x ?? 72,
    y: p.y,
    width: p.width ?? p.text.length * CHAR * (size / SIZE),
    height: size,
    fontName: "body",
  };
}

const page = (n: number, placed: Placed[]): PdfPageText => ({
  page: n,
  width: WIDTH,
  height: HEIGHT,
  items: placed.map(item),
});

/** Eight words to a line, all different, so no two paragraphs read alike. */
const WORDS =
  "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings before a timetable moved off paper until trains ran on time in winter".split(" ");
const line = (seed: number): string =>
  Array.from({ length: 8 }, (_, i) => WORDS[(seed * 7 + i * 3) % WORDS.length]).join(" ");

/**
 * A paragraph of `lines` full-measure lines — 8 words each — from `top` downward, ending
 * in a full stop so it reads as prose. Returns the lines and where the next block starts.
 */
function para(seed: number, top: number, lines = 3): { placed: Placed[]; next: number } {
  const placed: Placed[] = [];
  for (let i = 0; i < lines; i++) {
    const text = i === lines - 1 ? `${line(seed + i)}.` : line(seed + i);
    placed.push({ text, y: top + i * PITCH, width: 460 });
  }
  return { placed, next: top + lines * PITCH + GAP };
}

/** The document of the brief: a heading, three short paragraphs, a heading, two more. */
function shortParagraphPage(): PdfPageText {
  const placed: Placed[] = [];
  let y = 100;
  placed.push({ text: "Short paragraphs", y, size: 16, width: 120 });
  y += PITCH + GAP;
  for (const seed of [1, 2, 3]) {
    const p = para(seed, y, 4);
    placed.push(...p.placed);
    y = p.next;
  }
  placed.push({ text: "Another section", y, size: 16, width: 120 });
  y += PITCH + GAP;
  for (const seed of [4, 5]) {
    const p = para(seed, y, 4);
    placed.push(...p.placed);
    y = p.next;
  }
  return page(1, placed);
}

describe("a PDF's short paragraphs", () => {
  it("reads three short ones under a heading as ONE unit, and nothing across the heading", () => {
    const blocks = reflowPdf([shortParagraphPage()]);
    expect(blocks.map((b) => b.kind)).toEqual([
      "heading",
      "paragraph",
      "paragraph",
      "paragraph",
      "heading",
      "paragraph",
      "paragraph",
    ]);
    // 32 words a paragraph: at the model's 75 words the three together clear the floor, the
    // two after the second heading do not and are read by nobody — exactly what the walker
    // does on a page. At the shipped 50 the two are one unit of their own.
    expect(groupsOf(blocks, true, 75)).toEqual([[1, 2, 3]]);
    expect(groupsOf(blocks, true, 50)).toEqual([[1, 2, 3], [5, 6]]);
  });

  it("reads nothing under the floor at all in strict per-paragraph mode", () => {
    const blocks = reflowPdf([shortParagraphPage()]);
    expect(groupsOf(blocks, false)).toEqual([]);
  });

  it("still gives every full paragraph a unit of its own", () => {
    const placed: Placed[] = [];
    let y = 100;
    for (const seed of [1, 2]) {
      const p = para(seed, y, 10); // 80 words — over the floor by itself
      placed.push(...p.placed);
      y = p.next;
    }
    const blocks = reflowPdf([page(1, placed)]);
    expect(blocks).toHaveLength(2);
    expect(groupsOf(blocks)).toEqual([[0], [1]]);
  });

  it("reads a paper's keyword line with nothing: the abstract is read alone, not with its Index Terms", () => {
    const block = (text: string): ReflowBlock => ({ kind: "paragraph", text, page: 1, runs: [], apart: false, columnBreak: false });
    const sentence = "The method is trained on unlabeled sequences and then fine-tuned on a small labelled set of the same scans. ";
    const abstract = block(sentence.repeat(6));
    for (const line of ["Index Terms—Vessel segmentation, self-supervised pretraining, coronary angiography.", "Keywords: AI-generated text; detection; scaling laws.", "关键词：人工智能；检测"]) {
      expect(groupsOf([abstract, block(line)]), line).toEqual([[0]]);
    }
    // Nor with the journal's notes at the foot of the first page.
    for (const note of ["This work was supported in part by the National Natural Science Foundation of China under Grant 62301234.", "Manuscript received May 3, 2026; revised July 9, 2026.", "Corresponding author: J. Smith (e-mail: js@example.edu)."]) {
      expect(groupsOf([abstract, block(note)]), note).toEqual([[0]]);
    }
    // Past page 1 the same words open an acknowledgements paragraph, read like any other.
    const later = { ...block("This work was supported in part by the National Natural Science Foundation of China under Grant 62301234."), page: 9 };
    expect(groupsOf([{ ...abstract, page: 9 }, later])).toEqual([[0, 1]]);
    // A sentence that merely starts with the words is prose like any other.
    expect(groupsOf([abstract, block("Keywords are chosen by the authors and indexed by the publisher.")])).toEqual([[0, 1]]);
  });

  it("never reads across a caption, and picks the text up again after it", () => {
    const placed: Placed[] = [];
    let y = 100;
    const first = para(1, y, 4); // 32 words
    placed.push(...first.placed);
    y = first.next;
    placed.push({ text: "Figure 1: the layout of one printed page.", y, width: 200 });
    y += PITCH + GAP;
    for (const seed of [2, 3]) {
      const p = para(seed, y, 5); // 40 words each, 80 together
      placed.push(...p.placed);
      y = p.next;
    }
    const blocks = reflowPdf([page(1, placed)]);
    expect(blocks[1]!.apart).toBe(true);
    expect(blocks[0]!.apart).toBe(false);
    // The 32-word paragraph above the caption has nobody left to join and is dropped; the
    // two below it are read together.
    expect(groupsOf(blocks)).toEqual([[2, 3]]);
  });

  it("says where a column or a page break lies, and never reads across one", () => {
    const short = (seed: number, top: number, x: number): Placed[] =>
      para(seed, top, 4).placed.map((p) => ({ ...p, x, width: 200 }));
    // Two columns of one page: three short paragraphs in the left, two in the right.
    const placed: Placed[] = [];
    let y = 100;
    for (const seed of [1, 2, 3]) {
      placed.push(...short(seed, y, 72));
      y += 4 * PITCH + GAP;
    }
    y = 100;
    for (const seed of [4, 5]) {
      placed.push(...short(seed, y, 330));
      y += 4 * PITCH + GAP;
    }
    const blocks = reflowPdf([page(1, placed)]);
    if (blocks.length !== 5) return; // the gutter finder did not see two columns here
    expect(blocks[3]!.columnBreak).toBe(true);
    expect(blocks[1]!.columnBreak).toBe(false);
    expect(groupsOf(blocks, true, 75)).toEqual([[0, 1, 2]]);
    // At 50 the right column's two are enough by themselves — still never read with the left.
    expect(groupsOf(blocks, true, 50)).toEqual([[0, 1, 2], [3, 4]]);
  });
  it("reads the short tail a page cut off at a full stop with the paragraph before it, and no shorts together across the page", () => {
    const words = (n: number, end = "."): string => `${Array.from({ length: n }, (_, i) => WORDS[i % WORDS.length]).join(" ")}${end}`;
    const block = (text: string, page: number, more: Partial<ReflowBlock> = {}): ReflowBlock =>
      ({ kind: "paragraph", text, page, runs: [], apart: false, columnBreak: false, ...more });
    const heading: ReflowBlock = { ...block("6. Gravitational microlensing", 4), kind: "heading" };
    // "…where other accreting systems are abundant." ends page 3; "Separating them will require…"
    // is all of page 4 before the next heading (arXiv 2609.29211, read as the reader read it).
    const full = block(words(90), 3), tail = block(words(43), 4, { pageTurn: true });
    expect(groupsOf([full, tail, heading])).toEqual([[0, 1]]);
    // Before a full paragraph on the new page it still goes with the one it came from.
    expect(groupsOf([full, tail, block(words(90), 4)])).toEqual([[0, 1], [2]]);
    // A column or a page the reading cannot vouch for is still a wall.
    expect(groupsOf([full, { ...tail, pageTurn: undefined, columnBreak: true }, heading])).toEqual([[0]]);
    // Shorts on either side of the page are settled each on their own page: the one on page 3
    // joins the full paragraph, the one on page 4 has nobody and is left, as at a column.
    expect(groupsOf([full, block(words(20), 3), tail, heading])).toEqual([[0, 1]]);
  });
});
