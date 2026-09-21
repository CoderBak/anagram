// Service-worker score scheduling: bounded admission, document cancellation, shared
// inference, and complete model provenance. Browser authority supplies document keys.
import type { ModelInfo, ScanPriority, ScoreClient, ScoreBlock, ScoreResult,
  ScoreBatchRequest, ScoreBatchResponse } from "../contract";
import { BUCKET_COUNT } from "../contract";
import { canonicalForScoring } from "../dom/text";
import type { ScoreCacheMode } from "../cachePolicy";
import { createSwCache, type SwCache } from "./swCache";
import { retryWaitMs } from "./retry";
import { createLogger } from "../log";

const log = createLogger("router");
const BATCH_CHAR_BUDGET = 6000;
const MAX_IN_FLIGHT = 4;
const MAX_DOCUMENT_IN_FLIGHT = 2;
const PRIORITY: Record<ScanPriority, number> = { viewport: 2, near: 1, background: 0 };
/** Admission includes requests waiting on cache/discovery and deduplicated subscribers,
 * so a slow store or many identical requests cannot bypass the memory bounds. */
export const ROUTER_LIMITS = Object.freeze({
  requests: 256, blocks: 1024, chars: 1_000_000,
  documentRequests: 16, documentBlocks: 256, documentChars: 250_000,
});

export interface RequestOrigin {
  /** Private-only work may read existing disk rows but never writes persistent data. */
  private?: boolean;
  /** Trusted document identity; independent of a page-supplied scan/session id. */
  documentKey?: string;
  signal?: AbortSignal;
}
export interface BackendRouter {
  handle(req: ScoreBatchRequest, origin?: RequestOrigin): Promise<ScoreBatchResponse>;
  cancelDocument(documentKey: string): void;
  clear(): Promise<void>;
  setCacheMode(mode: ScoreCacheMode): Promise<void>;
  count(): Promise<number>;
}
/** JSON avoids delimiter collisions and includes calibration, not just model/version. */
export function modelDim(m: ModelInfo): string { return JSON.stringify([m.id, m.ver, m.calibration]); }
const snapshot = (m: ModelInfo): ModelInfo => ({ id: m.id, ver: m.ver, calibration: m.calibration });
function neutral(block: ScoreBlock): ScoreResult {
  return { id: block.id, bucket: 0, probs: new Array<number>(BUCKET_COUNT).fill(1 / BUCKET_COUNT),
    score: 0, degraded: true };
}
interface Produced { result: ScoreResult; model: ModelInfo | null }
interface Reader {
  document: string; persist: boolean; active: boolean; entries: Set<Entry>;
  cancelled: Promise<undefined>; cancel(): void;
}
interface Entry {
  key: string; block: ScoreBlock; batch: Batch; readers: Set<Reader>;
  promise: Promise<Produced>; resolve(value: Produced): void;
}
interface Batch {
  priority: number; queuedAt: number; owner?: string;
  entries: Entry[]; controller: AbortController; epoch: number; cacheEpoch: number;
  revision: number | undefined;
}
interface Usage { requests: number; blocks: number; chars: number }

