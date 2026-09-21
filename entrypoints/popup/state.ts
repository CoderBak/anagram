// entrypoints/popup/state.ts — what the popup leads with on this tab.
//
// The popup opens on whatever page the reader is looking at, and most of those pages are
// ones Anagram is doing nothing on: it installs with access to no site at all. So the top
// of the popup is a status line and ONE button, and which button that is depends on the
// tab. The choice is a pure function so every combination is provable without a browser
// (test/node/popupState.test.ts) — the popup itself only paints what comes back.
import type { MessageKey } from "../../lib/i18n";

/** What the one button does. */
export type PopupAction =
  /** the page is running — read it again */
  | "rescan"
  /** the page is not running — read it ONCE, with `activeTab` and nothing written */
  | "analyze"
  /** a PDF tab — hand the document to the reading mode */
  | "readPdf"
  /** nothing here can be read — open the reading mode empty, for a file on this computer */
  | "openReader"
  /** the local engine is unavailable — open setup and Settings */
  | "retry";

/** Which line goes above the button. */
export type PopupStatus =
  /** what this page's scan found, as counts */
  | "counts"
  /** Anagram is off for this page */
  | "off"
  /** nothing can run on this page */
  | "unsupported"
  /** there is no active tab */
  | "noTab"
  /** the local engine is unavailable — show its state and the Settings action */
  | "daemon"
  /** the button says everything there is to say */
  | "none";

/** Everything the popup knows about the tab it opened over. */
export interface PageFacts {
  /** Is there an active tab at all? */
  hasTab: boolean;
  /** The origin pattern access could be asked for, or null on a page no extension may
   *  ever run on: a browser page, the web store, a `file:` URL (lib/access/patterns.ts). */
  pattern: string | null;
  /** The tab is showing a PDF — its URL says so, or the content script in Chrome's
   *  viewer wrapper reported it. Only ever set for a page `pattern` covers, because the
   *  reading mode is handed the bytes BY that tab and cannot read a local file this way. */
  pdfTab: boolean;
  /** Can a PDF tab be handed over in this browser? Firefox's viewer is a privileged page
   *  no content script reaches, so there is nobody there to hand anything (lib/surface.ts). */
  pdfReadable: boolean;
  /** What the content script answered, or null when nothing answered — which is the
   *  ordinary case on a site nothing has been granted for. */
  tab: { enabled: boolean } | null;
  /** The local daemon. Everything else is beside the point while this is not "up". */
  daemon: "up" | "down" | "mismatch";
}

export interface PopupLead {
  action: PopupAction;
  /** Is this THE thing to do here (a filled button), or merely something that is
   *  available (an outline one)? Exactly one filled button, ever. */
  primary: boolean;
  status: PopupStatus;
}

/** The button's label, per action. */
export const ACTION_LABEL: Record<PopupAction, MessageKey> = {
  rescan: "popupRescan",
  analyze: "popupAnalyzeOnce",
  readPdf: "popupReadPdf",
  openReader: "popupOpenReader",
  retry: "componentOpenSetup",
};

/**
 * The one action this tab deserves. In order:
 *
 * The daemon comes first — while it is silent every paragraph anywhere comes back
 * Unavailable, so starting a scan would only spend the reader's time proving it. A PDF tab
 * comes before the on/off state because the tab itself holds no text to score: the verdicts
 * appear in the reading mode, which is what the button opens. Then the ordinary pages: a
 * running one offers another look, and one Anagram is off for — switched off, or never
 * granted, which is every page on a fresh install — offers the single run that needs no
 * permission at all. What is left is a page nothing can run on, and the only thing left to
 * offer there is the reading mode with a PDF from this computer in it.
 */
export function popupLead(f: PageFacts): PopupLead {
  if (f.daemon !== "up") return { action: "retry", primary: true, status: "daemon" };
  if (!f.hasTab) return { action: "openReader", primary: false, status: "noTab" };
  if (f.pdfTab) {
    return f.pdfReadable
      ? { action: "readPdf", primary: true, status: "none" }
      : { action: "openReader", primary: false, status: "unsupported" };
  }
  if (f.tab?.enabled === true) return { action: "rescan", primary: false, status: "counts" };
  if (f.pattern !== null) return { action: "analyze", primary: true, status: "off" };
  return { action: "openReader", primary: false, status: "unsupported" };
}
