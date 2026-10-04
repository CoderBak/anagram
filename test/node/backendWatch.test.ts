// test/node/backendWatch.test.ts — the engine down and back, as a page sees it
// (lib/capture/backendWatch.ts), and the verdicts kept of a paged document's paragraphs that are
// not drawn (lib/capture/keptLedger.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createBackendWatch } from "../../lib/capture/backendWatch";
import { createKeptLedger } from "../../lib/capture/keptLedger";
import type { BackendStatus } from "../../lib/messaging/protocol";
import type { ModelInfo, ScoreResult } from "../../lib/contract";

const MODEL = { id: "m" } as unknown as ModelInfo;

function watch(answers: Array<Partial<BackendStatus> | Error>) {
  const log: string[] = [];
  let generation = 0;
  let alive = true;
  const w = createBackendWatch({
    pollMs: 5000,
    probe: async (force) => {
      log.push(`probe${force ? " (forced)" : ""}`);
      const next = answers.shift() ?? { active: "down" };
      if (next instanceof Error) throw next;
      return next as BackendStatus;
    },
    alive: () => alive,
    freeze: () => log.push("freeze"),
    changed: (down) => log.push(down ? "down" : "up"),
    learned: () => log.push("learned"),
    adopt: (m) => log.push(`adopt ${m?.id ?? null}`),
    generation: () => generation,
  });
  return { w, log, moveOn: () => generation++, die: () => { alive = false; } };
}

describe("the engine down and back", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("goes down once, asks at once and then every poll, and comes back on a probe that finds it, with its model", async () => {
    const { w, log } = watch([{ active: "down" }, { active: "down" }, { active: "server", model: MODEL }]);
    w.heard("down");
    w.heard("down");
    expect(w.down).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(log).toEqual(["down", "probe", "learned"]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.down).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.down).toBe(false);
    expect(log.slice(-4)).toEqual(["probe", "learned", "up", "adopt m"]);
    // Up: no more polling.
    const n = log.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(log).toHaveLength(n);
  });

  it("counts idle and loading as up, says nothing of a reply that says nothing, and a probe that throws waits for the next poll", async () => {
    const { w, log } = watch([new Error("restarting"), { active: "loading", model: null }]);
    w.heard(undefined);
    w.heard("up");
    expect(log).toEqual([]);
    w.heard("down");
    await vi.advanceTimersByTimeAsync(0);
    expect(w.down).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.down).toBe(false);
    expect(log).toEqual(["down", "probe", "probe", "learned", "up", "adopt null"]);
  });

  it("a probe answered after the run moved on counts for nothing; a dead context freezes the page; Retry forces", async () => {
    const run = watch([{ active: "server", model: MODEL }]);
    run.w.heard("down");
    run.moveOn();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.w.down).toBe(true);
    expect(run.log).toEqual(["down", "probe"]);

    const dead = watch([]);
    dead.die();
    await dead.w.check(true);
    expect(dead.log).toEqual(["freeze"]);

    const retry = watch([{ active: "down" }, { active: "idle", model: MODEL }]);
    retry.w.heard("down");
    await vi.advanceTimersByTimeAsync(0);
    await retry.w.check(true);
    expect(retry.log).toEqual(["down", "probe", "learned", "probe (forced)", "learned", "up", "adopt m"]);
  });

  it("halts its polling on a frozen page and keeps what it heard; a reset is up again for the next run", async () => {
    const { w, log } = watch([]);
    w.heard("down");
    await vi.advanceTimersByTimeAsync(0);
    w.halt();
    const n = log.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(log).toHaveLength(n);
    expect(w.down).toBe(true);
    w.reset();
    expect(w.down).toBe(false);
  });
});

describe("the verdicts kept of paragraphs not drawn", () => {
  const result = { probability: 0.5 } as unknown as ScoreResult;
  const para = (text: string, page = 1) => ({ page, order: 0, text, wordCount: 10 });

  it("lists what no live unit has and the document still has, one per text, the latest verdict", () => {
    const kept = createKeptLedger();
    kept.keep(para("a"), result);
    kept.keep(para("b", 2), result);
    kept.keep(para("b", 3), result);
    expect(kept.now([], null).map((k) => [k.text, k.page])).toEqual([["a", 1], ["b", 3]]);
    expect(kept.now(["a"], null).map((k) => k.text)).toEqual(["b"]);
    expect(kept.now([], new Set(["a"])).map((k) => k.text)).toEqual(["a"]);
    expect([...kept.pages()].sort()).toEqual([1, 3]);
    expect(kept.has("b")).toBe(true);
    const ids = kept.now([], null).map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
    kept.clear();
    expect(kept.now([], null)).toEqual([]);
    expect(kept.has("a")).toBe(false);
  });
});
