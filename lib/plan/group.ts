// lib/plan/group.ts — which paragraphs are read TOGETHER, whatever they were written in.
//
// A paragraph under the evidence floor is not thrown away. Short neighbours of one voice
// are read together in window-sized groups (the chip says ×N), and a short text that
// cannot stand alone joins the full paragraph beside it. Those rules were written for the
// DOM walk and lived inside it (lib/dom/walker.ts), tangled up with runs, containers and
// the scope survey — so a PDF, whose paragraphs come from geometry rather than from
// markup (lib/pdf/reflow.ts), got none of them and a paper's short paragraphs went
// unread.
//
// What is PURE about them lives here: no DOM, no pdf.js, nothing but word counts,
// character counts and the barriers between blocks. Two callers use it from opposite
// ends. The walker calls the pieces as it walks, because only it can say what stands
// beside what (proximity in the markup, the voice a run belongs to). lib/pdf/units.ts
// hands over the whole sequence at once and takes the groups back. Both get the same
// floor, the same window and the same even division, because there is one copy of them.
//
// The thresholds themselves are NOT redefined here — the floor is Pangram's published one
// (lib/dom/text.ts) and the window is the model's (lib/capture/windows.ts).
import { MIN_UNIT_WORDS } from "../dom/text";
import { WINDOW_CHARS } from "../capture/windows";

/** All the rules ever read of a block: how much writing it is. */
export interface Sized {
  /** Words in it — what the evidence floor counts. */
  readonly words: number;
  /** Characters of its text — what the model's window counts. */
  readonly chars: number;
}

/** Length of the text these blocks become as one unit: their texts, "\n\n" between them. */
export function groupChars(blocks: readonly Sized[]): number {
  let total = 0;
  for (const b of blocks) total += b.chars;
  return total + 2 * Math.max(0, blocks.length - 1);
}

export function groupWords(blocks: readonly Sized[]): number {
  let total = 0;
  for (const b of blocks) total += b.words;
  return total;
}

/** Enough writing to be judged at all (Pangram states predictions are unreliable below it). */
export function clearsFloor(blocks: readonly Sized[]): boolean {
  return groupWords(blocks) >= MIN_UNIT_WORDS;
}

/** Little enough for the model to read in ONE pass — one window, some 300 words. */
export function fitsWindow(blocks: readonly Sized[]): boolean {
  return groupChars(blocks) <= WINDOW_CHARS;
}

/** `blocks` in `n` consecutive pieces, each as near to an even share of the characters as
 *  the joints between two blocks allow. */
function evenPieces<T extends Sized>(blocks: readonly T[], n: number): T[][] {
  const total = groupChars(blocks);
  const pieces: T[][] = [];
  let piece: T[] = [];
  let seen = 0;
  for (const b of blocks) {
    const next = seen + b.chars + 2;
    const share = ((pieces.length + 1) * total) / n;
    if (piece.length > 0 && pieces.length < n - 1 && Math.abs(seen - share) <= Math.abs(next - share)) {
      pieces.push(piece);
      piece = [];
    }
    piece.push(b);
    seen = next;
  }
  pieces.push(piece);
  return pieces;
}

/**
 * A stretch of short blocks of one voice as the units it becomes. Closing a group the
 * moment it reached fifty words cut a 1767-word Zhihu answer of 49 paragraphs into 20
 * chips and a 288-word X post into four; reading the whole stretch as ONE unit would put
 * a single number on a thousand words, and what makes a chip worth having on a long text
 * is that it is fine-grained. So the stretch is divided into groups of at most one model
 * window (WINDOW_CHARS, some 300 words — about the mean length of the texts the model was
 * trained on, and what it judges in a single reading): ceil(total / window) of them, cut
 * between two blocks, as even as the blocks allow, so there is no small tail group. Every
 * group keeps the evidence floor; only where that cannot be had inside a window (words of
 * thirty letters) is a group longer, and read in windows like any long paragraph.
 */
export function modelSized<T extends Sized>(blocks: readonly T[]): T[][] {
  if (fitsWindow(blocks)) return [[...blocks]];
  const floor = (pieces: T[][]): boolean => pieces.every((p) => clearsFloor(p));
  const first = Math.ceil(groupChars(blocks) / WINDOW_CHARS);
  let best: T[][] | null = null;
  for (let n = first; n <= blocks.length; n++) {
    const pieces = evenPieces(blocks, n);
    if (!floor(pieces)) break;
    best = pieces;
    if (pieces.every((p) => fitsWindow(p))) break; // else a joint fell badly: one more
  }
  for (let n = first - 1; !best && n > 1; n--) {
    const pieces = evenPieces(blocks, n);
    if (floor(pieces)) best = pieces;
  }
  return best ?? [[...blocks]];
}

/** Where a stretch of short blocks goes when it cannot stand by itself. */
export type OrphanHome = "before" | "after" | null;