export function createRouter(client: ScoreClient, cache: SwCache = createSwCache()): BackendRouter {
  const inFlight = new Map<string, Entry>();
  const readers = new Set<Reader>();
  const waiting: Batch[] = [];
  const documentUsage = new Map<string, Usage>();
  const runningByDocument = new Map<string, number>();
  const lastServed = new Map<string, number>();
  const total: Usage = { requests: 0, blocks: 0, chars: 0 };
  let epoch = 0, serial = 0, turn = 0, running = 0;
  let cacheMode: ScoreCacheMode = "persistent";
  const revisionMatches = (revision: number | undefined): boolean =>
    revision === undefined || client.revision?.() === revision;

  function settle(entry: Entry, value: Produced): void {
    if (inFlight.get(entry.key) === entry) inFlight.delete(entry.key);
    entry.resolve(value);
  }
  function detach(reader: Reader): void {
    const batches = new Set<Batch>();
    for (const entry of reader.entries) {
      entry.readers.delete(reader);
      batches.add(entry.batch);
      if (!entry.readers.size) settle(entry, { result: neutral(entry.block), model: null });
    }
    reader.entries.clear();
    for (const batch of batches) if (batch.entries.every((entry) => !entry.readers.size)) {
      batch.controller.abort();
      const index = waiting.indexOf(batch);
      if (index >= 0) waiting.splice(index, 1);
    }
    pump();
  }
  function cancelDocument(documentKey: string): void {
    for (const reader of readers) if (reader.document === documentKey) reader.cancel();
  }
  function invalidate(): void {
    epoch++;
    for (const reader of readers) reader.cancel();
  }
  async function score(batch: Batch, blocks: ScoreBlock[]) {
    for (let attempt = 0; ; attempt++) {
      if (batch.controller.signal.aborted || batch.epoch !== epoch || !revisionMatches(batch.revision)) return null;
      try { return await client.scoreBatch(blocks, batch.controller.signal); }
      catch (error) {
        if (batch.controller.signal.aborted) return null;
        const wait = attempt < 1 ? retryWaitMs(error) : null;
        if (wait === null) { log.warn("score failed; returning unavailable", error); return null; }
        await new Promise<void>((resolve) => {
          const signal = batch.controller.signal;
          const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
          const timer = setTimeout(done, wait);
          signal.addEventListener("abort", done, { once: true });
          if (signal.aborted) done();
        });
      }
    }
  }
  async function run(batch: Batch): Promise<void> {
    const live = batch.entries.filter((entry) => entry.readers.size);
    let produced: Awaited<ReturnType<typeof score>> = null;
    try { if (live.length) produced = await score(batch, live.map((entry) => entry.block)); }
    catch (error) { log.warn("batch failed", error); }
    finally {
      const valid = batch.epoch === epoch && batch.cacheEpoch === cache.epoch() &&
        revisionMatches(batch.revision) && !batch.controller.signal.aborted;
      const model = valid && produced ? snapshot(produced.model) : null;
      const results = new Map(valid && produced ? produced.results.map((r) => [r.id, r]) : []);
      for (const entry of batch.entries) {
        const result = entry.readers.size ? results.get(entry.block.id) ?? neutral(entry.block) : neutral(entry.block);
        if (model && !result.degraded && entry.readers.size) {
          const persist = [...entry.readers].some((reader) => reader.active && reader.persist);
          cache.set(entry.block.text, result, modelDim(model), persist, batch.cacheEpoch);
        }
        settle(entry, { result, model: result.degraded ? null : model });
      }
      running--;
      const owner = batch.owner!;
      const remaining = (runningByDocument.get(owner) ?? 1) - 1;
      if (remaining) runningByDocument.set(owner, remaining); else runningByDocument.delete(owner);
      if (!documentUsage.has(owner)) lastServed.delete(owner);
      pump();
    }
  }
  function pump(): void {
    while (running < MAX_IN_FLIGHT) {
      let chosen = -1, chosenOwner = "", bestPriority = -Infinity, bestTurn = Infinity;
      for (let i = 0; i < waiting.length; i++) {
        const batch = waiting[i];
        const owners = new Set(batch.entries.flatMap((entry) => [...entry.readers].map((reader) => reader.document)));
        const owner = [...owners].filter((doc) => (runningByDocument.get(doc) ?? 0) < MAX_DOCUMENT_IN_FLIGHT)
          .sort((a, b) => (lastServed.get(a) ?? 0) - (lastServed.get(b) ?? 0))[0];
        if (!owner) continue;
        // Aging prevents a sustained stream of viewport work starving old background work.
        const priority = batch.priority + Math.floor((Date.now() - batch.queuedAt) / 1000);
        const served = lastServed.get(owner) ?? 0;
        if (priority > bestPriority || (priority === bestPriority && served < bestTurn)) {
          chosen = i; chosenOwner = owner; bestPriority = priority; bestTurn = served;
        }
      }
      if (chosen < 0) return;
      const batch = waiting.splice(chosen, 1)[0];
      batch.owner = chosenOwner;
      lastServed.set(chosenOwner, ++turn);
      runningByDocument.set(chosenOwner, (runningByDocument.get(chosenOwner) ?? 0) + 1);
      running++;
      void run(batch);
    }
  }

  async function handle(req: ScoreBatchRequest, origin: RequestOrigin = {}): Promise<ScoreBatchResponse> {
    let model = snapshot(client.model());
    const response = (results = req.blocks.map(neutral)): ScoreBatchResponse =>
      ({ v: req.v, session: req.session, model, partial: false, results });
    const document = origin.documentKey ?? `anonymous:${++serial}`;
    const usage = documentUsage.get(document) ?? { requests: 0, blocks: 0, chars: 0 };
    const chars = req.blocks.reduce((sum, block) => sum + block.text.length, 0), blocks = req.blocks.length;
    if (origin.signal?.aborted || !blocks || total.requests >= ROUTER_LIMITS.requests ||
      total.blocks + blocks > ROUTER_LIMITS.blocks || total.chars + chars > ROUTER_LIMITS.chars ||
      usage.requests >= ROUTER_LIMITS.documentRequests || usage.blocks + blocks > ROUTER_LIMITS.documentBlocks ||
      usage.chars + chars > ROUTER_LIMITS.documentChars) return response();
    total.requests++; total.blocks += blocks; total.chars += chars;
    usage.requests++; usage.blocks += blocks; usage.chars += chars; documentUsage.set(document, usage);
    let cancel!: () => void;
    const reader: Reader = { document, persist: origin.private !== true, active: true, entries: new Set(),
      cancelled: new Promise<undefined>((resolve) => { cancel = () => resolve(undefined); }),
      cancel() { if (!reader.active) return; reader.active = false; cancel(); detach(reader); } };
    readers.add(reader);
    origin.signal?.addEventListener("abort", reader.cancel, { once: true });
    const requestEpoch = epoch, cacheEpoch = cache.epoch();
    const alive = () => reader.active && requestEpoch === epoch && cacheEpoch === cache.epoch();
    try {
      await Promise.race([client.ready?.(), reader.cancelled]);
      if (!alive()) return response();
      model = snapshot(client.model());
      const revision = client.revision?.(), dim = modelDim(model);
      // The cache and the actual payload use precisely the same canonical bytes.
      const canonical = req.blocks.map((block) => ({ ...block, text: canonicalForScoring(block.text) }));
      const keys = canonical.map((block) => cache.keyOf(block.text, dim));
      const hits = await Promise.race([cache.getMany(keys, reader.persist), reader.cancelled]);
      if (!alive() || !hits || !revisionMatches(revision)) return response();
      const results = new Map<string, ScoreResult>();
      const producers = new Map<string, ModelInfo>();
      const groups = new Map<string, ScoreBlock[]>();
      canonical.forEach((block, index) => {
        const key = keys[index], hit = hits.get(key);
        if (hit) { results.set(block.id, { ...hit, id: block.id }); producers.set(dim, model); }
        else { const group = groups.get(key) ?? []; group.push(block); groups.set(key, group); }
      });
      const promises: Promise<void>[] = [];
      const batches: Batch[] = [];
      let batch: Batch | undefined, size = 0;
      for (const [cacheKey, group] of groups) {
        const key = `${revision ?? "none"}:${cacheKey}`;
        let entry = inFlight.get(key);
        if (!entry) {
          if (!batch || (size && size + group[0].text.length > BATCH_CHAR_BUDGET)) {
            batch = { priority: PRIORITY[req.priority] ?? 0, queuedAt: Date.now(),
              entries: [], controller: new AbortController(), epoch: requestEpoch, cacheEpoch, revision };
            batches.push(batch); size = 0;
          }
          let resolve!: (value: Produced) => void;
          const promise = new Promise<Produced>((done) => { resolve = done; });
          entry = { key, block: group[0], batch, readers: new Set(), promise, resolve };
          batch.entries.push(entry); size += group[0].text.length; inFlight.set(key, entry);
        }
        entry.readers.add(reader); reader.entries.add(entry);
        entry.batch.priority = Math.max(entry.batch.priority, PRIORITY[req.priority] ?? 0);
        promises.push(entry.promise.then(({ result, model: producer }) => {
          if (!alive()) return;
          if (producer) producers.set(modelDim(producer), snapshot(producer));
          for (const block of group) results.set(block.id, { ...result, id: block.id });
        }));
      }
      waiting.push(...batches); pump();
      await Promise.race([Promise.all(promises), reader.cancelled]);
      if (!alive() || !revisionMatches(revision) || producers.size > 1) return response();
      // Cached and fresh results may never be labelled with one arbitrarily chosen model.
      model = producers.values().next().value ?? model;
      return response(req.blocks.map((block) => results.get(block.id) ?? neutral(block)));
    } catch (error) { log.warn("request failed; returning unavailable", error); return response(); }
    finally {
      origin.signal?.removeEventListener("abort", reader.cancel);
      reader.active = false; detach(reader); readers.delete(reader);
      total.requests--; total.blocks -= blocks; total.chars -= chars;
      usage.requests--; usage.blocks -= blocks; usage.chars -= chars;
      if (!usage.requests) { documentUsage.delete(document); if (!runningByDocument.has(document)) lastServed.delete(document); }
    }
  }
  return { handle, cancelDocument,
    clear() { invalidate(); return cache.clear(); },
    setCacheMode(mode) { if (mode !== cacheMode) { cacheMode = mode; invalidate(); } return cache.setMode(mode); },
    count: () => cache.count() };
}
