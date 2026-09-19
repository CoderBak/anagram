// lib/surface.ts — which browser build this code is running in.
//
// The contract's `surface` tag tells the daemon where a request came from, so it must
// name the real build: the Firefox zip used to introduce itself as "chrome-ext". WXT
// replaces `import.meta.env.BROWSER` at build time with the target of `wxt build -b
// <browser>`, which makes the tag a constant in the bundle rather than a UA sniff.
//
// The lookup is guarded because not every bundle of this file is a WXT bundle: the unit
// suite bundles lib/ with plain esbuild as an IIFE, where `import.meta` has no meaning
// and collapses to an empty object — reading `.env.BROWSER` off it throws. Anything we
// cannot identify is the Chrome build, which is what shipped before this existed.
import type { ScoreBatchRequest } from "./contract";

function buildTarget(): string {
  try {
    return import.meta.env.BROWSER ?? "";
  } catch {
    return "";
  }
}

const target = buildTarget();

/** Origin tag every scoring request carries (contract §surface). */
export const SURFACE: ScoreBatchRequest["surface"] =
  target === "firefox" ? "firefox-ext" : target === "safari" ? "safari-ext" : "chrome-ext";

/**
 * Does a content script run inside the browser's own PDF viewer? Chrome wraps the plugin
 * in an ordinary HTML document that content scripts ARE injected into — that outer
 * document is where the ball's "Analyze PDF" chip comes from. Firefox shows PDFs in its
 * built-in pdf.js viewer, a privileged page no content script reaches, so nothing that
 * has to start from the PDF tab itself can exist there.
 */
export const PDF_TAB_SCRIPTS_RUN = target !== "firefox";
