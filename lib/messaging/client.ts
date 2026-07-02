// lib/messaging/client.ts — content→SW client.
import { browser } from "#imports";
import type { ScoreBatchRequest, ScoreResult } from "../contract";
import { ACTIONS } from "./protocol";
import type { ScoreBatchMessage, ScoreBatchReply } from "./protocol";

/**
 * Promise-wrapped runtime.sendMessage: one batch request → one ScoreResult[] response.
 * Isolated behind this function so the transport can swap to a long-lived Port later.
 *
 * Transport-level rejections happen in real life (MV3 service-worker cold restart,
 * extension update mid-flight): retry once after a short pause, then return [] so
 * the scheduler completes instead of orphaning the batch on an exception.
 */
export async function requestScores(req: ScoreBatchRequest): Promise<ScoreResult[]> {
  const message: ScoreBatchMessage = { action: ACTIONS.SCORE_BATCH, req };
  for (let attempt = 0; ; attempt++) {
    try {
      const reply = (await browser.runtime.sendMessage(message)) as
        | ScoreBatchReply
        | undefined;
      return reply?.results ?? [];
    } catch {
      if (attempt >= 1) return [];
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
