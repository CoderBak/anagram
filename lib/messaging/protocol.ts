// lib/messaging/protocol.ts — action constants + typed envelope shapes.
import type { ModelInfo, ScoreBatchRequest, ScoreResult } from "../contract";

export const ACTIONS = {
  SCORE_BATCH: "scoreBatch",
  RESCAN: "rescan",
  SET_ENABLED: "setEnabled",
  GET_TAB_STATE: "getTabState",
  TEARDOWN: "teardown",
  /** content (top frame) → SW: reflect the flagged count on the toolbar icon. */
  UPDATE_BADGE: "updateBadge",
  /** SW (keyboard command) → content: show/hide the overlay. */
  TOGGLE_OVERLAY: "toggleOverlay",
  /** SW (keyboard command) → content (top frame): open the triage panel, focus it. */
  OPEN_PANEL: "openPanel",
  /** SW (keyboard command) → content (top frame): go to the next flagged paragraph. */
  NEXT_FLAGGED: "nextFlagged",
  /** SW (keyboard command) → content (top frame): go to the previous flagged paragraph. */
  PREV_FLAGGED: "prevFlagged",
  /** content (subframe) → SW: the hostname of the TAB's top-level page. */
  GET_TOP_HOST: "getTopHost",
  /** SW (context menu) → content: score the current selection, show a card. */
  ANALYZE_SELECTION: "analyzeSelection",
  /** SW (context menu) → content: analyze this page once, whatever the settings say. */
  ANALYZE_PAGE: "analyzePage",
  /** SW (context menu) → content (top frame): describe this page for the developer and
   *  put the description on the clipboard. Answered on a page Anagram is off for too. */
  COPY_DIAGNOSTICS: "copyDiagnostics",
  /** popup/options/content → SW: is the daemon up (optionally force a fresh probe). */
  GET_BACKEND_STATUS: "getBackendStatus",
  /** popup → content: re-check the daemon now and re-queue "Unavailable" units. */
  RETRY_BACKEND: "retryBackend",
  /**
   * content (a PDF tab) / popup → SW: open the PDF reading mode. A content script may
   * not navigate its tab to an extension page — the reader is deliberately not web
   * accessible — so the worker performs the tabs.update for it.
   */
  OPEN_PDF_READER: "openPdfReader",
  /**
   * content (a PDF tab, top frame) → SW: this tab is showing a PDF, reached this way.
   * The worker decides whether "Open PDFs in Anagram" applies (lib/pdf/route.ts) — the
   * setting, the back/forward rule and the one-shot pass below all live there, so there
   * is one answer and not three.
   */
  PDF_TAB_OPENED: "pdfTabOpened",
  /**
   * reader → SW: let THIS tab load THIS PDF once without the reading mode opening over
   * it. "Open original" and the way out of the reader's failure lines would otherwise
   * bounce straight back here while the setting is on.
   */
  PDF_PASS_ONCE: "pdfPassOnce",
  /** options → SW: forget every cached verdict (memory, worker and IndexedDB). */
  CLEAR_CACHE: "clearCache",
  /** SW → content: the worker's caches are gone — drop this tab's own layer too. */
  CACHE_CLEARED: "cacheCleared",
} as const;

export type ActionName = (typeof ACTIONS)[keyof typeof ACTIONS];

/** content → SW: score a batch of blocks. */
export interface ScoreBatchMessage {
  action: typeof ACTIONS.SCORE_BATCH;
  req: ScoreBatchRequest;
}

/** SW → content (response to SCORE_BATCH). */
export interface ScoreBatchReply {
  results: ScoreResult[];
  /** Backend that produced this batch (report footer, popup). */
  model?: ModelInfo;
  /** Whether the daemon answered its last probe — "down" makes the content script pause. */
  backend: "up" | "down";
}

/** popup/options → SW: ask which backend is live. `probe` forces a fresh /health check. */
export interface GetBackendStatusMessage {
  action: typeof ACTIONS.GET_BACKEND_STATUS;
  probe?: boolean;
}

/** SW → popup/options/content (response to GET_BACKEND_STATUS). */
export interface BackendStatus {
  serverUrl: string;
  /** "server" when the daemon answered its last probe; "down" otherwise. */
  active: "server" | "down";
  /** The daemon's model when up; null when down. */
  model: ModelInfo | null;
  server: {
    ok: boolean;
    checkedAt: number;
    device?: string;
    error?: string;
    /**
     * Why the daemon is not usable, when it is not: nothing answered ("unreachable"),
     * something answered but speaks another contract major ("contract"), or the
     * configured URL is not a loopback address ("loopback"). Absent when it is up.
     * The pages advise "start it" or "update it" from this, never from `error`.
     */
    reason?: "unreachable" | "contract" | "loopback";
    /** The contract string a mismatched daemon reported, when `reason` is "contract". */
    contract?: string;
  };
}

/** popup/SW → content: force a re-scan of the active tab. */
export interface RescanMessage {
  action: typeof ACTIONS.RESCAN;
}

/** popup → content: turn scoring on/off for this tab. */
export interface SetEnabledMessage {
  action: typeof ACTIONS.SET_ENABLED;
  value: boolean;
}

/** popup → content: ask the content script for its current state. */
export interface GetTabStateMessage {
  action: typeof ACTIONS.GET_TAB_STATE;
}

/** content → popup (response to GET_TAB_STATE). */
export interface TabState {
  enabled: boolean;
  hostname: string;
  /** The tab is a PDF the browser's own viewer is showing — the popup offers the reader. */
  pdf?: boolean;
  scored: number;
  /** Units flagged heavily edited / AI-generated (popup stat line). */
  flagged: number;
  /** Units skipped because their language is outside the model's (popup stat line). */
  unsupported: number;
  /** Units left with a degraded "Unavailable" verdict — analyzed is what remains. */
  unavailable: number;
}

