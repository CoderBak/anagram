// test/unit-entry.ts — bundle entry for the in-browser unit tests.
// esbuild bundles this to an IIFE exposing `PW` on the page; test/unit.mjs
// injects it into a real Chromium page (the walker needs real computed styles,
// which jsdom cannot provide) and runs table-driven cases against it.
export { collectUnits } from "../lib/dom/walker";
export {
  countWords,
  splitSentences,
  truncateForScoring,
  stripInvisibles,
  symbolNoiseRatio,
  hasColumnGaps,
  normalizeText,
  canonicalForScoring,
  scoringText,
  isSeparatorRun,
  looksLikeNameList,
  hasLetters,
  endsLikeProse,
  endsInColon,
  wordShape,
  MIN_UNIT_WORDS,
  MIN_MERGE_WORDS,
  MIN_SENTENCE_WORDS,
  MIN_LINE_WORDS,
} from "../lib/dom/text";
export { isBoilerplate } from "../lib/dom/boilerplate";
export { findMainContent, useReadability } from "../lib/dom/mainContent";
export { detectDocsPage, readingViewUrl, editorUrl } from "../lib/docs";
export { band, isFlagged, scorePct } from "../lib/render/band";
export { createBadgeLayer } from "../lib/render/badge";
