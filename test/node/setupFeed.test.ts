// test/node/setupFeed.test.ts — the in-browser engine's download, pushed to the popup and the
// panel while it runs and they show it (lib/backend/setupFeed.ts).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSetupFeed, FOLLOW_MS, type SetupListener } from "../../lib/backend/setupFeed";
import type { EngineSetup } from "../../lib/messaging/protocol";

const downloading = (percent: number): EngineSetup => ({ state: "downloading", percent });
const panel: SetupListener = { tabId: 7, frameId: 0, documentId: "doc" };

/** A feed over an engine whose setup the test moves, recording every read and every push. */
function feed(start: EngineSetup | null) {
  let now = start;
  const reads: number[] = [];
  const told: Array<[SetupListener, EngineSetup | null]> = [];
  const gone = new Set<string>();
  const f = createSetupFeed({
    read: async () => { reads.push(Date.now()); return now; },
    tell: async (listener, setup) => {
      told.push([listener, setup]);
      return !gone.has(listener === "pages" ? "pages" : `${listener.tabId}`);
    },
  });
  return { f, reads, told, set: (s: EngineSetup | null) => { now = s; }, leave: (key: string) => gone.add(key) };
}

describe("the download's progress, pushed", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("tells the popup and the panel every new figure, the same one, within one period", async () => {
    const t = feed(downloading(10));
    t.f.follow(panel, downloading(10));
    t.f.follow("pages", downloading(10));
    await vi.advanceTimersByTimeAsync(FOLLOW_MS);
    expect(t.told).toEqual([]); // nothing moved: nothing said
    t.set(downloading(11));
    await vi.advanceTimersByTimeAsync(FOLLOW_MS);
    expect(t.told).toEqual([[panel, downloading(11)], ["pages", downloading(11)]]);
    t.set(downloading(12));
    await vi.advanceTimersByTimeAsync(FOLLOW_MS);
    expect(t.told.slice(2)).toEqual([[panel, downloading(12)], ["pages", downloading(12)]]);
  });

  it("says once what came after the download, and then reads nothing more", async () => {
    const t = feed(downloading(99));
    t.f.follow(panel, downloading(99));
    t.set({ state: "loading", percent: 100 });
    await vi.advanceTimersByTimeAsync(FOLLOW_MS);
    expect(t.told).toEqual([[panel, { state: "loading", percent: 100 }]]);
    const reads = t.reads.length;
    await vi.advanceTimersByTimeAsync(FOLLOW_MS * 20);
    expect(t.reads.length).toBe(reads);
    expect(t.f.listeners()).toBe(0);
  });

  it("stops at a pause, and when the engine says nothing about setup", async () => {
    for (const after of [{ state: "paused", percent: 40 } as EngineSetup, null]) {
      const t = feed(downloading(40));
      t.f.follow("pages", downloading(40));
      t.set(after);
      await vi.advanceTimersByTimeAsync(FOLLOW_MS * 10);
      expect(t.told).toEqual([["pages", after]]);
      expect(t.reads.length).toBe(1);
    }
  });

  it("reads nothing when no download runs, or when nobody shows it", async () => {
    const t = feed({ state: "needed", percent: 0 });
    t.f.follow(panel, { state: "needed", percent: 0 });
    t.f.follow("pages", { state: "paused", percent: 3 });
    t.f.follow(panel, null);
    t.f.follow(panel, undefined);
    await vi.advanceTimersByTimeAsync(FOLLOW_MS * 20);
    expect(t.reads).toEqual([]);
    expect(t.told).toEqual([]);
  });

  it("drops a listener that no longer shows the download, a closed tab, and stops with the last", async () => {
    const t = feed(downloading(1));
    t.f.follow(panel, downloading(1));
    t.f.follow({ tabId: 8, frameId: 0 }, downloading(1));
    t.f.follow("pages", downloading(1));
    t.leave("pages");
    t.set(downloading(2));
    await vi.advanceTimersByTimeAsync(FOLLOW_MS);
    expect(t.f.listeners()).toBe(2);
    t.f.forget(8);
    t.leave("7");
    t.set(downloading(3));
    await vi.advanceTimersByTimeAsync(FOLLOW_MS);
    expect(t.f.listeners()).toBe(0);
    const reads = t.reads.length;
    await vi.advanceTimersByTimeAsync(FOLLOW_MS * 20);
    expect(t.reads.length).toBe(reads);
  });

  it("asks one listener again once, however often it asks, and reads one at a time", async () => {
    const t = feed(downloading(5));
    for (let i = 0; i < 5; i++) t.f.follow(panel, downloading(5));
    await vi.advanceTimersByTimeAsync(FOLLOW_MS * 4);
    expect(t.f.listeners()).toBe(1);
    expect(t.reads.length).toBe(4);
  });
});
