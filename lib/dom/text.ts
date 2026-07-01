// lib/dom/text.ts — the scoring Unit (v2) + text utilities.
//
// v2 replaces the single-run Unit with a SEGMENT: one or more visual paragraphs
// ("parts") scored together. A part is a run of consecutive text nodes inside one
// block container. Most units have exactly one part; short neighbouring paragraphs
// (chat messages, list items, BR-separated prose, comment threads) are merged into
// multi-part units so text below the per-paragraph evidence floor still gets
// covered instead of being silently skipped.

/** One visual paragraph inside a unit: an inline run of text nodes + its block. */
export interface UnitPart {
  /** Ordered consecutive text nodes of the run. */
  nodes: Text[];
  /** Nearest block-laid-out ancestor of the run — render/measure anchor. */
  container: Element;
}

/** A scoreable segment (≥1 visual paragraph). */
export interface Unit {
  /** Stable per-scan id (e.g. "u_3f"); rendering keys off this, NOT array index. */
  id: string;
  /** The visual paragraphs scored together, in document order. */
  parts: UnitPart[];
  /** Joined text of all parts ("\n\n" between parts), trimmed per part. */
  text: string;
  /** Word count of `text` (Intl.Segmenter — CJK counts correctly). */
  wordCount: number;
  /** Document-order index at collect time (contract ScoreBlock.order). */
  order: number;
  /** First part's container — IntersectionObserver anchor. */
  topElement: Element;
  /** Last part's container — badge anchor. */
  container: Element;
  /** Claim flag: a result has rendered for this unit. */
  isScored: boolean;
}

// ---- thresholds -------------------------------------------------------------------

/**
 * Evidence floor per unit. Pangram's own policy: predictions are unreliable below
 * ~50 words (it cannot attribute below ~75). A unit is only emitted at ≥ this.
 */
export const MIN_UNIT_WORDS = 50;

/**
 * A run must carry at least this many words to participate in merging. Filters
 * bylines, timestamps, "Reply · Share" rows out of merged segments without
 * treating them as section boundaries.
 */
export const MIN_MERGE_WORDS = 8;

/** Hard storage cap for a single unit's text (pathological single-node dumps). */
export const MAX_UNIT_TEXT_CHARS = 20_000;

/**
 * Cap on the text actually SENT for scoring; cut at a sentence boundary. The
 * rendered unit still covers the full paragraph — long paragraphs must never be
 * split mid-flow at the surface (the M1 1000-char cap truncated the HF abstract
 * and dropped its tail).
 */
export const MAX_SCORE_CHARS = 4000;

// ---- extraction / normalization ---------------------------------------------------

/** The source text of one part = join of its text nodes' content. */
export function extractPartText(nodes: Text[]): string {
  let s = "";
  for (const n of nodes) s += n.textContent ?? "";
  return s;
}

/**
 * Normalize for hashing/cache: NFC, collapse whitespace, strip zero-width.
 * Do NOT lowercase or strip punctuation — detection is surface-sensitive.
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[​-‍﻿]/g, "") // zero-width
    .replace(/\s+/g, " ")
    .trim();
}

/** True if the text contains at least one letter in ANY script (incl. CJK). */
export function hasLetters(text: string): boolean {
  return /\p{L}/u.test(text);
}

// ---- segmenters (cached — constructing Intl.Segmenter per call is expensive) -------

type Seg = { segment(s: string): Iterable<{ segment: string; isWordLike?: boolean }> };

let _wordSeg: Seg | null | undefined;
function wordSegmenter(): Seg | null {
  if (_wordSeg === undefined) {
    try {
      _wordSeg = new (Intl as any).Segmenter(undefined, { granularity: "word" });
    } catch {
      _wordSeg = null;
    }
  }
  return _wordSeg ?? null;
}

let _sentSeg: Seg | null | undefined;
function sentenceSegmenter(): Seg | null {
  if (_sentSeg === undefined) {
    try {
      _sentSeg = new (Intl as any).Segmenter(undefined, { granularity: "sentence" });
    } catch {
      _sentSeg = null;
    }
  }
  return _sentSeg ?? null;
}

/** Word count via Intl.Segmenter (CJK-correct), whitespace-split fallback. */
export function countWords(text: string): number {
  const t = text.trim();
  if (!t) return 0;
  const seg = wordSegmenter();
  if (seg) {
    let n = 0;
    for (const s of seg.segment(t)) if ((s as any).isWordLike) n++;
    return n;
  }
  return t.split(/\s+/).filter(Boolean).length;
}

/** Sentence split (Intl.Segmenter sentence granularity, regex fallback). */
export function splitSentences(text: string): string[] {
  const seg = sentenceSegmenter();
  if (seg) {
    return [...seg.segment(text)].map((x) => x.segment).filter((s) => s.trim());
  }
  return text.split(/(?<=[.!?。！？])\s+/).filter((s) => s.trim());
}

/**
 * Truncate text for SCORING at a sentence boundary near `max` chars. Rendering
 * always covers the full unit; only the backend input is capped.
 */
export function truncateForScoring(text: string, max: number = MAX_SCORE_CHARS): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  // Prefer the last sentence end in the head; fall back to last whitespace; then hard cut.
  const m = head.match(/[\s\S]*[.!?。！？](?=\s|$)/);
  if (m && m[0].length >= max / 2) return m[0];
  const ws = head.lastIndexOf(" ");
  return ws >= max / 2 ? head.slice(0, ws) : head;
}

// ---- link density ------------------------------------------------------------------

/**
 * Fraction of the run's text inside <a> links. Article prose has some links but is
 * mostly plain text; nav menus / story-title lists are ~all links. High ratio marks
 * a non-prose run that also acts as a merge barrier.
 */
export function linkTextRatio(nodes: Text[]): number {
  let total = 0;
  let link = 0;
  for (const n of nodes) {
    const len = (n.textContent ?? "").trim().length;
    if (len === 0) continue;
    total += len;
    if (n.parentElement && n.parentElement.closest("a")) link += len;
  }
  return total > 0 ? link / total : 0;
}
