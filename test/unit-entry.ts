// test/unit-entry.ts — bundle entry for the in-browser unit tests.
// esbuild bundles this to an IIFE exposing `PW` on the page; test/unit.mjs
// injects it into a real Chromium page (the walker needs real computed styles,
// which jsdom cannot provide) and runs table-driven cases against it.
export { collectUnits, inPageOrder } from "../lib/dom/walker";
export { noteShadowHost } from "../lib/dom/shadow";
export { createScopes } from "../lib/dom/scope";
export {
  countWords,
  sentenceStarts,
  symbolNoiseRatio,
  hasColumnGaps,
  modelText,
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
export { isBoilerplate, isNoTranslate, findConsentBanners, isConsentBanner } from "../lib/dom/boilerplate";
export { isConsentFrame } from "../lib/dom/consentBanners";
export { clipsOwnText } from "../lib/dom/style";
export { WATCHED_ATTRS, createObservers } from "../lib/capture/observers";
export { findMainContent, useDefuddle } from "../lib/dom/mainContent";
export { detectDocsPage, readingViewUrl, editorUrl } from "../lib/docs";
export { band, isFlagged } from "../lib/render/band";
export { formatScore, spokenScore } from "../lib/render/score";
export { createBadgeLayer } from "../lib/render/badge";
export { locateSpans } from "../lib/dom/locate";
export {
  chunksOf,
  wordsOf,
  planPasses,
  fitsWithoutCounting,
  readEnd,
  halve,
  blockText,
  unitVerdict,
  WINDOW_CHARS,
  PASS_TOKENS,
  SNAP_TOKENS,
  MAX_CHUNK_CHARS,
  MAX_WINDOWS,
  MAX_READ_CHARS,
} from "../lib/capture/windows";
// The passes a text is read in with the fixtures' pretend tokenizer standing in for the
// engine's count (the engine's real counts are checked in test/node/windows.test.ts).
export { planText as planWindows, spanTokens } from "./node/fakeCounts";
export { fakeTokens } from "./fakeTokens.mjs";
export { windowReadout, coverageNote } from "../lib/render/coverage";
// The page diagnostics ship as an on-demand chunk that touches no extension API at all
// (lib/diagnostics/chunk.ts), which is exactly what lets the privacy check run them here,
// in an ordinary page, and read every character they produce.
export { buildDiagnostics } from "../lib/diagnostics/report";
export { captureRegion } from "../lib/diagnostics/anonymise";
export { setHighlight, clearHighlight, setActiveUnit, registerHighlightStyles } from "../lib/render/highlight";
export { scaleStep, spread, SCALE_STEPS } from "../lib/render/scale";
export { confidence, verdictConfidence } from "../lib/render/confidence";
export { repairSplits, restoreSplits } from "../lib/dom/splits";

// Structured PDF benchmarks exercise the real reflow and glyph-source mapping layers.
export { reflowPdf } from "../lib/pdf/reflow";
export { createPdfUnitSource } from "../lib/pdf/units";

// The surfaces chunk (lib/surfaces/chunk.ts) and the page's side of it: Google Drive's
// preview is read and drawn on in a blank page here, exactly as the content script does.
export { createSurface } from "../lib/surfaces/chunk";
export { surfaceFor, asPageSurface } from "../lib/surfaces";
export { setMarkPainter, setRangeLocator, setHighlightsVisible } from "../lib/render/highlight";
