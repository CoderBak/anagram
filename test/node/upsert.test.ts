// test/node/upsert.test.ts — the Map/WeakMap upsert methods pdf.js needs, where there are none.
import { afterEach, describe, expect, it, vi } from "vitest";

type Upsert<K, V> = {
  getOrInsert(key: K, value: V): V;
  getOrInsertComputed(key: K, compute: (key: K) => V): V;
};
const NAMES = ["getOrInsert", "getOrInsertComputed"] as const;
const own = new Map(
  [Map, WeakMap].flatMap(({ prototype }) => NAMES.map((name) => [[prototype, name], Object.getOwnPropertyDescriptor(prototype, name)] as const)),
);

afterEach(() => {
  // Put back whatever this Node had, so no other suite sees ours.
  for (const [[prototype, name], descriptor] of own) {
    if (descriptor) Object.defineProperty(prototype, name, descriptor);
    else delete (prototype as unknown as Record<string, unknown>)[name];
  }
  vi.resetModules();
});

describe("lib/pdf/upsert.ts", () => {
  it("adds them to Map and WeakMap, computing only what is missing", async () => {
    for (const [[prototype, name]] of own) delete (prototype as unknown as Record<string, unknown>)[name];
    await import("../../lib/pdf/upsert");
    const map = new Map([["a", 1]]) as Map<string, number> & Upsert<string, number>;
    const compute = vi.fn((key: string) => key.length * 10);
    expect(map.getOrInsertComputed("a", compute)).toBe(1);
    expect(map.getOrInsertComputed("bb", compute)).toBe(20);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(map.get("bb")).toBe(20);
    expect(map.getOrInsert("c", 3)).toBe(3);
    expect(map.getOrInsert("c", 4)).toBe(3);
    expect(() => map.getOrInsertComputed("d", 5 as never)).toThrow(TypeError);
    const key = {};
    const weak = new WeakMap() as WeakMap<object, string> & Upsert<object, string>;
    expect(weak.getOrInsertComputed(key, () => "x")).toBe("x");
    expect(weak.getOrInsert(key, "y")).toBe("x");
  });

  it("leaves a browser's own alone", async () => {
    const native = function getOrInsertComputed(): string {
      return "native";
    };
    Object.defineProperty(Map.prototype, "getOrInsertComputed", { value: native, writable: true, configurable: true });
    await import("../../lib/pdf/upsert");
    expect((Map.prototype as unknown as Record<string, unknown>).getOrInsertComputed).toBe(native);
  });
});
