// lib/backend/router.ts — SW-side dedup/batch/retry wrapper around the ScoreClient.
//
// Ports the reference's getRequests dedup/batch wrapper, ADDING a priority queue with a
// concurrency cap (p-queue: the content script's lane — viewport / near / background —
// survives into the worker, so a visible paragraph in any tab is scored before anyone's
// prefetch) and retry/error-fallback (p-retry).
//
// Provenance rules (the part that bit us): the backend identity that keys the caches is
// snapshotted ONCE per request, every cache/in-flight key is computed from that snapshot
// before any await, and a result is cached under the model that actually PRODUCED it
// (returned with the batch) — never under whatever `client.model()` happens to say after
// the fetch. Every in-flight deferred is settled in `finally`, so a joined request can
// never hang when the backend changes mid-flight.
import type {
  ModelInfo,
  ScanPriority,
  ScoreClient,
  ScoreBlock,
  ScoreResult,
  ScoreBatchRequest,
  ScoreBatchResponse,
} from "../contract";
import { BUCKET_COUNT } from "../contract";
import PQueue from "p-queue";
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
/** p-queue: higher runs first. */
const PRIORITY: Record<ScanPriority, number> = { viewport: 2, near: 1, background: 0 };

export interface BackendRouter {
  handle(req: ScoreBatchRequest): Promise<ScoreBatchResponse>;
}

/** Cache-key dimension of a backend identity. */
export function modelDim(m: ModelInfo): string {
  return `${m.id}@${m.ver}`;
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

interface Keyed {
  block: ScoreBlock;
  key: string;
}

export function createRouter(client: ScoreClient): BackendRouter {
  const cache = createSwCache();
  // In-flight dedup across concurrent handle() calls: cache key → pending ScoreResult.
  const inFlight = new Map<string, Promise<ScoreResult>>();
  // Bounded, prioritised fan-out shared by every handle() call in this worker lifetime.
  const queue = new PQueue({ concurrency: MAX_IN_FLIGHT });

  /** Score one batch, retry once with backoff; null when the backend failed. */
  async function scoreBatchSafe(batch: ScoreBlock[]): Promise<{ results: ScoreResult[]; model: ModelInfo } | null> {
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
      return null;
    }
  }

  async function handle(req: ScoreBatchRequest): Promise<ScoreBatchResponse> {
    // Settle backend discovery, then SNAPSHOT the identity every key in this request uses.
    await client.ready?.();
    const dim = modelDim(client.model());
    const priority = PRIORITY[req.priority] ?? 0;

    const resultById = new Map<string, ScoreResult>();
    // Unique key → every block in THIS request that shares it.
    const keyToBlocks = new Map<string, ScoreBlock[]>();
    // Representative block per not-yet-known key that we must fetch fresh.
    const toFetch: Keyed[] = [];
    /** The model that produced the first fresh batch (or the snapshot when all were cached). */
    let producing: ModelInfo | null = null;

    // One memory+storage lookup for the whole request (the persistent layer is async).
    const keys = req.blocks.map((b) => cache.keyOf(b.text, dim));
    const hits = await cache.getMany(keys);
    req.blocks.forEach((block, i) => {
      const key = keys[i];
      const cached = hits.get(key);
      if (cached) {
        resultById.set(block.id, { ...cached, id: block.id });
        return;
      }
      let group = keyToBlocks.get(key);
      if (!group) {
        group = [];
        keyToBlocks.set(key, group);
        toFetch.push({ block, key }); // first occurrence is the representative
      }
      group.push(block);
    });

    /** Apply a representative's result to every block sharing its key; cache REAL
     *  results only (a degraded fallback cached once would outlive the outage), under
     *  the identity that produced them. */
    const fanOut = (key: string, r: ScoreResult, producedBy: ModelInfo | null): void => {
      const group = keyToBlocks.get(key) ?? [];
      if (group.length > 0 && !r.degraded && producedBy) cache.set(group[0].text, r, modelDim(producedBy));
      for (const b of group) resultById.set(b.id, { ...r, id: b.id });
    };

    // Collapse against requests already in flight; the rest need a fresh fetch.
    const needFetch: Keyed[] = [];
    const joined: Array<Promise<void>> = [];
    for (const k of toFetch) {
      const pending = inFlight.get(k.key);
      // A joined result was cached by its own batch; here it only needs fanning out.
      if (pending) joined.push(pending.then((r) => fanOut(k.key, r, null)));
      else needFetch.push(k);
    }

    // Char-budget micro-batching of the representatives we must fetch.
    const batches: Keyed[][] = [];
    let current: Keyed[] = [];
    let size = 0;
    for (const k of needFetch) {
      if (current.length > 0 && size + k.block.text.length > BATCH_CHAR_BUDGET) {
        batches.push(current);
        current = [];
        size = 0;
      }
      current.push(k);
      size += k.block.text.length;
    }
    if (current.length > 0) batches.push(current);

    const runBatch = async (batch: Keyed[]): Promise<void> => {
      // Register an in-flight deferred per key BEFORE awaiting so concurrent calls dedup.
      const resolvers = new Map<string, (r: ScoreResult) => void>();
      for (const k of batch) {
        let resolve!: (r: ScoreResult) => void;
        const p = new Promise<ScoreResult>((res) => {
          resolve = res;
        });
        inFlight.set(k.key, p);
        resolvers.set(k.key, resolve);
      }
      let byId = new Map<string, ScoreResult>();
      let producedBy: ModelInfo | null = null;
      try {
        const scored = await scoreBatchSafe(batch.map((k) => k.block));
        if (scored) {
          byId = new Map(scored.results.map((r) => [r.id, r] as const));
          producedBy = scored.model;
          producing ??= scored.model;
        }
      } finally {
        // Whatever happened, every key settles and leaves the in-flight map.
        for (const k of batch) {
          const r = byId.get(k.block.id) ?? neutral(k.block);
          fanOut(k.key, r, producedBy);
          resolvers.get(k.key)?.(r);
          if (inFlight.get(k.key) !== undefined) inFlight.delete(k.key);
        }
      }
    };

    // Register deferreds synchronously (dedup for callers arriving while we queue),
    // then let the priority queue run the fetches.
    await Promise.all([...batches.map((b) => queue.add(() => runBatch(b), { priority })), ...joined]);

    // Assemble in original request order; neutral fallback for any gap.
    const results = req.blocks.map((b) => resultById.get(b.id) ?? neutral(b));

    return {
      v: req.v,
      session: req.session,
      model: producing ?? client.model(),
      partial: false,
      results,
    };
  }

  return { handle };
}
