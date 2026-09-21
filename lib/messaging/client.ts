import { documentSessionId, sendDocumentMessage } from "../access/session";
// lib/messaging/client.ts — content→SW client.
import { browser } from "#imports";
import type { ModelInfo, ScoreBatchRequest, ScoreResult } from "../contract";
import { ACTIONS } from "./protocol";
import type { ScoreBatchMessage, ScoreBatchReply } from "./protocol";

/**
 * False once this content script's extension context has been invalidated
 * (extension reloaded/updated while the tab stayed open). Every runtime/storage
 * API throws from then on — callers use this to freeze quietly instead of
 * spamming "Extension context invalidated" into the page console.
 */
export function contextAlive(): boolean {
  try {
    return typeof browser.runtime?.id === "string";
  } catch {
    return false;
  }
}

export interface ScoreReply {
  results: ScoreResult[];
  /** Snapshot belonging to these results, never another concurrent request's model. */
  model?: ModelInfo;
  /** "down": the daemon is not answering; "unreachable": the worker itself did not answer. */
  backend: "up" | "down" | "unreachable";
}

/**
 * Promise-wrapped runtime.sendMessage: one batch request → one reply.
 * Isolated behind this function so the transport can swap to a long-lived Port later.
 *
 * Transport-level rejections happen in real life (MV3 service-worker cold restart,
 * extension update mid-flight): retry once after a short pause, then return an empty
 * reply so the scheduler completes instead of orphaning the batch on an exception.
 */
export async function requestScores(req: ScoreBatchRequest): Promise<ScoreReply> {
  const message: ScoreBatchMessage = { action: ACTIONS.SCORE_BATCH, req };
  const session = documentSessionId();
  for (let attempt = 0; ; attempt++) {
    if (session !== documentSessionId()) return { results: [], backend: "unreachable" };
    try {
      const reply = (await sendDocumentMessage(message)) as
        | ScoreBatchReply
        | undefined;
      const model = reply?.model && reply.backend === "up" ? { ...reply.model } : undefined;
      // A real verdict without its producer cannot be safely cached or combined.
      if (!model && reply?.results?.some((result) => !result.degraded))
        return { results: [], backend: "unreachable" };
      return { results: reply?.results ?? [], backend: reply?.backend ?? "unreachable", ...(model ? {model} : {}) };
    } catch {
      if (attempt >= 1 || session !== documentSessionId()) return { results: [], backend: "unreachable" };
      await new Promise((r) => setTimeout(r, 300));
    }
  }
}
