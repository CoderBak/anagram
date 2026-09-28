// test/node/warmup.test.ts — the in-browser engine warmed where it will be needed (lib/backend/warmup.ts).
import { describe, expect, it } from "vitest";
import { createWarmup, type Navigation, type WarmupOptions } from "../../lib/backend/warmup";

/** A background whose answers the test sets, counting the warm-ups it asked for. */
function background(over: Partial<{ engine: "native" | "inbrowser" | null; reads: boolean; inFront: boolean; state: "server" | "idle" | "loading" | "down" }> = {}) {
  const facts = { engine: "inbrowser" as "native" | "inbrowser" | null, reads: true, inFront: true, state: "idle" as "server" | "idle" | "loading" | "down", ...over };
  const warmed: number[] = [];
  const options: WarmupOptions = {
    engine: async () => facts.engine,
    reads: async () => facts.reads,
    inFront: async () => facts.inFront,
    state: async () => facts.state,
    warm: async () => { warmed.push(Date.now()); },
  };
  return { navigated: createWarmup(options), warmed, facts };
}
const page: Navigation = { tabId: 3, frameId: 0, url: "https://example.org/essay", documentLifecycle: "active" };

describe("warming the in-browser engine", () => {
  it("warms an idle engine when the tab in front opens a page Anagram reads, and one thought loaded too", async () => {
    for (const state of ["idle", "server"] as const) {
      const b = background({ state });
      expect(await b.navigated(page)).toBe(true);
      expect(b.warmed).toHaveLength(1);
    }
    expect(await background().navigated({ ...page, url: "http://localhost:8080/a.html", documentLifecycle: undefined })).toBe(true);
  });

  it("leaves it alone for a site Anagram does not read, a tab behind, a frame, a prerender or a page that is not the web", async () => {
    const cases: Array<[string, ReturnType<typeof background>, Navigation]> = [
      ["not granted or switched off", background({ reads: false }), page],
      ["a tab behind", background({ inFront: false }), page],
      ["a frame", background(), { ...page, frameId: 5 }],
      ["no tab", background(), { ...page, tabId: -1 }],
      ["a prerender", background(), { ...page, documentLifecycle: "prerender" }],
      ["a file", background(), { ...page, url: "file:///Users/someone/a.html" }],
      ["an extension page", background(), { ...page, url: "chrome-extension://abc/reader.html" }],
    ];
    for (const [why, b, navigation] of cases) {
      expect(await b.navigated(navigation), why).toBe(false);
      expect(b.warmed, why).toEqual([]);
    }
  });

  it("leaves the local engine, and an engine that is not set up, loading or failing, as it is", async () => {
    for (const b of [background({ engine: "native" }), background({ engine: null }), background({ state: "down" }), background({ state: "loading" })]) {
      expect(await b.navigated(page)).toBe(false);
      expect(b.warmed).toEqual([]);
    }
  });

  it("never throws", async () => {
    const b = createWarmup({ engine: async () => { throw new Error("gone"); }, reads: async () => true, inFront: async () => true, state: async () => "idle", warm: async () => undefined });
    expect(await b(page)).toBe(false);
    const failing = createWarmup({ engine: async () => "inbrowser", reads: async () => true, inFront: async () => true, state: async () => "idle", warm: async () => { throw new Error("port closed"); } });
    expect(await failing(page)).toBe(false);
  });
});
