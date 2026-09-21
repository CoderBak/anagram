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
  | "fileAccess"
  /** the button says everything there is to say */
  | "none";

/** Everything the popup knows about the tab it opened over. */
export interface PageFacts {
  /** Is there an active tab at all? */
  hasTab: boolean;
  /** The origin pattern access could be asked for, or null on a page no extension may
   *  ever run on: a browser page, the web store, a `file:` URL (lib/access/patterns.ts). */
  pattern: string | null;
  /** The URL, observed response, or Chrome's outer wrapper identifies a PDF. */
  pdfTab: boolean;
  /** False for a local file without file URL authorization; the picker still works. */
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

/** Reading a PDF remains available while the model is stopped or not installed. */
export function popupLead(f: PageFacts): PopupLead {
  if (f.hasTab && f.pdfTab) {
    return f.pdfReadable
      ? { action: "readPdf", primary: true, status: "none" }
      : { action: "openReader", primary: false, status: "fileAccess" };
  }
  if (f.daemon !== "up") return { action: "retry", primary: true, status: "daemon" };
  if (!f.hasTab) return { action: "openReader", primary: false, status: "noTab" };
  if (f.tab?.enabled === true) return { action: "rescan", primary: false, status: "counts" };
  if (f.pattern !== null) return { action: "analyze", primary: true, status: "off" };
  return { action: "openReader", primary: false, status: "unsupported" };
}
