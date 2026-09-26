// lib/capture/scheduler.ts — 3-lane priority queue + epoch/generation guard.
//
// Lanes: viewport > near > background. Units are micro-batched up to a per-lane char
// budget with a bounded fan-out (maxInFlight). Dedup is by UNIT IDENTITY — a unit is
// never in flight twice — NOT by text: distinct paragraphs sharing the same text each
// need their own badge (text-level dedup lives in the orchestrator's send()). A unit
// already queued in a LOWER lane is upgraded when enqueued for a higher one (the idle
// prefetch never pulls anything down); requeue() follows the reader both ways, so a
// paragraph that was on screen for a moment of a fast scroll goes back behind the one
// the reader stopped at. What has been sent stays sent: nothing recalls a batch in
// flight. Each enqueue captures the current epoch; responses from a superseded
// generation are discarded.
//
// The queue moves UNITS and nothing smaller. What a unit becomes on the wire — one block,
// or several windows when it is longer than the model reads in one pass — is send()'s
// business, and send() answers with one verdict per unit, so a long unit can never be
// split across two batches or rendered half-done. `V` is that verdict; the scheduler
// never looks inside it.
//
// Budgets are per lane because the trade-off differs: the viewport lane wants the
// first chip fast (small batch), the background prefetch lane can afford a larger one.
// Batching buys less than one would hope — it amortises the per-request overhead (native
// framing, tokenizer, language id), not the forward pass, which is already
// compute-bound: on our own M4 24GB benchmark (2026-09, roberta-large) 60-word paragraphs
// go 32.9 → 51.1 → 52.5 per second at batch 1 / 8 / 32
// (about 1.5×, flat after 8) while 400-word ones stay at 8.2 → 8.4 → 8.2, i.e. gain
// nothing at all. The background lane is also capped to `maxBackgroundInFlight`
// concurrent batches so prefetch never starves what the reader can actually see.
import type { Unit, Lane } from "../types";
import { MAX_READ_CHARS } from "./windows";

export interface Scheduler {
  /** Queue a unit, or move it UP to `lane` when it waits in a lower one. */
  enqueue(unit: Unit, lane: Lane): void;
  /** Queue a unit in exactly `lane`, moving it down as well as up. One in flight stays. */
  requeue(unit: Unit, lane: Lane): void;
  bumpEpoch(): number; // SPA route change / teardown
  stop(): void;
  /** Units currently queued (any lane) or in flight. */
  pendingCount(): number;
  /** Hold dispatch (backend down): queued units wait, in-flight batches finish. */
  pause(): void;
  resume(): void;
}

const LANES: Lane[] = ["viewport", "near", "background"];
const LANE_RANK: Record<Lane, number> = { viewport: 0, near: 1, background: 2 };
const DEFAULT_BUDGET = 800;

interface Pending {
  unit: Unit;
  epoch: number;
}