/** popup/SW → content: tear down all badges and observers. */
export interface TeardownMessage {
  action: typeof ACTIONS.TEARDOWN;
}

/** content (top frame) → SW: per-tab flagged count for the toolbar badge. */
export interface UpdateBadgeMessage {
  action: typeof ACTIONS.UPDATE_BADGE;
  flagged: number;
}

/** SW → content: toggle overlay visibility (keyboard command). */
export interface ToggleOverlayMessage {
  action: typeof ACTIONS.TOGGLE_OVERLAY;
}

/** SW → content: open the flagged-paragraphs panel and focus it (keyboard command). */
export interface OpenPanelMessage {
  action: typeof ACTIONS.OPEN_PANEL;
}

/** SW → content: walk to the next/previous flagged paragraph (keyboard commands). */
export interface NextFlaggedMessage {
  action: typeof ACTIONS.NEXT_FLAGGED;
}

export interface PrevFlaggedMessage {
  action: typeof ACTIONS.PREV_FLAGGED;
}

/**
 * content (subframe) → SW: which hostname does this tab's top-level page have? A
 * cross-origin frame cannot read it, and `document.referrer` is empty under a
 * no-referrer policy — but the worker sees the tab's URL on the sender.
 */
export interface GetTopHostMessage {
  action: typeof ACTIONS.GET_TOP_HOST;
}

/** SW → content (response to GET_TOP_HOST). `host` is "" when the worker cannot tell. */
export interface TopHostReply {
  host: string;
}

/** SW → content (specific frame): analyze the live selection. */
export interface AnalyzeSelectionMessage {
  action: typeof ACTIONS.ANALYZE_SELECTION;
}

/**
 * SW → content (every frame of a tab): analyze this page once. A page Anagram is off for
 * starts scoring for as long as it stays open — no setting and no site rule is written —
 * and a page it is already on simply re-scans.
 */
export interface AnalyzePageMessage {
  action: typeof ACTIONS.ANALYZE_PAGE;
}

/**
 * SW → content (the TOP frame of a tab): build the anonymised page diagnostics and copy
 * them. `frameId` is the frame the reader opened the menu in — Chrome tells an extension
 * that much and nothing finer — so a report made in the top frame can say when the click
 * was somewhere else.
 */
export interface CopyDiagnosticsMessage {
  action: typeof ACTIONS.COPY_DIAGNOSTICS;
  frameId?: number;
}

/** content → SW (response to COPY_DIAGNOSTICS): what reached the clipboard, and by which
 *  of the two routes. The worker flashes the toolbar badge only on `ok`. */
export interface CopyDiagnosticsReply {
  ok: boolean;
  bytes: number;
  via: "clipboard" | "execCommand" | "none";
}

/** popup → content: the user pressed Retry — re-check the daemon, re-queue Unavailable units. */
export interface RetryBackendMessage {
  action: typeof ACTIONS.RETRY_BACKEND;
}

/**
 * content/popup → SW: show the PDF reading mode for `url` in tab `tabId`. A content
 * script sends neither — the worker reads both off the sender — while the popup, whose
 * sender is no tab, names them.
 */
export interface OpenPdfReaderMessage {
  action: typeof ACTIONS.OPEN_PDF_READER;
  url?: string;
  tabId?: number;
}

/**
 * content (a PDF tab) → SW: everything the automatic route is decided from except the
 * setting and the pass, which only the worker holds. The tab and the frame come off the
 * sender, so a page cannot ask for somebody else's tab to be moved.
 */
export interface PdfTabOpenedMessage {
  action: typeof ACTIONS.PDF_TAB_OPENED;
  url: string;
  contentType: string;
  protocol: string;
  navigationType: string;
}

/** reader → SW: let this tab's next load of `url` through without the reading mode. */
export interface PdfPassOnceMessage {
  action: typeof ACTIONS.PDF_PASS_ONCE;
  url: string;
}

/** SW → reader (response to PDF_PASS_ONCE): the pass is held, it is safe to navigate. */
export interface PdfPassOnceReply {
  ok: boolean;
}

/** options → SW: empty every score cache the worker owns, then tell the tabs. */
export interface ClearCacheMessage {
  action: typeof ACTIONS.CLEAR_CACHE;
}

/** SW → options (response to CLEAR_CACHE): the caches are empty. */
export interface ClearCacheReply {
  ok: boolean;
}

/**
 * SW → content: the worker's caches were cleared, so this tab's per-tab layer must go as
 * well or it would answer the next scan from a verdict nobody can check any more. Nothing
 * is rescanned or repainted: what is on the page stays until the next scan asks again.
 */
export interface CacheClearedMessage {
  action: typeof ACTIONS.CACHE_CLEARED;
}

/** Union of all control messages the content script may receive. */
export type ControlMessage =
  | RescanMessage
  | SetEnabledMessage
  | GetTabStateMessage
  | TeardownMessage
  | ToggleOverlayMessage
  | OpenPanelMessage
  | NextFlaggedMessage
  | PrevFlaggedMessage
  | AnalyzeSelectionMessage
  | AnalyzePageMessage
  | CopyDiagnosticsMessage
  | RetryBackendMessage
  | CacheClearedMessage;

/** Union of all messages the service worker may receive. */
export type BackgroundMessage =
  | ScoreBatchMessage
  | UpdateBadgeMessage
  | GetBackendStatusMessage
  | GetTopHostMessage
  | OpenPdfReaderMessage
  | ClearCacheMessage;
