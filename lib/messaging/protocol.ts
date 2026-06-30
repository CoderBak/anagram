// lib/messaging/protocol.ts — action constants + typed envelope shapes.
import type { ScoreBatchRequest, ScoreResult } from "../contract";

export const ACTIONS = {
  SCORE_BATCH: "scoreBatch",
  RESCAN: "rescan",
  SET_ENABLED: "setEnabled",
  GET_TAB_STATE: "getTabState",
  TEARDOWN: "teardown",
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
}

/** popup/SW → content: tear down all badges and observers. */
export interface TeardownMessage {
  action: typeof ACTIONS.TEARDOWN;
}

/** Union of all control messages the content script may receive. */
export type ControlMessage =
  | RescanMessage
  | SetEnabledMessage
  | GetTabStateMessage
  | TeardownMessage;

/** Union of all messages the service worker may receive. */
export type BackgroundMessage = ScoreBatchMessage | GetTabStateMessage;
