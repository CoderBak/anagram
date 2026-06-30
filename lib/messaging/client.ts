// lib/messaging/client.ts — content→SW client.
import { browser } from "#imports";
import type { ScoreBatchRequest, ScoreResult } from "../contract";
import { ACTIONS } from "./protocol";
import type { ScoreBatchMessage, ScoreBatchReply } from "./protocol";

/**
 * Promise-wrapped runtime.sendMessage: one batch request → one ScoreResult[] response.
 * Isolated behind this function so the transport can swap to a long-lived Port later.
 */
export async function requestScores(req: ScoreBatchRequest): Promise<ScoreResult[]> {
  const message: ScoreBatchMessage = { action: ACTIONS.SCORE_BATCH, req };
  const reply = (await browser.runtime.sendMessage(message)) as
    | ScoreBatchReply
    | undefined;
  return reply?.results ?? [];
}
