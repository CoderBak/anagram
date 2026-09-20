// lib/dom/tags.ts — tag sets for the v2 segmenter.
//
// v2 classifies inline-vs-block by COMPUTED DISPLAY (lib/dom/style.ts); tags are now
// only (a) hard exclusions that no style can override and (b) the fallback inline
// classification for contexts where computed style is unavailable.
import { countWords } from "./text";

/**
 * Hard "never look inside, never score" tags. Media, form controls, embedded
 * documents, machine text, and ruby annotations (RT/RP would interleave furigana
 * into the base text).
 */
export const NO_SCORE_TAGS = new Set<string>([
  "TITLE", "SCRIPT", "STYLE", "TEXTAREA", "SVG", "MATH",
  "NOSCRIPT", "HEAD", "INPUT", "SELECT", "OPTION", "OPTGROUP", "DATALIST",
  "BUTTON", "METER", "PROGRESS",
  "IMG", "PICTURE", "SOURCE", "TRACK", "VIDEO", "AUDIO", "CANVAS",
  "IFRAME", "FRAME", "OBJECT", "EMBED", "APPLET",
  "MAP", "AREA", "TEMPLATE", "LINK", "META", "BASE",
  "RT", "RP",
]);

/**
 * Fallback inline classification when computed style is unavailable (detached or
 * foreign contexts). Includes the phrase-content tags the M1 walker treated as
 * inline PLUS code/kbd/samp/etc — inline code must NOT split the sentence around it
 * (that fragmented MDN/HF-style prose into sub-minimum shards in M1).
 */
export const INLINE_FALLBACK_TAGS = new Set<string>([
  "A", "ABBR", "ACRONYM", "B", "BDO", "BDI", "BIG", "CITE", "CODE", "DATA",
  "DEL", "DFN", "EM", "FONT", "I", "INS", "KBD", "LABEL", "MARK", "NOBR",
  "OUTPUT", "Q", "RUBY", "S", "SAMP", "SMALL", "SPAN", "STRONG", "SUB", "SUP",
  "TIME", "TT", "U", "VAR", "WBR",
]);

/**
 * Normalized tag name. HTML elements report uppercase nodeName, but SVG/MathML
 * (and every element in XHTML documents) report lowercase — matching against the
 * uppercase sets with the raw nodeName silently skipped ALL those exclusions.
 */
export function tagOf(node: Node): string {
  return node.nodeName.toUpperCase();
}

/** Heading DECLARATION (topic boundaries — never scored, never merged across). Whether
 *  the element really is one is `isHeadingLabel`. */
export function isHeading(el: Element): boolean {
  return /^H[1-6]$/.test(tagOf(el)) || el.getAttribute("role") === "heading";
}

/**
 * Cheap guard before counting words: nothing this long is a label, in any script
 * (thirty words of English run to some 200 characters, thirty of Chinese to sixty).
 * Below it the word count decides, so this bound never rejects anything by itself.
 */
const HEADING_SAMPLE_CHARS = 400;
/** The most words a heading may carry and still be a label rather than a text block. */
const MAX_HEADING_WORDS = 30;
/** Elements that belong to running text and never inside a label. */
const PROSE_CONTENT_SELECTOR = "p,li,blockquote,pre,dd,table,article,section,figure";

/**
 * Is an element that DECLARES itself a heading really one — a short label — or a
 * container that merely says so? lobste.rs marks every comment body
 * `<div role="heading" aria-level="3" class="comment_text">`, paragraphs of up to 172
 * words and all: a thread of 2 913 prose words produced no unit at all, because
 * `visit()` makes a heading a barrier and returns WITHOUT descending into it. News and
 * feed sites wrap a whole teaser card — headline, standfirst, byline — in an `<h2>` or
 * `<h3>` for the same reason (网易, 新浪, the Guardian's live blog, dev.to, blog.google,
 * Booking.com). A heading is short and holds no paragraph of its own; anything else is
 * walked like the container it really is, and the real headings inside it are still
 * barriers.
 */
export function isHeadingLabel(el: Element): boolean {
  const text = (el.textContent ?? "").trim();
  if (text.length > HEADING_SAMPLE_CHARS) return false;
  if (countWords(text) > MAX_HEADING_WORDS) return false;
  return el.querySelector(PROSE_CONTENT_SELECTOR) === null;
}
