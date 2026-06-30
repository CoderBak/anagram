// lib/capture/scheduler.ts — 3-lane priority queue + epoch/generation guard (§4.3).
//
// Lanes: viewport > near > background. Units are micro-batched up to a char budget
// (default 800), with a bounded fan-out (maxInFlight=4). Dedup is by UNIT IDENTITY — a unit
// is never enqueued twice — NOT by text: distinct paragraphs that happen to share the same
// text must each get their own badge. (Request-level dedup by text lives in the
// orchestrator's send(), which scores each unique text once and fans the result out to every
// id.) Each enqueue captures the current epoch; a response is discarded if its epoch no
// longer matches — bumpEpoch() bumps on SPA nav / teardown so stale renders never paint.
import type { Unit, Lane } from "../types";
import type { ScoreBlock, ScoreResult } from "../contract";

export interface Scheduler {
  enqueue(unit: Unit, lane: Lane): void;
  bumpEpoch(): number; // SPA route change / teardown
  flush(): void;
  stop(): void;
}

const LANES: Lane[] = ["viewport", "near", "background"];

interface Pending {
  unit: Unit;
  epoch: number;
}

export function createScheduler(opts: {
  batchCharBudget: number; // default 800 (reference) — parameterized
  maxInFlight: number; // concurrency cap the reference LACKED (default 4)
  send(blocks: ScoreBlock[], lane: Lane): Promise<ScoreResult[]>;
  render(results: ScoreResult[], epoch: number): void;
}): Scheduler {
  const batchCharBudget = opts.batchCharBudget || 800;
  const maxInFlight = opts.maxInFlight || 4;

  const queues: Record<Lane, Pending[]> = {
    viewport: [],
    near: [],
    background: [],
  };

  let currentEpoch = 0;
  let inFlight = 0;
  let pumpScheduled = false;

  // Dedup by UNIT id: a unit is queued or in flight, never both, never twice. Distinct
  // units with identical text are all kept — each one needs its own badge.
  const queuedIds = new Set<string>();
  const inFlightIds = new Set<string>();

  function enqueue(unit: Unit, lane: Lane): void {
    if (queuedIds.has(unit.id) || inFlightIds.has(unit.id)) return; // same unit only
    queuedIds.add(unit.id);
    queues[lane].push({ unit, epoch: currentEpoch });
    schedulePump();
  }

  function schedulePump(): void {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  }

  /** Pull the next batch from the highest-priority non-empty lane, up to the char budget. */
  function pickBatch(): { lane: Lane; batch: Pending[] } | null {
    for (const lane of LANES) {
      const q = queues[lane];
      if (q.length === 0) continue;
      const batch: Pending[] = [];
      let chars = 0;
      while (q.length > 0) {
        const next = q[0];
        // Always take at least one; stop before exceeding the budget thereafter.
        if (batch.length > 0 && chars + next.unit.text.length > batchCharBudget) break;
        batch.push(q.shift()!);
        chars += next.unit.text.length;
        if (chars >= batchCharBudget) break;
      }
      return { lane, batch };
    }
    return null;
  }

  function pump(): void {
    while (inFlight < maxInFlight) {
      const picked = pickBatch();
      if (!picked) break;
      dispatch(picked.lane, picked.batch);
    }
  }

  function dispatch(lane: Lane, batch: Pending[]): void {
    inFlight++;
    for (const p of batch) {
      queuedIds.delete(p.unit.id);
      inFlightIds.add(p.unit.id);
    }
    // All entries in a batch share the live epoch (bumpEpoch clears the queues).
    const batchEpoch = batch[0].epoch;
    const blocks: ScoreBlock[] = batch.map((p, i) => ({
      id: p.unit.id,
      text: p.unit.text,
      order: i,
    }));

    opts
      .send(blocks, lane)
      .then((results) => {
        // Epoch/generation guard: discard renders from a superseded scan generation.
        if (batchEpoch === currentEpoch) {
          opts.render(results, batchEpoch);
        }
      })
      .catch(() => {
        // The router owns retry + neutral fallback; swallow here so the pump survives.
      })
      .finally(() => {
        inFlight--;
        for (const p of batch) inFlightIds.delete(p.unit.id);
        schedulePump(); // keep draining behind the concurrency cap
      });
  }

  function bumpEpoch(): number {
    currentEpoch++;
    // Drop everything still queued for the old generation; in-flight responses are
    // discarded by the epoch guard when they land.
    for (const lane of LANES) {
      const q = queues[lane];
      for (const p of q) queuedIds.delete(p.unit.id);
      q.length = 0;
    }
    return currentEpoch;
  }

  function flush(): void {
    // Force an immediate drain of whatever is queued (partial batches go out).
    pumpScheduled = false;
    pump();
  }

  function stop(): void {
    bumpEpoch();
    inFlightIds.clear();
  }

  return { enqueue, bumpEpoch, flush, stop };
}
