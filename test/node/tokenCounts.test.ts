import { describe, expect, it } from "vitest";
import { createTokenCounter } from "../../lib/backend/tokenCounts";
import type { ModelInfo } from "../../lib/contract";

function source(counts: ((texts: string[]) => number[] | null), id = "editlens-fp32") {
  const asked: string[][] = [];
  const model: ModelInfo = { id, ver: "1", calibration: "none" };
  return {
    asked,
    model: () => ({ ...model }),
    setModel: (next: string) => { model.id = next; },
    async countTokens(texts: string[]) { asked.push(texts); return counts(texts); },
  };
}

describe("token counts in the worker", () => {
  it("asks the engine once per distinct piece and answers again from memory", async () => {
    const s = source((texts) => texts.map((t) => t.length));
    const counter = createTokenCounter(s);
    expect(await counter.count(["one", "three", "one"])).toEqual([3, 5, 3]);
    expect(await counter.count(["three", "sixteen"])).toEqual([5, 7]);
    expect(s.asked).toEqual([["one", "three"], ["sixteen"]]);
  });

  it("keys counts by the model that counted them, and keeps none while the model is unknown", async () => {
    const s = source((texts) => texts.map((t) => t.length), "none");
    const counter = createTokenCounter(s);
    await counter.count(["one"]);
    await counter.count(["one"]);
    s.setModel("editlens-fp32");
    await counter.count(["one"]);
    await counter.count(["one"]);
    s.setModel("editlens-other");
    await counter.count(["one"]);
    expect(s.asked).toEqual([["one"], ["one"], ["one"], ["one"]]);
  });

  it("is null when the engine cannot count, and remembers nothing from it", async () => {
    let up = false;
    const s = source((texts) => (up ? texts.map(() => 2) : null));
    const counter = createTokenCounter(s);
    expect(await counter.count(["one"])).toBeNull();
    up = true;
    expect(await counter.count(["one"])).toEqual([2]);
  });
});
