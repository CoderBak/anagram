// test/node/scheduler.test.ts — the 3-lane scheduler's idle signal and pause/resume.
import { describe, expect, it } from "vitest";
import { createScheduler } from "../../lib/capture/scheduler";
import type { Unit } from "../../lib/types";

const unit = (i: number, text = `paragraph number ${i} `.repeat(12)): Unit =>
  ({ id: `u${i}`, parts: [], text, wordCount: 36, formulas: 0, order: i, topElement: null as never, container: null as never, isScored: false });
/** The scheduler moves units and hands back whatever send() answers — here, just the id. */
const score = (u: Unit): { id: string } => ({ id: u.id });
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("scheduler", () => {
  it("fires onIdle only once every batch has fully settled, with pendingCount() 0", async () => {
    const idleSeen: number[] = [];
    const rendered: string[] = [];
    let s: ReturnType<typeof createScheduler>;
    s = createScheduler({
      batchCharBudget: 800,
      maxInFlight: 2,
      async send(units) {
        await tick();
        return units.map(score);
      },
      render(verdicts) {
        for (const v of verdicts) rendered.push(v.id);
        // Inside render() the batch is still in flight — this used to be where the
        // orchestrator checked for idleness, and it never saw zero.
        expect(s.pendingCount()).toBeGreaterThan(0);
      },
      onIdle: () => idleSeen.push(s.pendingCount()),
    });
    for (let i = 0; i < 7; i++) s.enqueue(unit(i), "background");
    await new Promise((r) => setTimeout(r, 200));
    expect(rendered.length).toBe(7);
    expect(idleSeen).toEqual([0]);
  });

  it("pause() holds dispatch and resume() drains the queue", async () => {
    const sent: string[] = [];
    const s = createScheduler({
      batchCharBudget: 800,
      maxInFlight: 2,
      async send(units) {
        sent.push(...units.map((u) => u.id));
        return units.map(score);
      },
      render() {},
    });
    s.pause();
    s.enqueue(unit(1), "viewport");
    await tick();
    expect(sent).toEqual([]);
    expect(s.pendingCount()).toBe(1);
    s.resume();
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toEqual(["u1"]);
    expect(s.pendingCount()).toBe(0);
  });

  it("upgrades a queued unit to a higher lane and never dispatches it twice", async () => {
    const lanes: string[] = [];
    const s = createScheduler({
      batchCharBudget: 80, // one unit per batch
      maxInFlight: 1,
      async send(units, lane) {
        lanes.push(`${lane}:${units.map((u) => u.id).join(",")}`);
        await tick();
        return units.map(score);
      },
      render() {},
    });
    s.enqueue(unit(1), "background");
    s.enqueue(unit(2), "background");
    s.enqueue(unit(3), "background");
    s.enqueue(unit(3), "viewport"); // upgrade
    await new Promise((r) => setTimeout(r, 120));
    // The pump runs in a microtask, after all four enqueues: the upgraded unit wins
    // the first slot, the background units follow in order, u3 is sent exactly once.
    expect(lanes).toEqual(["viewport:u3", "background:u1", "background:u2"]);
  });

  it("charges a long unit for all of its windows: it travels whole, in a batch of its own", async () => {
    const batches: string[] = [];
    const s = createScheduler({
      batchCharBudget: 6000,
      maxInFlight: 1,
      async send(units) {
        batches.push(units.map((u) => u.id).join(","));
        await tick();
        return units.map(score);
      },
      render() {},
    });
    // 10 000 characters are six windows. Priced at the 4096 characters that used to be
    // the most ever sent for a unit, it would have taken the short units behind it along,
    // to wait for six forward passes of somebody else's text.
    s.enqueue(unit(1), "background");
    s.enqueue(unit(2, "x".repeat(10_000)), "background");
    s.enqueue(unit(3), "background");
    s.enqueue(unit(4), "background");
    await new Promise((r) => setTimeout(r, 120));
    expect(batches).toEqual(["u1", "u2", "u3,u4"]);
  });
});
