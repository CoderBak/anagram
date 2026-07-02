// lib/backend/router.ts — SW-side dedup/batch/retry wrapper around the ScoreClient.
// Ports the reference's getRequests dedup/batch wrapper, ADDING a concurrency cap and
// retry/error-fallback (the reference lacked both). See spec §4.6.
import type {
  ScoreClient,
  ScoreBlock,
  ScoreResult,
  ScoreBatchRequest,
  ScoreBatchResponse,
} from "../contract";
import { createSwCache } from "./swCache";
import { STUB_MODEL } from "./randomStub";
import { createLogger } from "../log";

const log = createLogger("router");

/** Default per-batch character budget (reference value). */
const BATCH_CHAR_BUDGET = 800;
/** Bounded fan-out the reference lacked. */
const MAX_IN_FLIGHT = 4;
/** Backoff (ms) before the single retry. */
const RETRY_BACKOFF_MS = 150;

export interface BackendRouter {
  handle(req: ScoreBatchRequest): Promise<ScoreBatchResponse>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Neutral "unknown" result so a badge can still render and no awaiter hangs. */
function neutral(block: ScoreBlock): ScoreResult {
  return {
    id: block.id,
    detected: false,
    theta_interval: [0, 1], // wide interval
    e_theta: 0.5,
    p_value: 1,
    sentence_flags: [],
    degraded: true, // fallback, not a model output — never cached
  };
}

export function createRouter(client: ScoreClient): BackendRouter {
  const cache = createSwCache();
  // In-flight dedup across concurrent handle() calls: content-key → pending ScoreResult.
  const inFlight = new Map<string, Promise<ScoreResult>>();

  /** Score one batch, retry once with backoff, then fall back to neutral results. */
  async function scoreBatchSafe(batch: ScoreBlock[]): Promise<ScoreResult[]> {
    try {
      return await client.scoreBatch(batch);
    } catch (e1) {
      log.warn("scoreBatch failed, retrying after backoff", e1);
      await sleep(RETRY_BACKOFF_MS);
      try {
        return await client.scoreBatch(batch);
      } catch (e2) {
        log.error("scoreBatch failed after retry, using neutral fallback", e2);
        return batch.map(neutral);
      }
    }
  }

  /** Run batches with a bounded concurrency pool. */
  async function runPool(
    batches: ScoreBlock[][],
    worker: (batch: ScoreBlock[]) => Promise<void>,
  ): Promise<void> {
    let next = 0;
    const lane = async (): Promise<void> => {
      while (next < batches.length) {
        const batch = batches[next++];
        await worker(batch);
      }
    };
    const lanes: Array<Promise<void>> = [];
    const width = Math.min(MAX_IN_FLIGHT, batches.length);
    for (let i = 0; i < width; i++) lanes.push(lane());
    await Promise.all(lanes);
  }

  async function handle(req: ScoreBatchRequest): Promise<ScoreBatchResponse> {
    const resultById = new Map<string, ScoreResult>();
    // Unique content-key → every block in THIS request that shares it.
    const keyToBlocks = new Map<string, ScoreBlock[]>();
    // Representative block per not-yet-known key that we must fetch fresh.
    const toFetch: ScoreBlock[] = [];

    for (const block of req.blocks) {
      // SW-side cache hit → skip the backend entirely.
      const cached = cache.get(block.text);
      if (cached) {
        resultById.set(block.id, { ...cached, id: block.id });
        continue;
      }
      const key = cache.keyOf(block.text);
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

    await Promise.all([runPool(batches, runBatch), ...joined]);

    // Assemble in original request order; neutral fallback for any gap.
    const results = req.blocks.map(
      (b) => resultById.get(b.id) ?? neutral(b),
    );

    return {
      v: req.v,
      session: req.session,
      model: {
        id: STUB_MODEL.id,
        ver: STUB_MODEL.ver,
        calibration: STUB_MODEL.calibration,
      },
      partial: false,
      results,
    };
  }

  return { handle };
}
