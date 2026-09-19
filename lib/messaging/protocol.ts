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