/**
 * NO ORPHANS INSIDE ONE VOICE. A stretch of short blocks under the floor used to be
 * dropped, and next to full paragraphs that is most of what went unjudged: a Substack
 * article lost 570 of its 2407 words that way (isolated paragraphs of 40 to 47 words
 * between full ones), a Zhihu answer the 13-word lead-in before a 57-word paragraph and
 * the 40-word close after an 82-word one. Such a text joins the full paragraph standing
 * next to it — the one BEFORE it by preference, else the one after — when the two still
 * fit one model window together. The chip then reads ×2.
 *
 * `beside` answers whether the paragraph on that side really stands next to this text;
 * what that means is the caller's, because it is the one thing that is not arithmetic
 * (proximity in the markup for a page, one column of one page for a PDF). It is asked
 * only for the side being considered, and only while the side exists.
 */
export function orphanHome<T extends Sized>(
  group: readonly T[],
  before: readonly T[] | null,
  after: T | null,
  beside: (side: "before" | "after") => boolean,
): OrphanHome {
  if (group.length === 0) return null;
  if (before !== null && beside("before") && fitsWindow([...before, ...group])) return "before";
  if (after !== null && beside("after") && fitsWindow([...group, after])) return "after";
  return null;
}

// ---- a whole sequence at once ------------------------------------------------------

/**
 * What one block is, as far as grouping is concerned. A caller that knows nothing about
 * its blocks says nothing and gets "prose".
 */
export type BlockRole =
  /** Ordinary text: read by itself above the floor, read with its neighbours below it. */
  | "prose"
  /** Read by itself above the floor, but never with anything else and nothing across it:
   *  a caption, a footnote, the front matter of a paper. */
  | "apart"
  /** Not writing, and a boundary: a heading, a table row, a line of author names. */
  | "barrier"
  /** Not writing, and not a boundary either — an equation number, a stray page number:
   *  passed over, and the text on both sides of it still reads as one stretch. */
  | "skip";

/** One block of a document, as the rules see it. */
export interface PlanBlock extends Sized {
  /** Default "prose". */
  role?: BlockRole;
  /** Nothing is read across the joint in front of this block: another column, another
   *  page, another section. */
  barrierBefore?: boolean;
}

/**
 * The units a sequence of blocks becomes, as groups of INDICES into it, in document
 * order. A block appears in at most one group; one that clears the floor is a group of
 * its own unless a short neighbour joined it; a short one that no neighbour could take is
 * in none (the evidence floor, by policy).
 *
 * This is the walker's assembler with the DOM taken out: a stretch of shorts is read to
 * its end and divided then (modelSized), a stretch too small joins the full paragraph
 * before or after it (orphanHome), and a barrier ends whatever was open. The walker
 * cannot call this — it learns what stands beside what only as it walks, and a page has
 * voices nested inside voices — so it calls the pieces above instead, and
 * test/unit.mjs checks that the two roads meet.
 */
export function groupBlocks(blocks: readonly PlanBlock[]): number[][] {
  interface Item extends Sized {
    index: number;
  }
  /** Finished units, with the index of their first block: a group is divided AFTER the
   *  full paragraph that closed it was read, so they complete out of document order. */
  const done: Item[][] = [];
  /** The short blocks being read together. */
  let group: Item[] = [];
  /** The last full paragraph, not let go yet: a short text after it may still join it. */
  let prev: Item[] | null = null;

  /** The stretch of shorts ends here — at a barrier, at the end, or at `following`, the
   *  full paragraph that comes right after it. Returns what joins `following`. */
  const endGroup = (following: Item | null): Item[] => {
    const g = group;
    group = [];
    let lead: Item[] = [];
    if (g.length > 0 && clearsFloor(g)) {
      for (const piece of modelSized(g)) done.push(piece);
    } else if (g.length > 0) {
      const home = orphanHome(g, prev, following, () => true);
      if (home === "before") (prev as Item[]).push(...g);
      else if (home === "after") lead = g;
      // else: below the floor with nobody to join — dropped (by policy).
    }
    if (prev) done.push(prev);
    prev = null;
    return lead;
  };

  blocks.forEach((block, index) => {
    const role = block.role ?? "prose";
    if (block.barrierBefore) endGroup(null);
    if (role === "skip") return;
    const item: Item = { index, words: block.words, chars: block.chars };
    if (role === "barrier") {
      endGroup(null);
      return;
    }
    if (role === "apart") {
      endGroup(null);
      if (clearsFloor([item])) done.push([item]);
      return;
    }
    if (clearsFloor([item])) {
      const lead = endGroup(item);
      prev = [...lead, item];
      return;
    }
    group.push(item);
  });
  endGroup(null);

  done.sort((a, b) => a[0].index - b[0].index);
  return done.map((items) => items.map((i) => i.index));
}
