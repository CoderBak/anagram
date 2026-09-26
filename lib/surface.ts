// lib/surface.ts — which browser build this code is running in.
//
// WXT replaces `import.meta.env.BROWSER` at build time with the target of `wxt build -b
// <browser>`, which makes this a constant in the bundle rather than a UA sniff.
//
// The lookup is guarded because not every bundle of this file is a WXT bundle: the unit
// suite bundles lib/ with plain esbuild as an IIFE, where `import.meta` has no meaning
// and collapses to an empty object — reading `.env.BROWSER` off it throws. Anything we
// cannot identify is the Chrome build, which is what shipped before this existed.

function buildTarget(): string {
  try {
    return import.meta.env.BROWSER ?? "";
  } catch {
    return "";
  }
}

const target = buildTarget();

/**
 * Does a content script run inside the browser's own PDF viewer? Chrome wraps the plugin
 * in an ordinary HTML document that content scripts ARE injected into — that outer
 * document is where the ball's "Analyze PDF" chip comes from. Firefox shows PDFs in its
 * built-in pdf.js viewer, a privileged page no content script reaches, so nothing that
 * has to start from the PDF tab itself can exist there.
 */
export const PDF_TAB_SCRIPTS_RUN = target !== "firefox";

/**
 * Does the browser's own page translation relabel the page's language — set `<html lang>` to
 * the language it translates into? Firefox's full-page translation does, when it starts
 * (translations-document.sys.mjs); Chrome's and Edge's mark the page in other ways
 * (lib/dom/translation.ts). Elsewhere a page that changes its own `lang` is a site switching
 * its language, and it keeps being read.
 */
export const TRANSLATION_RELABELS_PAGE = target === "firefox";
