import { describe, expect, it } from "vitest";
import { createTokenCounter } from "../../lib/backend/tokenCounts";
import type { ModelInfo, TokenCounts } from "../../lib/contract";

function source(counts: ((texts: string[]) => number[] | null), id = "editlens-fp32") {
  const pairs = (texts: string[]): TokenCounts | null => {
    const n = counts(texts);
    return n && { alone: n, following: n.map((x) => x + 1) };
  };
  const asked: string[][] = [];
  const model: ModelInfo = { id, ver: "1", calibration: "none" };
  return {
    asked,
    model: () => ({ ...model }),
    setModel: (next: string) => { model.id = next; },
    setVersion: (version: string) => { model.ver = version; },
    async countTokens(texts: string[]) { asked.push(texts); return pairs(texts); },
  };
}

describe("token counts in the worker", () => {
  it("asks the engine once per distinct piece and answers again from memory", async () => {
    const s = source((texts) => texts.map((t) => t.length));
    const counter = createTokenCounter(s);
    expect(await counter.count(["one", "three", "one"])).toEqual({ alone: [3, 5, 3], following: [4, 6, 4] });
    expect(await counter.count(["three", "sixteen"])).toEqual({ alone: [5, 7], following: [6, 8] });
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

  it("keeps the same release name separate by revision and site partition", async () => {
    let size = 1;
    const s = source(texts => texts.map(() => size));
    const counter = createTokenCounter(s);
    const count = (site: string) => counter.count(["word", "word"], undefined, site);
    expect((await count("site A"))?.alone).toEqual([1, 1]);
    size++;
    expect((await count("site B"))?.alone).toEqual([2, 2]);
    expect((await count("site A"))?.alone).toEqual([1, 1]);
    s.setVersion("2");
    expect((await count("site A"))?.alone).toEqual([2, 2]);
    expect(s.asked).toHaveLength(3);
  });

  it("does not cache a late answer across a runtime switch or cancellation", async () => {
    for (const change of ["version", "generation", "cancel"]) {
      let version = "1", generation = 0;
      const controller = new AbortController();
      const first = Promise.withResolvers<TokenCounts>();
      let calls = 0;
      const counter = createTokenCounter({
        model: () => ({ id: "model", ver: version, calibration: "none" }),
        revision: () => generation,
        countTokens: async () => ++calls === 1 ? first.promise : { alone: [7], following: [8] },
      });
      const old = counter.count(["word"], controller.signal);
      if (change === "generation") generation++;
      if (change === "version") version = "2";
      if (change === "cancel") controller.abort();
      first.resolve({ alone: [1], following: [2] });
      expect(await old).toBeNull();
      expect(await counter.count(["word"])).toEqual({ alone: [7], following: [8] });
      expect(calls).toBe(2);
    }
  });

  it("is null when the engine cannot count, and remembers nothing from it", async () => {
    let up = false;
    const s = source((texts) => (up ? texts.map(() => 2) : null));
    const counter = createTokenCounter(s);
    expect(await counter.count(["one"])).toBeNull();
    up = true;
    expect(await counter.count(["one"])).toEqual({ alone: [2], following: [3] });
  });
});
