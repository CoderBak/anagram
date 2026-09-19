// lib/backend/router.ts — SW-side dedup/batch/retry wrapper around the ScoreClient.
//
// Ports the reference's getRequests dedup/batch wrapper, ADDING a priority queue with a
// concurrency cap (p-queue: the content script's lane — viewport / near / background —
// survives into the worker, so a visible paragraph in any tab is scored before anyone's
// prefetch) and a retry/error-fallback whose policy lives in ./retry.ts.
//
// Provenance rules (the part that bit us): the backend identity that keys the caches is
// snapshotted ONCE per request, every cache/in-flight key is computed from that snapshot
// before any await, and a result is cached under the model that actually PRODUCED it
// (returned with the batch) — never under whatever `client.model()` happens to say after
// the fetch. A shared in-flight promise therefore carries its producer along with the
// result, so a request that only JOINED reports the identity that answered it. Every
// in-flight deferred is settled in `finally`, so a joined request can never hang when the
// backend changes mid-flight.
//
// In-flight keys are reserved before the work reaches the queue, not when it starts: with
// a concurrency cap most batches WAIT first, and a batch nobody can see is a batch someone
// else will start a second time.
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
import { createSwCache, type SwCache } from "./swCache";
import { retryWaitMs } from "./retry";
import { createLogger } from "../log";

const log = createLogger("router");

/** Per-request character budget. Batching buys much less than one would hope: it mostly
 *  amortises the per-request overhead (HTTP round trip, tokenizer, language id) rather
 *  than the forward pass, which is already compute-bound. On our own benchmark
 *  (docs/benchmarks/editlens-m4-24gb-2026-09-14.json, roberta-large) 60-word paragraphs go
 *  32.9 → 51.1 → 52.5 per second at batch 1 / 8 / 32 — about 1.5× and flat after 8 — while
 *  400-word ones stay at 8.2 → 8.4 → 8.2, i.e. nothing at all. So requests are re-packed
 *  here to keep the overhead off the short paragraphs, not to chase throughput (the content
 *  script already sends viewport-first batches; this only merges what arrives together). */
const BATCH_CHAR_BUDGET = 6000;
/** Bounded fan-out the reference lacked. */
const MAX_IN_FLIGHT = 4;
/** At most one retry — and only of a failure ./retry.ts calls transient — then the neutral
 *  fallback. One is enough: the content script re-asks for an "Unavailable" paragraph on
 *  its own schedule, and a second wait here holds one of the four slots meanwhile. */
const RETRIES = 1;
/** p-queue: higher runs first. */
const PRIORITY: Record<ScanPriority, number> = { viewport: 2, near: 1, background: 0 };

/** Where a request came from, as far as the router has to care. */
export interface RequestOrigin {
  /**
   * The tab is a private one. Nothing that exists only because of it may be written to the
   * disk: it may READ the cache (a hit writes nothing), and what its batches produce lives
   * in this worker's memory until some ordinary tab asks for the same text — which it
   * would have produced identically, so from that moment it is no longer the private tab's
   * trace. `sender.tab.incognito` is where this comes from, in the message handler.
   */
  private?: boolean;
}

