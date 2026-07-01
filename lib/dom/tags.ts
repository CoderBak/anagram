// lib/dom/tags.ts — tag sets for the v2 segmenter.
//
// v2 classifies inline-vs-block by COMPUTED DISPLAY (lib/dom/style.ts); tags are now
// only (a) hard exclusions that no style can override and (b) the fallback inline
// classification for contexts where computed style is unavailable.

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
  "MAP", "AREA", "TEMPLATE", "STYLE", "LINK", "META", "BASE",
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

/** Heading detection (topic boundaries — never scored, never merged across). */
export function isHeading(el: Element): boolean {
  return /^H[1-6]$/.test(el.nodeName) || el.getAttribute("role") === "heading";
}
