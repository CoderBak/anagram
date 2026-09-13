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
  /** popup/options → SW: which scoring backend is live (optionally force a fresh probe). */
  GET_BACKEND_STATUS: "getBackendStatus",
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
}

/** popup/options → SW: ask which backend is live. `probe` forces a fresh /health check. */
export interface GetBackendStatusMessage {
  action: typeof ACTIONS.GET_BACKEND_STATUS;
  probe?: boolean;
}

/** SW → popup/options (response to GET_BACKEND_STATUS). */
export interface BackendStatus {
  mode: "auto" | "server" | "stub";
  serverUrl: string;
  /** What will actually score the next batch. */
  active: "server" | "stub";
  model: ModelInfo;
  server: { ok: boolean; checkedAt: number; device?: string; error?: string };
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
  /** Units flagged AI / AI-Assisted (popup stat line). */
  flagged: number;
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

/** Union of all control messages the content script may receive. */
export type ControlMessage =
  | RescanMessage
  | SetEnabledMessage
  | GetTabStateMessage
  | TeardownMessage
  | ToggleOverlayMessage
  | AnalyzeSelectionMessage;

/** Union of all messages the service worker may receive. */
export type BackgroundMessage = ScoreBatchMessage | GetTabStateMessage | GetBackendStatusMessage;
