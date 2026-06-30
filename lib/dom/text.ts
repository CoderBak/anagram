// lib/dom/text.ts

/** A scoreable paragraph unit. */
export interface Unit {
  id: string;            // stable scan id, assigned at emit time
  nodes: Text[];         // ordered consecutive text nodes (the inline run)
  parentElement: Element; // nearest BLOCK ancestor → the badge anchor
  topElement: Element | null;    // first block-level element spanned (viewport gating)
  bottomElement: Element | null; // last block-level element spanned (viewport gating)
  text: string;          // extractUnitText(unit) result, cached
  isScored: boolean;     // claim flag (was reference's isTranslated)
}

/** The source text of a unit = join of its text nodes' content. (pageTranslator.js:782) */
export function extractUnitText(nodes: Text[]): string {
  return nodes.map((n) => n.textContent ?? "").join("");
}

/**
 * Normalize for hashing/cache (design §4.4): NFC, collapse whitespace, strip zero-width.
 * Do NOT lowercase or strip punctuation — detection is surface-sensitive.
 */
export function normalizeText(s: string): string {
  return s
    .normalize("NFC")
    .replace(/[​-‍﻿]/g, "") // zero-width
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The min-length / noise floor the reference lacked at node level (design §2.2 step 7).
 * Reject units that are too short, pure numbers/punctuation, or single non-alpha chars.
 */
// Pangram enforces a 50-word minimum ("enough context to make a prediction you can trust";
// it can't even attribute below ~75 words) — we match it. The model is unreliable on short
// text (design: short → "insufficient"), and this also skips headlines/titles/metadata.
// 50 words ≈ 250–300 chars; MIN_CHARS is a secondary floor that never binds before words.
const MIN_CHARS = 200;
const MIN_WORDS = 50;
export function isInvalidText(text: string): boolean {
  const t = text.trim();
  if (t.length < MIN_CHARS) return true;
  if (!/[A-Za-zÀ-ɏЀ-ӿ]/.test(t)) return true; // no letters at all
  // Word count via Intl.Segmenter when available, else whitespace split.
  let words: number;
  if (typeof Intl !== "undefined" && (Intl as any).Segmenter) {
    const seg = new (Intl as any).Segmenter(undefined, { granularity: "word" });
    words = [...seg.segment(t)].filter((x: any) => x.isWordLike).length;
  } else {
    words = t.split(/\s+/).filter(Boolean).length;
  }
  if (words < MIN_WORDS) return true;
  return false;
}

/** Sentence split for sentence_flags alignment (Intl.Segmenter sentence granularity). */
export function splitSentences(text: string): string[] {
  if (typeof Intl !== "undefined" && (Intl as any).Segmenter) {
    const seg = new (Intl as any).Segmenter(undefined, { granularity: "sentence" });
    return [...seg.segment(text)].map((x: any) => x.segment).filter((s) => s.trim());
  }
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim());
}

/**
 * Fraction of a unit's text that sits inside <a> links. Article prose has some links but is
 * mostly plain text (low ratio); story titles, nav menus and "see also" lists are ~all links
 * (high ratio) — so a high ratio marks a non-prose block worth skipping.
 */
export function linkTextRatio(nodes: Text[]): number {
  let total = 0;
  let link = 0;
  for (const n of nodes) {
    const len = (n.textContent ?? "").length;
    if (len === 0) continue;
    total += len;
    if (n.parentElement && n.parentElement.closest("a")) link += len;
  }
  return total > 0 ? link / total : 0;
}