export interface BackendRouter {
  handle(req: ScoreBatchRequest, origin?: RequestOrigin): Promise<ScoreBatchResponse>;
  /** Forget every cached verdict (options → "Clear cached verdicts"). */
  clear(): Promise<void>;
  /** How many verdicts are on the disk (options → the count beside "Clear"). */
  count(): Promise<number>;
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

/** What a shared in-flight promise resolves: the result AND the identity that produced it,
 *  null when the result is the neutral fallback, which has no producer. */
interface Produced {
  result: ScoreResult;
  model: ModelInfo | null;
}

/** A batch handed to the queue, shared by every key it owns. `id` is p-queue's handle for
 *  reprioritising it and `started` says whether that is still possible. */
interface QueuedBatch {
  id: string;
  priority: number;
  started: boolean;
}

/** One reserved key: the batch that will answer it, its shared promise and its resolver.
 *  `persist` is the union over everyone waiting on it: one ordinary tab among the joiners
 *  is enough for the answer to be written, because that tab asked for it too. */
interface InFlight {
  batch: QueuedBatch;
  promise: Promise<Produced>;
  resolve: (p: Produced) => void;
  persist: boolean;
}

export function createRouter(client: ScoreClient, cache: SwCache = createSwCache()): BackendRouter {
  // In-flight dedup across concurrent handle() calls: cache key → the batch answering it.
  const inFlight = new Map<string, InFlight>();
  // Bounded, prioritised fan-out shared by every handle() call in this worker lifetime.
  const queue = new PQueue({ concurrency: MAX_IN_FLIGHT });
  let nextBatchId = 0;

  /** Raise a waiting batch's priority when a more urgent request joins it: the joiner is
   *  blocked on that batch, so leaving it behind a queue of prefetches would make a visible
   *  paragraph wait for work nobody is looking at. A batch the queue has already dispatched
   *  cannot be reordered — p-queue's setPriority throws for an id it no longer holds — hence
   *  both the `started` check and the catch around it. */
  function promote(entry: InFlight, priority: number): void {
    const { batch } = entry;
    if (batch.started || priority <= batch.priority) return;
    try {
      queue.setPriority(batch.id, priority);
      batch.priority = priority;
    } catch (e) {
      log.warn("could not reprioritise a queued batch", e);
    }
  }

  /**
   * Score one batch; null when the backend failed. A failure that could answer differently
   * next time — the daemon still loading, one request too many, the transport — is tried
   * once more after a jittered wait; anything that says "this request is the problem" is
   * not, because the second answer would be the first one again. The retry re-sends THIS
   * batch and nothing else, so a late answer still belongs to the text that asked for it.
   */
  async function scoreBatchSafe(batch: ScoreBlock[]): Promise<{ results: ScoreResult[]; model: ModelInfo } | null> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await client.scoreBatch(batch);
      } catch (e) {
        const wait = attempt < RETRIES ? retryWaitMs(e) : null;
        if (wait === null) {
          log.error("scoreBatch failed, using neutral fallback", e);
          return null;
        }
        log.warn(`scoreBatch failed, trying once more in ${wait} ms`, e);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  async function handle(req: ScoreBatchRequest, origin: RequestOrigin = {}): Promise<ScoreBatchResponse> {
    // Settle backend discovery, then SNAPSHOT the identity every key in this request uses.
    await client.ready?.();
    const dim = modelDim(client.model());
    const priority = PRIORITY[req.priority] ?? 0;
    /** May what this request produces be written down? Not for a private tab. */
    const persist = origin.private !== true;

    const resultById = new Map<string, ScoreResult>();
    // Unique key → every block in THIS request that shares it.
    const keyToBlocks = new Map<string, ScoreBlock[]>();
    // Representative block per not-yet-known key that we must fetch fresh.
    const toFetch: Keyed[] = [];
    /** The model that produced the first fresh batch (or the snapshot when all were cached). */
    let producing: ModelInfo | null = null;

    // One memory+storage lookup for the whole request (the persistent layer is async).
    const keys = req.blocks.map((b) => cache.keyOf(b.text, dim));
    const hits = await cache.getMany(keys, persist);
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
     *  the identity that produced them, and only as far as `keep` allows — memory alone
     *  when nobody but a private tab is waiting for it. */
    const fanOut = (key: string, r: ScoreResult, producedBy: ModelInfo | null, keep = persist): void => {
      const group = keyToBlocks.get(key) ?? [];
      if (group.length > 0 && !r.degraded && producedBy) cache.set(group[0].text, r, modelDim(producedBy), keep);
      for (const b of group) resultById.set(b.id, { ...r, id: b.id });
    };

    // Collapse against requests already in flight; the rest need a fresh fetch. From here
    // to the registration below nothing may await: a gap is a window in which two callers
    // both find the map empty and both start the same inference.
    const needFetch: Keyed[] = [];
    const joined: Array<Promise<void>> = [];
    for (const k of toFetch) {
      const pending = inFlight.get(k.key);
      if (!pending) {
        needFetch.push(k);
        continue;
      }
      // A joined result was cached by its own batch; here it only needs fanning out, and
      // its provenance is that batch's producer — our snapshot may already be stale.
      joined.push(
        pending.promise.then(({ result, model }) => {
          producing ??= model;
          fanOut(k.key, result, null);
        }),
      );
      // An ordinary tab joining a private tab's batch is an ordinary tab asking for that
      // text: the answer may be written down, and the batch settling below is what does it.
      if (persist) pending.persist = true;
      promote(pending, priority);
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

    // Reserve every key of every batch BEFORE the queue sees the work: with a concurrency
    // cap a batch usually waits for a slot first, and while it waits a second caller asking
    // for the same text must join it rather than start its own inference.
    const reserved = batches.map((batch) => {
      const record: QueuedBatch = { id: `q${nextBatchId++}`, priority, started: false };
      const entries = new Map<string, InFlight>();
      for (const k of batch) {
        let resolve!: (p: Produced) => void;
        const promise = new Promise<Produced>((res) => {
          resolve = res;
        });
        const entry: InFlight = { batch: record, promise, resolve, persist };
        entries.set(k.key, entry);
        inFlight.set(k.key, entry);
      }
      return { batch, record, entries };
    });

    const runBatch = async (
      batch: Keyed[],
      record: QueuedBatch,
      entries: Map<string, InFlight>,
    ): Promise<void> => {
      record.started = true; // the queue has dispatched it; reordering is no longer possible
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
          const entry = entries.get(k.key);
          fanOut(k.key, r, producedBy, entry?.persist ?? persist);
          entry?.resolve({ result: r, model: r.degraded ? null : producedBy });
          // Only OUR reservation may go: a later request may already have claimed the key.
          if (inFlight.get(k.key) === entry) inFlight.delete(k.key);
        }
      }
    };

    // The reservations are in place, so the priority queue may now run the fetches whenever
    // it likes; `id` is what lets a later, more urgent joiner move one of them forward.
    await Promise.all([
      ...reserved.map(({ batch, record, entries }) =>
        queue.add(() => runBatch(batch, record, entries), { priority, id: record.id }),
      ),
      ...joined,
    ]);

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

  /**
   * Empty both cache layers. Requests already in flight are deliberately left alone: they
   * settle and answer their callers exactly as they would have, and the verdict each brings
   * back is the daemon's current answer, so caching it is right even though it lands after
   * the clear.
   */
  function clear(): Promise<void> {
    return cache.clear();
  }

  return { handle, clear, count: () => cache.count() };
}
