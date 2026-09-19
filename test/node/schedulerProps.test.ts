// test/node/schedulerProps.test.ts — properties of the 3-lane scheduler.
//
// Everything the reader sees passes through this queue, and the ways it can go wrong are
// invisible from a single fixture: a unit scored twice, a paragraph that waits behind a
// prefetch, a verdict from a route the reader has already left, a queue that never
// reports itself idle so the prefetch stalls. Each case below is a seeded PROGRAM —
// enqueues in three lanes with repeated ids and upgrades, pause/resume, epoch bumps and
// completions in a random interleaving — run against a model of what the scheduler is
// supposed to be holding. A failure names the seed to reproduce it.
import { describe, expect, it } from "vitest";
import { createScheduler, type Scheduler } from "../../lib/capture/scheduler";
import type { Lane, Unit } from "../../lib/types";
import { rng, seeds } from "./random";

const LANES: Lane[] = ["viewport", "near", "background"];
const RANK: Record<Lane, number> = { viewport: 0, near: 1, background: 2 };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Verdict {
  id: string;
  epoch: number;
}

/** Everything one seeded program found wrong, in the order it happened. */
async function runProgram(seed: number): Promise<string[]> {
  const r = rng(seed);
  const problems: string[] = [];
  const fail = (msg: string): number => problems.push(msg);

  const ids = Array.from({ length: r.int(4, 14) }, (_, i) => `u${i}`);
  const texts = new Map(ids.map((id) => [id, "x".repeat(r.int(60, 4000))] as const));
  const unit = (id: string): Unit =>
    ({ id, parts: [], text: texts.get(id)!, wordCount: 40, formulas: 0, order: 0, topElement: null as never, container: null as never, isScored: false });

  // The model: what the scheduler should be holding, kept in step with every call. The
  // driver only touches it between macrotasks, so the scheduler's own microtasks (its
  // pump, render and release) have always run by the time it is read again.
  const queued = new Map<string, Lane>();
  const live = new Set<string>();
  const dispatched = new Set<string>(); // already sent in this epoch — not re-enqueued
  const sentPerEpoch = new Map<number, Set<string>>();
  let epoch = 0;
  let idle = 0;
  let workSinceIdle = false;

  let s!: Scheduler;
  s = createScheduler<Verdict>({
    batchCharBudget: r.chance(0.5)
      ? r.int(200, 3000)
      : { viewport: r.int(200, 1200), near: r.int(200, 2000), background: r.int(400, 4000) },
    maxInFlight: r.int(1, 4),
    maxBackgroundInFlight: r.int(1, 2),
    async send(units, lane) {
      const batch = units.map((u) => u.id);
      const at = epoch;
      if (new Set(batch).size !== batch.length) fail(`batch holds a unit twice: ${batch.join(",")}`);
      for (const id of batch) {
        if (live.has(id)) fail(`${id} dispatched while already in flight`);
        if (!queued.has(id)) fail(`${id} dispatched without being queued`);
        let seen = sentPerEpoch.get(at);
        if (!seen) sentPerEpoch.set(at, (seen = new Set()));
        if (seen.has(id)) fail(`${id} sent twice in epoch ${at}`);
        seen.add(id);
        queued.delete(id);
        live.add(id);
        dispatched.add(id);
      }
      // Priority: nothing in a higher lane may still be waiting when this batch goes.
      for (const [id, waiting] of queued) {
        if (RANK[waiting] < RANK[lane]) fail(`${lane} batch went while ${id} waited in ${waiting}`);
      }
      workSinceIdle = true;
      await sleep(r.int(0, 3));
      for (const id of batch) live.delete(id);
      return batch.map((id) => ({ id, epoch: at }));
    },
    render(verdicts, at) {
      if (at !== epoch) fail(`rendered a batch of epoch ${at} while ${epoch} is current`);
      for (const v of verdicts) {
        if (v.epoch !== epoch) fail(`verdict produced in epoch ${v.epoch} rendered in ${epoch}`);
      }
    },
    onIdle() {
      idle++;
      if (s.pendingCount() !== 0) fail(`onIdle fired with ${s.pendingCount()} units pending`);
      if (!workSinceIdle) fail("onIdle fired twice without a batch in between");
      workSinceIdle = false;
    },
  });

  const steps = r.int(20, 55);
  let paused = false;
  for (let i = 0; i < steps; i++) {
    const op = r.float();
    if (op < 0.62) {
      // A unit already in flight, or already answered in this epoch, is not offered
      // again — that is the orchestrator's contract, and what the queue is deduped for
      // is the SAME unit coming back from a scroll while it still waits.
      const free = ids.filter((id) => !live.has(id) && !dispatched.has(id));
      if (free.length > 0) {
        const id = r.pick(free);
        const lane = r.pick(LANES);
        const current = queued.get(id);
        if (current === undefined || RANK[lane] < RANK[current]) queued.set(id, lane);
        s.enqueue(unit(id), lane);
      }
    } else if (op < 0.72) {
      s.pause();
      paused = true;
    } else if (op < 0.84) {
      s.resume();
      paused = false;
    } else if (op < 0.92) {
      s.bumpEpoch();
      epoch++;
      queued.clear();
      dispatched.clear();
    }
    await sleep(r.int(0, 2));
  }
  if (paused) s.resume();

  for (let i = 0; i < 400 && s.pendingCount() > 0; i++) await sleep(5);
  if (s.pendingCount() !== 0) fail(`still ${s.pendingCount()} pending after draining`);
  // Everything that was queued and not dropped by an epoch bump has been sent.
  if (queued.size > 0) fail(`never dispatched: ${[...queued.keys()].join(",")}`);
  const settled = idle;
  await sleep(30);
  if (idle !== settled) fail(`onIdle fired again after the queue settled (${settled} → ${idle})`);
  if (idle === 0 && sentPerEpoch.size > 0) fail("onIdle never fired although batches ran");
  return problems;
}

describe("scheduler programs", () => {
  it(
    "holds its invariants under random interleavings of enqueue, pause, bumpEpoch and completion",
    async () => {
      for (const seed of seeds(40)) {
        const problems = await runProgram(seed);
        if (problems.length > 0) throw new Error(`seed ${seed}: ${problems.join(" | ")}`);
      }
    },
    60_000,
  );
});
