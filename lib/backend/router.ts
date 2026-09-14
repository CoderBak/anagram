// lib/backend/router.ts — SW-side dedup/batch/retry wrapper around the ScoreClient.
// Ports the reference's getRequests dedup/batch wrapper, ADDING a concurrency cap
// (p-limit) and retry/error-fallback (p-retry) — the reference lacked both. See spec §4.6.
import type {
  ScoreClient,
  ScoreBlock,
  ScoreResult,
  ScoreBatchRequest,
  ScoreBatchResponse,
} from "../contract";
import { BUCKET_COUNT } from "../contract";
import pLimit from "p-limit";
import pRetry from "p-retry";
import { createSwCache } from "./swCache";
import { createLogger } from "../log";

const log = createLogger("router");

/** Per-request character budget. The model scores ~3× more paragraphs per second in
 *  batches of 12+ than singly, so requests are re-packed generously here (the content
 *  script already sends viewport-first batches; this only merges what arrives together). */
const BATCH_CHAR_BUDGET = 6000;
/** Bounded fan-out the reference lacked. */
const MAX_IN_FLIGHT = 4;
/** One retry after this backoff (ms), then the neutral fallback. */
const RETRIES = 1;
const RETRY_BACKOFF_MS = 150;

export interface BackendRouter {
  handle(req: ScoreBatchRequest): Promise<ScoreBatchResponse>;
}

/** Neutral "unavailable" result so a badge can still render and no awaiter hangs. */
function neutral(block: ScoreBlock): ScoreResult {
  return {
    id: block.id,
    bucket: 0,
    probs: new Array<number>(BUCKET_COUNT).fill(1 / BUCKET_COUNT),
    score: 0,
    degraded: true, // fallback, not a model output — never cached
  };
}

export function createRouter(client: ScoreClient): BackendRouter {
  const cache = createSwCache(() => {
    const m = client.model();
    return `${m.id}@${m.ver}`;
  });
  // In-flight dedup across concurrent handle() calls: content-key → pending ScoreResult.
  const inFlight = new Map<string, Promise<ScoreResult>>();

  // Bounded fan-out shared by every handle() call in this worker lifetime.
  const limit = pLimit(MAX_IN_FLIGHT);

  /** Score one batch, retry once with backoff, then fall back to neutral results. */
  async function scoreBatchSafe(batch: ScoreBlock[]): Promise<ScoreResult[]> {
    try {
      return await pRetry(() => client.scoreBatch(batch), {
        retries: RETRIES,
        minTimeout: RETRY_BACKOFF_MS,
        factor: 1,
        randomize: false,
        onFailedAttempt: ({ error, retriesLeft }) =>
          log.warn(`scoreBatch failed (${retriesLeft} retr${retriesLeft === 1 ? "y" : "ies"} left)`, error),
      });
    } catch (e) {
      log.error("scoreBatch failed after retry, using neutral fallback", e);
      return batch.map(neutral);
    }
  }

  async function handle(req: ScoreBatchRequest): Promise<ScoreBatchResponse> {
    // Settle backend discovery first so cache keys carry the right model dimension.
    await client.ready?.();
    const resultById = new Map<string, ScoreResult>();
    // Unique content-key → every block in THIS request that shares it.
    const keyToBlocks = new Map<string, ScoreBlock[]>();
    // Representative block per not-yet-known key that we must fetch fresh.
    const toFetch: ScoreBlock[] = [];

    // One memory+storage lookup for the whole request (the persistent layer is async).
    const keys = req.blocks.map((b) => cache.keyOf(b.text));
    const hits = await cache.getMany(keys);
    for (const [i, block] of req.blocks.entries()) {
      // SW-side cache hit → skip the backend entirely.
      const key = keys[i];
      const cached = hits.get(key);
      if (cached) {
        resultById.set(block.id, { ...cached, id: block.id });
        continue;
      }
      let group = keyToBlocks.get(key);
      if (!group) {
        group = [];
        keyToBlocks.set(key, group);
        toFetch.push(block); // first occurrence is the representative
      }
      group.push(block);
    }

    /** Apply a representative's result to every block sharing its key; cache REAL
     *  results only (a degraded fallback cached once would outlive the outage). */
    const fanOut = (key: string, r: ScoreResult): void => {
      const text = keyToBlocks.get(key)?.[0]?.text;
      if (text !== undefined && !r.degraded) cache.set(text, r);
      for (const b of keyToBlocks.get(key) ?? []) {
        resultById.set(b.id, { ...r, id: b.id });
      }
    };

    // Collapse against requests already in flight; the rest need a fresh fetch.
    const needFetch: ScoreBlock[] = [];
    const joined: Array<Promise<void>> = [];
    for (const rep of toFetch) {
      const key = cache.keyOf(rep.text);
      const pending = inFlight.get(key);
      if (pending) {
        joined.push(pending.then((r) => fanOut(key, r)));
      } else {
        needFetch.push(rep);
      }
    }

    // Char-budget micro-batching of the representatives we must fetch.
    const batches: ScoreBlock[][] = [];
    let current: ScoreBlock[] = [];
    let size = 0;
    for (const b of needFetch) {
      if (current.length > 0 && size + b.text.length > BATCH_CHAR_BUDGET) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(b);
      size += b.text.length;
    }
    if (current.length > 0) batches.push(current);

    const runBatch = async (batch: ScoreBlock[]): Promise<void> => {
      // Register an in-flight deferred per key BEFORE awaiting so concurrent calls dedup.
      const resolvers = new Map<string, (r: ScoreResult) => void>();
      for (const b of batch) {
        const key = cache.keyOf(b.text);
        let resolve!: (r: ScoreResult) => void;
        const p = new Promise<ScoreResult>((res) => {
          resolve = res;
        });
        inFlight.set(key, p);
        resolvers.set(key, resolve);
      }

      const results = await scoreBatchSafe(batch);
      const byId = new Map(results.map((r) => [r.id, r] as const));

      for (const b of batch) {
        const key = cache.keyOf(b.text);
        const r = byId.get(b.id) ?? neutral(b);
        fanOut(key, r);
        resolvers.get(key)?.(r);
        inFlight.delete(key);
      }
    };

    await Promise.all([...batches.map((b) => limit(() => runBatch(b))), ...joined]);

    // Assemble in original request order; neutral fallback for any gap.
    const results = req.blocks.map(
      (b) => resultById.get(b.id) ?? neutral(b),
    );

    return {
      v: req.v,
      session: req.session,
      model: client.model(),
      partial: false,
      results,
    };
  }

  return { handle };
}
