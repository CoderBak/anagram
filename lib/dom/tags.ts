// lib/dom/tags.ts

/** Stage 1 coarse block-container tags (querySelectorAll targets). UPPERCASE nodeName. */
export const BLOCK_TAGS = new Set<string>([
  "H1", "H2", "H3", "H4", "H5", "H6",
  "TABLE", "OL", "P", "LI", "PRE", // PRE included unless treatPreAsBlock is off (see note)
]);

/**
 * Stage 2 inline-text tags. A child whose nodeName IS in this set does NOT break the
 * current unit (text keeps accumulating). "#text" is included so text nodes count.
 * Verbatim from pageTranslator.js:225.
 */
export const INLINE_TEXT_TAGS = new Set<string>([
  "#text", "A", "ABBR", "ACRONYM", "B", "BDO", "BIG", "CITE", "DFN", "EM", "I",
  "LABEL", "Q", "S", "SMALL", "SPAN", "STRONG", "SUB", "SUP", "U", "TT", "VAR",
]);

/**
 * Inline tags that are IGNORED as non-descended boundaries: they close the current unit
 * and the walker does not recurse into them. Verbatim from pageTranslator.js:226 (+PRE).
 */
export const INLINE_IGNORE_TAGS = new Set<string>([
  "BR", "CODE", "KBD", "WBR", "PRE",
]);

/**
 * Hard "never look inside, never score" tags. Verbatim from pageTranslator.js:227,
 * extended with the detector-appropriate media/form tags from the design doc blocklist.
 */
export const NO_SCORE_TAGS = new Set<string>([
  "TITLE", "SCRIPT", "STYLE", "TEXTAREA", "SVG",
  "NOSCRIPT", "HEAD", "INPUT", "IMG", "VIDEO", "AUDIO", "CANVAS", "MATH",
]);

/** Element is a block boundary in Stage 2 iff its nodeName is NOT inline-text. */
export function isInlineDisplay(node: Node): boolean {
  return INLINE_TEXT_TAGS.has(node.nodeName);
}

/** Stage 1: is this a candidate block container? */
export function isBlock(el: Element): boolean {
  return BLOCK_TAGS.has(el.nodeName);
}
