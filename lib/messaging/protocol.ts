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
  /** SW (context menu) → content: score the current selection, show a card. */
  ANALYZE_SELECTION: "analyzeSelection",
  /** popup/options/content → SW: is the daemon up (optionally force a fresh probe). */
  GET_BACKEND_STATUS: "getBackendStatus",
  /** popup → content: re-check the daemon now and re-queue "Unavailable" units. */
  RETRY_BACKEND: "retryBackend",
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

/** SW → content (specific frame): analyze the live selection. */
export interface AnalyzeSelectionMessage {
  action: typeof ACTIONS.ANALYZE_SELECTION;
}

/** popup → content: the user pressed Retry — re-check the daemon, re-queue Unavailable units. */
export interface RetryBackendMessage {
  action: typeof ACTIONS.RETRY_BACKEND;
}

/** Union of all control messages the content script may receive. */
export type ControlMessage =
  | RescanMessage
  | SetEnabledMessage
  | GetTabStateMessage
  | TeardownMessage
  | ToggleOverlayMessage
  | AnalyzeSelectionMessage
  | RetryBackendMessage;

/** Union of all messages the service worker may receive. */
export type BackgroundMessage = ScoreBatchMessage | UpdateBadgeMessage | GetBackendStatusMessage;
