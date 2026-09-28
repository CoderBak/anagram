// test/node/warmup.test.ts — the in-browser engine warmed where it will be needed (lib/backend/warmup.ts).
import { describe, expect, it } from "vitest";
import { createWarmup, type Navigation, type WarmupOptions } from "../../lib/backend/warmup";

type Active = "server" | "idle" | "loading" | "down";

/** A background whose answers the test sets, counting what it asked the engine. */
function background(over: Partial<{ engine: "native" | "inbrowser" | null; reads: boolean; inFront: boolean; known: Active; running: boolean; says: Active }> = {}) {
  const facts = { engine: "inbrowser" as "native" | "inbrowser" | null, reads: true, inFront: true, known: "idle" as Active, running: true, says: "idle" as Active, ...over };
  const warmed: number[] = [];
  const asked: number[] = [];
  const options: WarmupOptions = {
    engine: async () => facts.engine,
    reads: async () => facts.reads,
    inFront: async () => facts.inFront,
    known: () => facts.known,
    running: async () => facts.running,
    ask: async () => { asked.push(Date.now()); return facts.says; },
    warm: async () => { warmed.push(Date.now()); },
  };
  return { navigated: createWarmup(options), warmed, asked };
}
const page: Navigation = { tabId: 3, frameId: 0, url: "https://example.org/essay", documentLifecycle: "active" };

describe("warming the in-browser engine", () => {
  it("warms an engine known idle, or thought loaded, when the tab in front opens a page Anagram reads, without asking it first", async () => {
    for (const known of ["idle", "server"] as const) {
      const b = background({ known });
      expect(await b.navigated(page)).toBe(true);
      expect(b.warmed).toHaveLength(1);
      expect(b.asked).toEqual([]);
    }
    expect(await background().navigated({ ...page, url: "http://localhost:8080/a.html", documentLifecycle: undefined })).toBe(true);
  });

  it("asks a running engine the background has not heard from since it woke, and warms it when idle", async () => {
    const idle = background({ known: "down", says: "idle" });
    expect(await idle.navigated(page)).toBe(true);
    expect([idle.asked.length, idle.warmed.length]).toEqual([1, 1]);
    const downloading = background({ known: "down", says: "down" });
    expect(await downloading.navigated(page)).toBe(false);
    expect([downloading.asked.length, downloading.warmed.length]).toEqual([1, 0]);
  });

  it("never asks, so never starts, an engine that is not running: one the browser closed mid-download would carry on", async () => {
    const b = background({ known: "down", running: false });
    expect(await b.navigated(page)).toBe(false);
    expect(b.asked).toEqual([]);
    expect(b.warmed).toEqual([]);
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
      expect([b.asked.length, b.warmed.length], why).toEqual([0, 0]);
    }
  });

  it("leaves the local engine, no engine, and one loading or known down and not running, as they are", async () => {
    for (const b of [background({ engine: "native" }), background({ engine: null }), background({ known: "loading", says: "loading" }), background({ known: "down", running: false })]) {
      expect(await b.navigated(page)).toBe(false);
      expect(b.warmed).toEqual([]);
    }
  });

  it("never throws", async () => {
    const base = { reads: async () => true, inFront: async () => true, known: () => "idle" as const, running: async () => true, ask: async () => "idle" as const };
    expect(await createWarmup({ ...base, engine: async () => { throw new Error("gone"); }, warm: async () => undefined })(page)).toBe(false);
    expect(await createWarmup({ ...base, engine: async () => "inbrowser", warm: async () => { throw new Error("port closed"); } })(page)).toBe(false);
  });
});
