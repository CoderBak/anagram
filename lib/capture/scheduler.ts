// lib/capture/scheduler.ts — 3-lane priority queue + epoch/generation guard.
//
// Lanes: viewport > near > background. Units are micro-batched up to a char budget
// (default 800) with a bounded fan-out (maxInFlight=4). Dedup is by UNIT IDENTITY —
// a unit is never in flight twice — NOT by text: distinct paragraphs sharing the
// same text each need their own badge (text-level dedup lives in the orchestrator's
// send()). A unit already queued in a LOWER lane is upgraded when re-enqueued for a
// higher one (near → viewport on scroll). Each enqueue captures the current epoch;
// responses from a superseded generation are discarded.
import type { Unit, Lane } from "../types";
import type { ScoreBlock, ScoreResult } from "../contract";
import { truncateForScoring } from "../dom/text";

export interface Scheduler {
  enqueue(unit: Unit, lane: Lane): void;
  bumpEpoch(): number; // SPA route change / teardown
  flush(): void;
  stop(): void;
}

const LANES: Lane[] = ["viewport", "near", "background"];
const LANE_RANK: Record<Lane, number> = { viewport: 0, near: 1, background: 2 };

interface Pending {
  unit: Unit;
  epoch: number;
}

export function createScheduler(opts: {
  batchCharBudget: number;
  maxInFlight: number;
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

  // id → lane it is queued in (for upgrade); in-flight ids are separate.
  const queuedLane = new Map<string, Lane>();
  const inFlightIds = new Set<string>();

  function enqueue(unit: Unit, lane: Lane): void {
    if (inFlightIds.has(unit.id)) return;
    const existing = queuedLane.get(unit.id);
    if (existing !== undefined) {
      if (LANE_RANK[lane] >= LANE_RANK[existing]) return; // same or lower — keep
      // Upgrade: pull out of the lower lane, re-push into the higher one.
      const q = queues[existing];
      const i = q.findIndex((p) => p.unit.id === unit.id);
      if (i >= 0) q.splice(i, 1);
    }
    queuedLane.set(unit.id, lane);
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

  /** Pull the next batch from the highest-priority non-empty lane, up to the budget. */
  function pickBatch(): { lane: Lane; batch: Pending[] } | null {
    for (const lane of LANES) {
      const q = queues[lane];
      if (q.length === 0) continue;
      const batch: Pending[] = [];
      let chars = 0;
      while (q.length > 0) {
        const next = q[0];
        const len = Math.min(next.unit.text.length, 4096);
        if (batch.length > 0 && chars + len > batchCharBudget) break;
        batch.push(q.shift()!);
        chars += len;
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
      queuedLane.delete(p.unit.id);
      inFlightIds.add(p.unit.id);
    }
    const batchEpoch = batch[0].epoch;
    const blocks: ScoreBlock[] = batch.map((p) => ({
      id: p.unit.id,
      // Long paragraphs render whole but are SCORED on a sentence-bounded prefix.
      text: truncateForScoring(p.unit.text),
      order: p.unit.order,
    }));

    opts
      .send(blocks, lane)
      .then((results) => {
        if (batchEpoch === currentEpoch) {
          opts.render(results, batchEpoch);
        }
      })
      .catch(() => {
        // The router owns retry + neutral fallback; swallow so the pump survives.
      })
      .finally(() => {
        inFlight--;
        for (const p of batch) inFlightIds.delete(p.unit.id);
        schedulePump();
      });
  }

  function bumpEpoch(): number {
    currentEpoch++;
    for (const lane of LANES) queues[lane].length = 0;
    queuedLane.clear();
    return currentEpoch;
  }

  function flush(): void {
    pumpScheduled = false;
    pump();
  }

  function stop(): void {
    bumpEpoch();
    inFlightIds.clear();
  }

  return { enqueue, bumpEpoch, flush, stop };
}
