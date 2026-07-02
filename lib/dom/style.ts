// lib/dom/style.ts — scan-scoped computed-style cache + layout classification.
//
// The v2 walker segments the page by HOW elements are LAID OUT (computed display),
// not by what tag they use — that is what makes visual paragraphs line up with
// scoring units on <div>/<span>-built sites (Zhihu, X, most React/Vue SPAs) and
// keeps inline markup (<code>, <em>, links) from splitting a sentence in half.
//
// getComputedStyle is the expensive primitive here, so every walk carries one
// StyleCache and each element is resolved at most once per scan. The cached
// CSSStyleDeclaration is live, but a scan is synchronous, so reads are coherent.
import { INLINE_FALLBACK_TAGS, tagOf } from "./tags";

export interface StyleCache {
  /** Computed style for el, resolved at most once per scan. Null if unavailable. */
  get(el: Element): CSSStyleDeclaration | null;
}

export function createStyleCache(): StyleCache {
  const cache = new WeakMap<Element, CSSStyleDeclaration | null>();
  return {
    get(el: Element): CSSStyleDeclaration | null {
      let cs = cache.get(el);
      if (cs === undefined) {
        try {
          cs = getComputedStyle(el);
        } catch {
          cs = null;
        }
        cache.set(el, cs);
      }
      return cs;
    },
  };
}

/** True if this computed display participates in inline flow (does not break a paragraph). */
export function isInlineDisplay(display: string): boolean {
  return display.startsWith("inline") || display === "ruby";
}

/**
 * Layout classification for one element during a walk. "inline" accumulates into the
 * current run; "block" closes it; "contents"/"skip" are transparent / pruned.
 */
export type FlowClass = "inline" | "block" | "contents" | "hidden";

/**
 * Classify how `el` participates in text flow. When the computed display is empty
 * (detached/foreign contexts) we fall back to the classic tag classification.
 */
export function flowClassOf(el: Element, cs: CSSStyleDeclaration | null): FlowClass {
  const display = cs?.display ?? "";
  if (display === "") {
    return INLINE_FALLBACK_TAGS.has(tagOf(el)) ? "inline" : "block";
  }
  if (display === "none") return "hidden";
  if (display === "contents") return "contents";
  return isInlineDisplay(display) ? "inline" : "block";
}

/** True if text under this computed style keeps its newlines (pre / pre-wrap / …). */
export function preservesNewlines(cs: CSSStyleDeclaration | null): boolean {
  const ws = cs?.whiteSpace ?? "";
  return ws.startsWith("pre") || ws === "break-spaces";
}

/**
 * Screen-reader-only / decorative inline content: visually absent text that would
 * otherwise pollute the middle of a sentence ("(opens in a new tab)", icon labels,
 * legacy clip-rect sr-only spans). Checked only for inline-flow elements.
 */
export function isVisuallyHiddenInline(cs: CSSStyleDeclaration): boolean {
  if (parseFloat(cs.fontSize) === 0) return true;
  if (cs.opacity === "0") return true;
  if (cs.position === "absolute" || cs.position === "fixed") {
    const w = parseFloat(cs.width);
    const h = parseFloat(cs.height);
    if ((!Number.isNaN(w) && w <= 2) || (!Number.isNaN(h) && h <= 2)) return true;
    if (cs.clip !== "auto" && cs.clip !== "") return true;
    if (cs.clipPath === "inset(50%)" || cs.clipPath === "inset(100%)") return true;
  }
  return false;
}