export function createScheduler<V>(opts: {
  batchCharBudget: number | Partial<Record<Lane, number>>;
  maxInFlight: number;
  maxBackgroundInFlight?: number;
  send(units: Unit[], lane: Lane): Promise<V[]>;
  render(verdicts: V[], epoch: number): void;
  /** Nothing queued and nothing in flight any more (fired after each batch settles). */
  onIdle?(): void;
}): Scheduler {
  const maxInFlight = opts.maxInFlight || 4;
  const maxBackground = Math.max(1, opts.maxBackgroundInFlight ?? 1);
  const budgetFor = (lane: Lane): number =>
    typeof opts.batchCharBudget === "number"
      ? opts.batchCharBudget || DEFAULT_BUDGET
      : opts.batchCharBudget[lane] || DEFAULT_BUDGET;

  const queues: Record<Lane, Pending[]> = {
    viewport: [],
    near: [],
    background: [],
  };

  let currentEpoch = 0;
  let inFlight = 0;
  let inFlightBackground = 0;
  let pumpScheduled = false;
  let paused = false;

  // id → lane it is queued in (for upgrade); in-flight ids are separate.
  const queuedLane = new Map<string, Lane>();
  const inFlightIds = new Set<string>();

  function place(unit: Unit, lane: Lane, down: boolean): void {
    if (inFlightIds.has(unit.id)) return;
    const existing = queuedLane.get(unit.id);
    if (existing !== undefined) {
      if (existing === lane || (!down && LANE_RANK[lane] > LANE_RANK[existing])) return;
      // Pull it out of the lane it waits in and push it onto the other one.
      const q = queues[existing];
      const i = q.findIndex((p) => p.unit.id === unit.id);
      if (i >= 0) q.splice(i, 1);
    }
    queuedLane.set(unit.id, lane);
    queues[lane].push({ unit, epoch: currentEpoch });
    schedulePump();
  }

  const enqueue = (unit: Unit, lane: Lane): void => place(unit, lane, false);
  const requeue = (unit: Unit, lane: Lane): void => place(unit, lane, true);

  function schedulePump(): void {
    if (pumpScheduled) return;
    pumpScheduled = true;
    queueMicrotask(() => {
      pumpScheduled = false;
      pump();
    });
  }

  /** Pull the next batch from the highest-priority eligible non-empty lane, up to its budget. */
  function pickBatch(): { lane: Lane; batch: Pending[] } | null {
    for (const lane of LANES) {
      const q = queues[lane];
      if (q.length === 0) continue;
      if (lane === "background" && inFlightBackground >= maxBackground) continue;
      const budget = budgetFor(lane);
      const batch: Pending[] = [];
      let chars = 0;
      while (q.length > 0) {
        const next = q[0];
        // A unit costs what is sent for it: all of a long one's windows, up to the cap.
        // One that outweighs the budget alone still goes — in a batch of its own when it
        // leads the queue, and closing the batch in front of it when it does not.
        const len = Math.min(next.unit.text.length, MAX_READ_CHARS);
        if (batch.length > 0 && chars + len > budget) break;
        batch.push(q.shift()!);
        chars += len;
        if (chars >= budget) break;
      }
      return { lane, batch };
    }
    return null;
  }

  function pump(): void {
    if (paused) return;
    while (inFlight < maxInFlight) {
      const picked = pickBatch();
      if (!picked) break;
      dispatch(picked.lane, picked.batch);
    }
  }

  function dispatch(lane: Lane, batch: Pending[]): void {
    inFlight++;
    if (lane === "background") inFlightBackground++;
    for (const p of batch) {
      queuedLane.delete(p.unit.id);
      inFlightIds.add(p.unit.id);
    }
    const batchEpoch = batch[0].epoch;

    opts
      .send(batch.map((p) => p.unit), lane)
      .then((verdicts) => {
        if (batchEpoch === currentEpoch) {
          opts.render(verdicts, batchEpoch);
        }
      })
      .catch(() => {
        // The router owns retry + neutral fallback; swallow so the pump survives.
      })
      .finally(() => {
        inFlight--;
        if (lane === "background") inFlightBackground--;
        for (const p of batch) inFlightIds.delete(p.unit.id);
        schedulePump();
        // Only now is the batch fully released — a pendingCount() check inside render()
        // still saw these ids in flight, which is how the idle prefetch stalled after
        // its first pass on very long pages.
        if (pendingCount() === 0) opts.onIdle?.();
      });
  }

  function bumpEpoch(): number {
    currentEpoch++;
    for (const lane of LANES) queues[lane].length = 0;
    queuedLane.clear();
    return currentEpoch;
  }

  function stop(): void {
    bumpEpoch();
    inFlightIds.clear();
    paused = false;
  }

  function pendingCount(): number {
    return queuedLane.size + inFlightIds.size;
  }

  function pause(): void {
    paused = true;
  }

  function resume(): void {
    if (!paused) return;
    paused = false;
    schedulePump();
  }

  return { enqueue, requeue, bumpEpoch, stop, pendingCount, pause, resume };
}
