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
 * Does the content script run in the frames that have no address of their own — an
 * about:blank or srcdoc frame, a blob: document — by the origin they take from the page
 * that made them (`matchOriginAsFallback`, Chrome 119+)? Firefox registers such scripts as
 * well, but its runtime.MessageSender carries no `origin`, so the worker could not tell
 * which site a message from one of them speaks for (lib/access/messages.ts), and would
 * refuse every one of them.
 */
export const ORIGIN_FALLBACK_FRAMES = target !== "firefox";
