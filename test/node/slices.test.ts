// test/node/slices.test.ts — long work in slices (lib/slices.ts): the same answer at once or a
// few milliseconds at a time, with the main thread handed back between slices.
import { describe, expect, it, vi } from "vitest";
import { finish, finishInSlices } from "../../lib/slices";

function* count(to: number, seen: number[]): Generator<void, number> {
  let sum = 0;
  for (let k = 1; k <= to; k++) { sum += k; seen.push(k); yield; }
  return sum;
}

describe("slices", () => {
  it("runs a computation to its end at once, as a function", () => {
    const seen: number[] = [];
    expect(finish(count(100, seen))).toBe(5050);
    expect(seen).toHaveLength(100);
  });

  it("runs it to the same end in slices, handing the main thread back whenever a slice has run its time", async () => {
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(() => now);
    const handedBack: number[] = [];
    const steps = (function* () {
      for (let k = 0; k < 10; k++) { now += 3; yield; } // 3 ms a step, 8 ms a slice
      return "done";
    })();
    const out = finishInSlices(steps, 8);
    // Nothing has had a turn yet: the first slice runs before the first hand-back.
    setTimeout(() => handedBack.push(now), 0);
    expect(await out).toBe("done");
    expect(handedBack.length).toBeGreaterThan(0);
    vi.restoreAllMocks();
  });
});
