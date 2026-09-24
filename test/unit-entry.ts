// test/unit-entry.ts — bundle entry for the in-browser unit tests.
// esbuild bundles this to an IIFE exposing `PW` on the page; test/unit.mjs
// injects it into a real Chromium page (the walker needs real computed styles,
// which jsdom cannot provide) and runs table-driven cases against it.
export { collectUnits } from "../lib/dom/walker";
export { createScopes } from "../lib/dom/scope";
export {
  countWords,
  splitSentences,
  sentenceStarts,
  stripInvisibles,
  symbolNoiseRatio,
  hasColumnGaps,
  normalizeText,
  canonicalForScoring,
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
// The grouping rules themselves, source-free: test/unit.mjs checks that the walker and
// they agree on the same sequence of paragraphs (lib/plan/group.ts, lib/pdf/units.ts).
export { groupBlocks, modelSized, groupChars, groupWords, clearsFloor, fitsWindow } from "../lib/plan/group";
export { isBoilerplate, isNoTranslate } from "../lib/dom/boilerplate";
export { clipsOwnText } from "../lib/dom/style";
export { WATCHED_ATTRS } from "../lib/capture/observers";
export { findMainContent, useReadability } from "../lib/dom/mainContent";
export { detectDocsPage, readingViewUrl, editorUrl } from "../lib/docs";
export { band, isFlagged } from "../lib/render/band";
export { formatScore, spokenScore } from "../lib/render/score";
export { createBadgeLayer } from "../lib/render/badge";
export { locateSpans } from "../lib/dom/locate";
export {
  planWindows,
  halve,
  blockText,
  unitVerdict,
  WINDOW_CHARS,
  MIN_WINDOW_CHARS,
  MAX_WINDOWS,
  MAX_READ_CHARS,
} from "../lib/capture/windows";
export { windowReadout, coverageNote } from "../lib/render/coverage";
// The page diagnostics ship as an on-demand chunk that touches no extension API at all
// (lib/diagnostics/chunk.ts), which is exactly what lets the privacy check run them here,
// in an ordinary page, and read every character they produce.
export { buildDiagnostics } from "../lib/diagnostics/report";
export { captureRegion } from "../lib/diagnostics/anonymise";
export { setHighlight, clearHighlight, setActiveUnit, registerHighlightStyles } from "../lib/render/highlight";
export { scaleStep, isUncertain, SCALE_STEPS } from "../lib/render/scale";
export { repairSplits, restoreSplits } from "../lib/dom/splits";

// Structured PDF benchmarks exercise the real reflow and glyph-source mapping layers.
export { reflowPdf } from "../lib/pdf/reflow";
export { createPdfUnitSource } from "../lib/pdf/units";
