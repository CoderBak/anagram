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

/** True if this computed display participates in inline flow (does not break a paragraph).
 *  Chromium reports inline `<math>` as `display: math` (and display math as `block math`). */
export function isInlineDisplay(display: string): boolean {
  return display.startsWith("inline") || display === "ruby" || display === "math";
}

/** Out of the normal flow (absolute/fixed): never breaks the surrounding sentence. */
export function isOutOfFlow(cs: CSSStyleDeclaration): boolean {
  return cs.position === "absolute" || cs.position === "fixed";
}

/**
 * Layout classification for one element during a walk. "inline" accumulates into the
 * current run; "block" closes it; "contents" is transparent and "hidden" is pruned.
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
 * Boxes whose overflow is about the PAGE, not about a paragraph: `body { overflow:
 * hidden }` under an open modal, `html` under a scroll lock, the main region of an app
 * with its own scrolling panes. Blanking those would blank the site. A `<details>` is
 * here too: closed, it hides its content by other means (content-visibility), and open,
 * it is read like any other block.
 */
const NEVER_CLIPPED_TAGS = new Set(["HTML", "BODY", "MAIN", "DETAILS"]);

/** Content must be at least this much taller than its box before the box counts as
 *  clipped: more of the text is out of sight than in it. */
const CLIP_CONTENT_RATIO = 2;
/** …and at least this many pixels of it must be hidden, so a few pixels of decorative
 *  overflow (a shadow, a descender, a sticky row) never blanks a paragraph. */
const CLIP_MIN_HIDDEN_PX = 32;
/** A box as tall as the screen is the page's own scrolling box or a full-height panel,
 *  not a three-line preview of a post. */
const CLIP_MAX_VIEWPORT_SHARE = 0.9;

/**
 * Does this box CLIP ITS OWN TEXT vertically — text that is in the DOM but that the
 * reader does not see until they expand it? LinkedIn's feed keeps the whole post and
 * shows three lines (`span[data-testid=expandable-text-box]`, `-webkit-line-clamp:3;
 * overflow:hidden`; the old UI's `div.feed-shared-inline-show-more-text` measures 60 px
 * around 497 px of text), Substack's Notes feed clamps `div.pencraft` to 168 px of
 * 1 708 px. Scoring that text judged a post by words nobody read, and put the chip
 * inside the clipped box where nobody sees it.
 *
 * The rule is a measurement, not a declaration: `overflow-y` must be `hidden` or `clip`
 * (`auto`/`scroll` are readable, and a carousel's `overflow-x:hidden` computes `overflow-y`
 * to `auto`), and the content must be at least twice the height of the box. Guards keep
 * it off everything that legitimately overflows: page-level boxes and `<details>`, boxes
 * as tall as the viewport, and a few pixels of decorative overflow. After the reader
 * expands the box the class/style/attribute change marks it dirty and it is scored then.
 *
 * COST: `clientHeight`/`scrollHeight` force layout, so they are read only once the cheap
 * computed-style test says the box clips at all. The walk mutates nothing, so the first
 * read computes layout once and every later one is free.
 */
export function clipsOwnText(el: Element, cs: CSSStyleDeclaration): boolean {
  const overflowY = cs.overflowY;
  if (overflowY !== "hidden" && overflowY !== "clip") return false;
  if (NEVER_CLIPPED_TAGS.has(tagOf(el)) || el.getAttribute("role") === "main") return false;
  const box = el.clientHeight;
  const content = el.scrollHeight;
  if (content - box < CLIP_MIN_HIDDEN_PX) return false;
  if (content < box * CLIP_CONTENT_RATIO) return false;
  const viewport = typeof window !== "undefined" ? window.innerHeight : 0;
  if (viewport > 0 && box >= viewport * CLIP_MAX_VIEWPORT_SHARE) return false;
  return true;
}

/**
 * Does this box CAP its own text — hide what grows past a height it declares, or hide text
 * already? Asked where a control that says "…see more" follows a text: behind a clamp the whole
 * text is in the page (LinkedIn's feed clamps to three lines, a margin short of what
 * `clipsOwnText` asks for), and without one the site has cut the text itself. Only a declared
 * cap counts besides hidden text, as in the chip layer's own test (lib/render/badge.ts).
 */
export function capsOwnText(el: Element, cs: CSSStyleDeclaration): boolean {
  const overflowY = cs.overflowY;
  if (overflowY !== "hidden" && overflowY !== "clip") return false;
  if (NEVER_CLIPPED_TAGS.has(tagOf(el)) || el.getAttribute("role") === "main") return false;
  const clamp = cs.getPropertyValue("-webkit-line-clamp");
  if (cs.maxHeight !== "none" || (clamp !== "" && clamp !== "none")) return true;
  return el.scrollHeight - el.clientHeight > CAP_MIN_HIDDEN_PX;
}
/** More hidden than this is a line of text, not a descender or a border. */
const CAP_MIN_HIDDEN_PX = 4;

/** How far above a line of text the box that cuts it off may sit: Discord sets the preview
 *  box one element above the text it cuts. */
const ONE_LINE_BOX_LEVELS = 3;

/**
 * Is text in `container` laid out on ONE line that a box cuts off with an ellipsis — the
 * one-line preview of a text shown in full somewhere else? Discord opens a reply with the
 * message it answers, name and text, in `div.repliedTextPreview` (`white-space: nowrap;
 * overflow: hidden; text-overflow: ellipsis`); the whole of that other message is in the
 * page, its first few words on screen, and it was read — a second verdict on a message that
 * has one of its own, most of it words nobody sees. An inbox's snippet lines are the same
 * shape. Nobody writes a paragraph to be read on one unwrapped line: this is a measurement
 * of how the text is laid out, not a name, and it asks the style cache only for text that
 * does not wrap.
 */
export function cutToOneLine(container: Element, styles: StyleCache): boolean {
  const own = styles.get(container);
  const ws = own?.whiteSpace ?? "";
  if (ws !== "nowrap" && ws !== "pre") return false;
  let at: Element | null = container;
  for (let up = 0; at && up <= ONE_LINE_BOX_LEVELS; up++, at = at.parentElement) {
    const cs = up === 0 ? own : styles.get(at);
    if (!cs) continue;
    if (cs.textOverflow === "ellipsis" && (cs.overflowX === "hidden" || cs.overflowX === "clip")) return true;
  }
  return false;
}

/**
 * Visually absent content, whatever its display: screen-reader-only copies ("(opens
 * in a new tab)", icon labels, legacy clip-rect sr-only spans) and the hidden
 * accessibility copies math renderers keep next to the visible glyphs (Wikipedia's
 * `display:block; position:absolute; clip:…` MathML, MathJax's assistive MathML).
 * Such elements are skipped silently — they must never close a run.
 */
export function isVisuallyHidden(cs: CSSStyleDeclaration): boolean {
  if (parseFloat(cs.fontSize) === 0) return true;
  if (cs.opacity === "0") return true;
  if (isOutOfFlow(cs)) {
    const w = parseFloat(cs.width);
    const h = parseFloat(cs.height);
    if ((!Number.isNaN(w) && w <= 2) || (!Number.isNaN(h) && h <= 2)) return true;
    if (cs.clip !== "auto" && cs.clip !== "") return true;
    if (cs.clipPath === "inset(50%)" || cs.clipPath === "inset(100%)") return true;
  }
  return false;
}
