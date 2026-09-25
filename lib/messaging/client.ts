import { documentSessionId, sendDocumentMessage } from "../access/session";
// lib/messaging/client.ts — content→SW client.
import { browser } from "#imports";
import type { ModelInfo, ScoreBatchRequest, ScoreResult, TokenCounts } from "../contract";
import { ACTIONS } from "./protocol";
import type { CountTokensMessage, CountTokensReply, ScoreBatchMessage, ScoreBatchReply } from "./protocol";

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
  /** "down": the daemon is not answering; "unreachable": the worker itself did not answer;
   *  "refused": the worker turned the request down and would turn it down again. */
  backend: "up" | "down" | "unreachable" | "refused";
}

/** What the worker answers a message it will not take (entrypoints/background.ts). */
interface Refusal {
  ok: false;
  error?: string;
}

/**
 * Promise-wrapped runtime.sendMessage: one batch request → one reply.
 * Isolated behind this function so the transport can swap to a long-lived Port later.
 *
 * Transport-level rejections happen in real life (MV3 service-worker cold restart,
 * extension update mid-flight): retry once after a short pause, then return an empty
 * reply so the scheduler completes instead of orphaning the batch on an exception.
 *
 * A refusal is not a failure to answer, and asking again on every idle pass is not the
 * way to meet it. A request the worker found malformed stays malformed. One it did not
 * authorize may have reached a worker that restarted before this page's port heard of it,
 * so that one is asked once more, and a second refusal stands.
 */
export async function requestScores(req: ScoreBatchRequest): Promise<ScoreReply> {
  const message: ScoreBatchMessage = { action: ACTIONS.SCORE_BATCH, req };
  const session = documentSessionId();
  for (let attempt = 0; ; attempt++) {
    if (session !== documentSessionId()) return { results: [], backend: "unreachable" };
    let failed: ScoreReply["backend"] = "unreachable";
    try {
      const reply = (await sendDocumentMessage(message)) as
        | ScoreBatchReply
        | Refusal
        | undefined;
      if (reply && "ok" in reply) {
        if (reply.error === "invalid_request") return { results: [], backend: "refused" };
        if (reply.error !== "forbidden") return { results: [], backend: "unreachable" };
        failed = "refused";
      } else {
        const model = reply?.model && reply.backend === "up" ? { ...reply.model } : undefined;
        // A real verdict without its producer cannot be safely cached or combined.
        if (!model && reply?.results?.some((result) => !result.degraded))
          return { results: [], backend: "unreachable" };
        return { results: reply?.results ?? [], backend: reply?.backend ?? "unreachable", ...(model ? {model} : {}) };
      }
    } catch {
      /* the transport failed: retried below */
    }
    if (session !== documentSessionId()) return { results: [], backend: "unreachable" };
    if (attempt >= 1) return { results: [], backend: failed };
    await new Promise((r) => setTimeout(r, 300));
  }
}

/** Most texts and characters one count request carries: what the worker takes. */
const COUNT_TEXTS = 512;
const COUNT_CHARS = 200_000;

/**
 * How many model tokens each text is, alone and following a space, asked of the engine
 * through the worker in requests the worker takes, one after another. Null when any of
 * them went unanswered; the text is then Unavailable, like one whose score failed.
 */
export async function requestTokenCounts(texts: string[]): Promise<TokenCounts | null> {
  const counts: TokenCounts = { alone: [], following: [] };
  for (let at = 0; at < texts.length; ) {
    let end = at;
    let chars = 0;
    while (end < texts.length && end - at < COUNT_TEXTS && (end === at || chars + texts[end].length <= COUNT_CHARS)) {
      chars += texts[end].length;
      end++;
    }
    const slice = texts.slice(at, end);
    const message: CountTokensMessage = { action: ACTIONS.COUNT_TOKENS, texts: slice };
    try {
      const reply = (await sendDocumentMessage(message)) as CountTokensReply | undefined;
      const got = reply?.counts;
      if (!got || !Array.isArray(got.alone) || !Array.isArray(got.following) ||
        got.alone.length !== slice.length || got.following.length !== slice.length) return null;
      counts.alone.push(...got.alone);
      counts.following.push(...got.following);
    } catch {
      return null;
    }
    at = end;
  }
  return counts;
}
