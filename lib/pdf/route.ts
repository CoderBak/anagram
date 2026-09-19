// lib/pdf/route.ts — where a PDF opens, decided in one place.
//
// One question, answered here so that the ball's "Analyze PDF" chip, the popup's "Read
// this PDF" button, the context menu's "Open PDF with Anagram" and the automatic route
// can never disagree: may a PDF tab turn itself into the reading mode by itself?
//
// It is written as a plain function over its inputs, so the rules can be pinned in
// test/node/pdf-route.test.ts without a browser.
//
// WHAT LEAVES THE MACHINE: nothing. "Open in Anagram" on a PDF opens THAT PDF, always —
// the file the reader was looking at, never a substitute fetched from somewhere else.
// Until 2026-09-20 this file also asked arxiv.org whether a paper had an HTML rendering
// and sent the reader there instead; that was the extension's one remote request and it
// is gone. lib/pdf/source.ts still knows the address of an arXiv paper's HTML
// (`htmlTwinOf`), which the reader offers as a link the reader may follow themselves —
// a plain navigation, made by a person, not a probe made behind their back.

/** What the worker knows about a tab that has just shown it a PDF. */
export interface AutoOpenFacts {
  /** "Open PDFs in Anagram". Read fresh for every PDF, so turning it off needs no restart. */
  setting: boolean;
  /** What the document says it is — the tab's own `document.contentType`. */
  contentType: string;
  /** The PDF's `location.protocol`. */
  protocol: string;
  /** `performance.getEntriesByType("navigation")[0].type` for that document. */
  navigationType: string;
  /** Which frame reported it. Only the tab's own document may take the tab somewhere. */
  frame: number;
  /** This one load was let through — "Open original" in the reader is on its way here. */
  pass: boolean;
}

/**
 * Protocols the reading mode can fetch the document back from. A `blob:`, `data:` or
 * POST-result PDF exists only in the tab that is showing it — the reader would be handed
 * an address it cannot re-fetch and would land on "This PDF could not be loaded", which is
 * a worse tab than the PDF was.
 *
 * `file:` is in the list because the one permission decides both halves of it: Chrome's
 * "Allow access to file URLs" is what lets a content script run on a local PDF at all AND
 * what lets the reader page fetch it. Without the tick nothing here is ever asked, because
 * no content script runs; with it, both work (verified in test/pdf-route-check.mjs).
 *
 * What the protocol cannot catch is a PDF that came back from a POST: nothing inside the
 * document says which method fetched it, so the reader would re-ask with a GET and land on
 * "This PDF could not be loaded". The Back button still holds the PDF itself, which is the
 * same way out as every other unreadable file here.
 */
const REFETCHABLE = new Set(["http:", "https:", "file:"]);

/**
 * May this PDF tab become the reading mode by itself?
 *
 * The rules that are not obvious, and the case each one is for:
 *
 *   back/forward — the reading mode REPLACES the tab, so the PDF is still in history and
 *                  Back lands on it again. Bouncing forward from there would take the
 *                  Back button away from the reader altogether.
 *   pass         — "Open original" in the reader, and the same way out of every line that
 *                  says the file could not be read, would otherwise come straight back.
 *   frame        — a PDF in an <iframe> is part of somebody's page, not the tab.
 *   protocol     — see REFETCHABLE above.
 *
 * Downloads need no rule: a PDF served with `Content-Disposition: attachment` never
 * becomes a document, no content script runs for it, and nothing here is ever asked.
 */
export function shouldAutoOpen(facts: AutoOpenFacts): boolean {
  if (!facts.setting) return false;
  if (facts.frame !== 0) return false;
  if (facts.contentType !== "application/pdf") return false;
  if (!REFETCHABLE.has(facts.protocol)) return false;
  if (facts.navigationType === "back_forward") return false;
  if (facts.pass) return false;
  return true;
}
