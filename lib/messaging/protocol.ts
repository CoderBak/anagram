// lib/messaging/protocol.ts — action constants + typed envelope shapes.
import type { ModelInfo, ScoreBatchRequest, ScoreResult } from "../contract";

export const ACTIONS = {
  SCORE_BATCH: "scoreBatch",
  /** content/reader/paste → SW: how many model tokens each piece of a long text is, so its
   *  passes are planned as full as the model allows (lib/capture/windows.ts). */
  COUNT_TOKENS: "countTokens",
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
  /** content (subframe) → SW: the hostname of the TAB's top-level page. A cross-origin
   *  frame cannot read it, and `document.referrer` is empty under a no-referrer policy —
   *  but the worker sees the tab's URL on the sender. */
  GET_TOP_HOST: "getTopHost",
  /** SW (context menu) → content: score the current selection, show a card. */
  ANALYZE_SELECTION: "analyzeSelection",
  /** SW (context menu) → content: analyze this page once, whatever the settings say. */
  ANALYZE_PAGE: "analyzePage",
  /** popup → SW: the same thing, asked from the popup's button. It goes through the worker
   *  because the page may hold no content script yet: opening the popup gave the extension
   *  `activeTab`, and only the worker can inject with it (lib/access/worker.ts). */
  ANALYZE_TAB: "analyzeTab",
  /** SW (context menu) → content (top frame): describe this page for the developer and
   *  put the description on the clipboard. Answered on a page Anagram is off for too. */
  COPY_DIAGNOSTICS: "copyDiagnostics",
  /** popup/options/content → SW: is the local engine ready (optionally force a fresh probe). */
  GET_BACKEND_STATUS: "getBackendStatus",
  /** popup → content: re-check the local engine now and re-queue "Unavailable" units. */
  RETRY_BACKEND: "retryBackend",
  /**
   * content (a PDF tab) / popup → SW: open the PDF reading mode. A content script may
   * not navigate its tab to an extension page — the reader is deliberately not web
   * accessible — so the worker performs the tabs.update for it. A content script names
   * neither the address nor the tab (the worker reads both off the sender); the popup,
   * whose sender is no tab, names them.
   */
  OPEN_PDF_READER: "openPdfReader",
  GET_PDF_STATUS: "GET_PDF_STATUS",
  /**
   * content (a PDF tab, top frame) → SW: this tab is showing a PDF, reached this way.
   * The worker decides whether "Open PDFs in Anagram" applies (lib/pdf/route.ts) — the
   * setting, the back/forward rule and the one-shot pass below all live there, so there
   * is one answer and not three. The tab and the frame come off the sender, so a page
   * cannot ask for somebody else's tab to be moved.
   */
  PDF_TAB_OPENED: "pdfTabOpened",
  /**
   * reader → SW: let THIS tab load THIS PDF once without the reading mode opening over
   * it. "Open original" and the way out of the reader's failure lines would otherwise
   * bounce straight back here while the setting is on.
   */
  PDF_PASS_ONCE: "pdfPassOnce",
  /** SW → content: are you there? The worker's probe before it injects the content
   *  script into a tab it has only `activeTab` for (lib/access/worker.ts). */
  PING: "ping",
  /** SW → content: this site has just been granted, so a script that was put here for one
   *  action stops being a one-off and follows the settings like any other page. */
  ACCESS_GRANTED: "accessGranted",
  /** options → SW: forget every cached verdict (memory, worker and IndexedDB). */
  CLEAR_CACHE: "clearCache",
  /** options → SW: change verdict persistence and report deletion failures. */
  SET_CACHE_MODE: "setCacheMode",
  /** options → SW: how many verdicts are on the disk right now. */
  GET_CACHE_COUNT: "getCacheCount",
  /** SW → content: the worker's caches are gone — drop this tab's own layer too. */
  CACHE_CLEARED: "cacheCleared",
} as const;

/** content → SW: score a batch of blocks. */
export interface ScoreBatchMessage {
  action: typeof ACTIONS.SCORE_BATCH;
  req: ScoreBatchRequest;
}

/** content → SW: count model tokens (answered with CountTokensReply). */
export interface CountTokensMessage {
  action: typeof ACTIONS.COUNT_TOKENS;
  texts: string[];
}

/** SW → content: one count per text, in order, or null when the engine cannot count. */
export interface CountTokensReply {
  counts: number[] | null;
}

/** SW → content (response to SCORE_BATCH). */
export interface ScoreBatchReply {
  results: ScoreResult[];
  /** Backend that produced this batch (report footer, popup). */
  model?: ModelInfo;
  /** Whether the local engine answered its last probe — "down" makes the content script pause. */
  backend: "up" | "down";
}

/** SW → popup/options/content (response to GET_BACKEND_STATUS). */
export interface BackendStatus {
  /** Idle is reachable and wakes for scoring; health checks alone never load it. */
  active: "server" | "idle" | "down";
  /** The local engine's model when up; null when down. */
  model: ModelInfo | null;
  server: {
    code?: string;
    ok: boolean;
    checkedAt: number;
    device?: string;
    dtype?: string;
    error?: string;
    /** Health unavailable or incompatible; native error details are in code/error. */
    reason?: "unreachable" | "contract";
    contract?: string;
    /** A compatible component reports an older release than this extension. */
    outdated?: boolean;
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

/** popup → content: the user pressed Retry — re-check the local engine, re-queue Unavailable units. */
export interface RetryBackendMessage {
  action: typeof ACTIONS.RETRY_BACKEND;
}

/** SW → reader (response to PDF_PASS_ONCE): the pass is held, it is safe to navigate. */
export interface PdfPassOnceReply {
  ok: boolean;
}

/** SW → content: is a content script already listening in this tab? */
export interface PingMessage {
  action: typeof ACTIONS.PING;
}

/** content → SW (response to PING). Anything other than an answer means "not there". */
export interface PingReply {
  ok: true;
}

/**
 * SW → content: the user has granted this site. A page the worker had injected for one
 * action only — a diagnostics report, a selection — was behaving as it does on a switched
 * off site; from here it follows the settings, and starts if they say so. Pages that were
 * injected fresh by the grant never see this: they boot that way already.
 */
export interface AccessGrantedMessage {
  action: typeof ACTIONS.ACCESS_GRANTED;
}

/** SW → options (response to CLEAR_CACHE): the caches are empty. */
export interface ClearCacheReply {
  ok: boolean;
  error?: string;
}

/** SW → options (response to GET_CACHE_COUNT): verdicts on the disk, the number the
 *  options page shows beside "Clear". Memory-only verdicts are not among them. */
export interface CacheCountReply {
  entries: number | null;
  error?: string;
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
  | CacheClearedMessage
  | PingMessage
  | AccessGrantedMessage;
