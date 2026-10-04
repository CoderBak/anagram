// test/node/scheduler.test.ts — the 3-lane scheduler's idle signal and pause/resume.
import { describe, expect, it, vi } from "vitest";
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

  it("requeue moves a waiting unit down as well as up, and leaves one in flight alone", async () => {
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
    // A fast scroll: three paragraphs were on screen for a moment each.
    s.enqueue(unit(1), "viewport");
    s.enqueue(unit(2), "viewport");
    s.enqueue(unit(3), "viewport");
    s.enqueue(unit(4), "background");
    await Promise.resolve(); // the pump has sent u1
    s.requeue(unit(1), "background"); // in flight: nothing recalls it
    s.requeue(unit(2), "background"); // scrolled far past
    s.requeue(unit(3), "near"); // just above where the reader stopped
    s.enqueue(unit(5), "viewport"); // where the reader stopped
    s.enqueue(unit(3), "background"); // the idle prefetch never pulls anything down
    await new Promise((r) => setTimeout(r, 120));
    expect(lanes).toEqual(["viewport:u1", "viewport:u5", "near:u3", "background:u4", "background:u2"]);
    expect(s.pendingCount()).toBe(0);
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

  it("asks a lane's budget given as a function at each batch: the PDF reader's pace changes it as it goes", async () => {
    const batches: string[] = [];
    const asked: number[] = [];
    let budget = 1; // one unit, as a slow engine's background lane
    const s = createScheduler({
      batchCharBudget: { background: () => { asked.push(budget); return budget; } },
      maxInFlight: 1,
      async send(units) {
        batches.push(units.map((u) => u.id).join(","));
        budget = 10_000; // the engine turned out fast
        await tick();
        return units.map(score);
      },
      render() {},
    });
    for (let i = 1; i <= 4; i++) s.enqueue(unit(i), "background");
    await new Promise((r) => setTimeout(r, 60));
    expect(batches).toEqual(["u1", "u2,u3,u4"]);
    expect(asked).toEqual([1, 10_000]);
  });
  it("holds the background lane for as long as its pace says, and nothing else", async () => {
    const sent: string[] = [];
    let restUntil = 0;
    const s = createScheduler({
      batchCharBudget: 1,
      maxInFlight: 4,
      async send(units, lane) {
        sent.push(`${lane}:${units.map((u) => u.id).join(",")}`);
        // After each background batch the lane rests 40 ms (lib/capture/pace.ts's duty cycle).
        if (lane === "background") restUntil = Date.now() + 40;
        return units.map(score);
      },
      render() {},
      backgroundDelay: () => Math.max(0, restUntil - Date.now()),
    });
    s.enqueue(unit(1), "background");
    s.enqueue(unit(2), "background");
    await tick();
    expect(sent).toEqual(["background:u1"]);
    // On screen and near go at once, rest or no rest.
    s.enqueue(unit(3), "viewport");
    s.enqueue(unit(4), "near");
    await tick();
    expect(sent).toEqual(["background:u1", "viewport:u3", "near:u4"]);
    expect(s.pendingCount()).toBe(1);
    // The rest is up: the lane is looked at again by itself.
    await new Promise((r) => setTimeout(r, 60));
    expect(sent).toEqual(["background:u1", "viewport:u3", "near:u4", "background:u2"]);
  });

  it("looks again at a lane held with no end in sight, and lets nothing of it go after stop()", async () => {
    vi.useFakeTimers();
    try {
      const sent: string[] = [];
      let hold = Infinity;
      const s = createScheduler({
        batchCharBudget: 1,
        maxInFlight: 4,
        async send(units) { sent.push(...units.map((u) => u.id)); return units.map(score); },
        render() {},
        backgroundDelay: () => hold,
      });
      s.enqueue(unit(1), "background");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent).toEqual([]);
      hold = 0; // plugged in, say
      await vi.advanceTimersByTimeAsync(30_000);
      expect(sent).toEqual(["u1"]);
      hold = Infinity;
      s.enqueue(unit(2), "background");
      await vi.advanceTimersByTimeAsync(1);
      s.stop();
      hold = 0;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sent).toEqual(["u1"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
