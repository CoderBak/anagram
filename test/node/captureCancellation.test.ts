import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import type { ScoreBatchRequest } from "../../lib/contract";
import type { Unit, Lane } from "../../lib/types";
import type { ScoreCache } from "../../lib/capture/cache";
import type { UnitVerdict } from "../../lib/capture/windows";
import { createOrchestrator } from "../../lib/capture/orchestrator";
import { deferred } from "./scoreStore";

const calls = vi.hoisted(() => ({
  detect: vi.fn(), request: vi.fn(), remove: vi.fn(), main: vi.fn(),
  message: vi.fn(), cancel: vi.fn(), reobserve: vi.fn(),
  scope: "page" as "page" | "main", session: "first", units: [] as Unit[],
  caches: [] as ScoreCache[],
  sends: [] as ((units: Unit[], lane: Lane) => Promise<UnitVerdict[]>)[],
  reports: [] as (() => Promise<string>)[],
}));
vi.mock("../../lib/capture/langGate", async (original) => ({
  ...await original<typeof import("../../lib/capture/langGate")>(), detectUnsupported: calls.detect,
}));
vi.mock("../../lib/messaging/client", () => ({
  requestScores: calls.request, contextAlive: () => true,
  requestTokenCounts: async (texts: string[]) => ({ backend: "up", counts: { alone: texts.map((t) => Math.ceil(t.length / 4)), following: texts.map((t) => Math.ceil((t.length + 1) / 4)) } }),
}));
vi.mock("../../lib/access/session", () => ({
  sendDocumentMessage: calls.message, cancelDocumentSession: calls.cancel, documentSessionId: () => calls.session,
}));
vi.mock("../../lib/capture/cache", async (original) => {
  const actual = await original<typeof import("../../lib/capture/cache")>();
  return { ...actual, createScoreCache: () => {
    const cache = actual.createScoreCache(); calls.caches.push(cache); return cache;
  } };
});
vi.mock("../../lib/capture/scheduler", () => ({createScheduler: (options: {send: typeof calls.sends[number]}) => {
  calls.sends.push(options.send);
  return {enqueue() {}, bumpEpoch() {}, stop() {}, pause() {}, resume() {}, pendingCount: () => 0};
}}));
vi.mock("../../lib/capture/observers", () => ({createObservers: () => ({
  start() {}, stop() {}, observeUnit() {}, observeRoot() {}, dropUnit() {}, reobserve: calls.reobserve,
})}));
vi.mock("../../lib/render/badge", () => ({createBadgeLayer: () => ({
  remove: calls.remove, teardownAll() {}, resetTheme() {},
})}));
vi.mock("../../lib/render/fab", () => ({createFab: (options: {panel: {buildReport: () => Promise<string>}}) => {
  calls.reports.push(options.panel.buildReport);
  return {setCount() {}, setBackendDown() {}, unmount() {}, mount() {}, setActive() {}};
}}));
vi.mock("../../lib/render/highlight", () => ({
  setHighlight() {}, clearHighlight() {}, registerHighlightStyles() {}, setHighlightsVisible() {},
  refreshHighlightTheme() {},
}));
vi.mock("../../lib/dom/walker", () => ({collectUnits: () => calls.units, inPageOrder: (units: Unit[]) => [...units]}));
vi.mock("../../lib/dom/mainContent", () => ({findMainContent: calls.main, useReadability() {}}));
vi.mock("../../lib/lazy", () => ({loadReadability: async () => ({})}));
vi.mock("../../lib/settings/settings", () => {
  const setting = (value: unknown) => ({getValue: async () => value, watch: () => () => {}});
  return {settings: {
    debug: setting(false),
    showHighlights: setting(false), displayMode: setting("all"), mergeShorts: setting(true),
    analysisScope: {getValue: async () => calls.scope, watch: () => () => {}},
    reportIncludeText: setting(false), reportIncludeUrl: setting(false),
  }};
});

const MODEL = {id: "model", ver: "1", calibration: "none"};
const text = "This paragraph has enough words for the real window planner to ask for a verdict about its text. ".repeat(3);
const unit = {id: "unit", text, order: 0} as Unit;
beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({manifest_version: 3, version: "0.4.1", name: "Anagram"});
  vi.clearAllMocks(); calls.caches.length = 0; calls.sends.length = 0; calls.reports.length = 0;
  calls.detect.mockReset(); calls.request.mockReset(); calls.main.mockReset();
  calls.detect.mockResolvedValue(null); calls.main.mockReturnValue(null); calls.scope = "page";
  calls.message.mockReset(); calls.message.mockResolvedValue(undefined);
  calls.session = "first"; calls.units = [];
  calls.request.mockImplementation(async (req: ScoreBatchRequest) => ({backend: "up", model: MODEL, results: req.blocks.map((block) => ({
    id: block.id, bucket: 3, score: 1, probs: [0, 0, 0, 1],
  }))}));
  vi.stubGlobal("location", {hostname: "example.test", href: "https://example.test/article"});
  const window = Object.assign(new EventTarget(), {
    navigation: new EventTarget(), requestIdleCallback: (run: () => void) => {queueMicrotask(run); return 1;},
  });
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", Object.assign(new EventTarget(), {body: {}, querySelector: () => null, visibilityState: "visible"}));
});
afterEach(() => {vi.unstubAllGlobals();});

async function page() {
  const controller = createOrchestrator(null, {mountFab: false});
  controller.start();
  // Settings resolve before the real orchestrator completes its first empty collect.
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return {controller, send: calls.sends[0], cache: calls.caches[0]};
}

describe("capture cancellation across language detection and replies", () => {
  it.each([null, {lang: "zh", prob: .99}])("clear retires a delayed language gate (%j)", async (language) => {
    const gate = deferred<typeof language>(); calls.detect.mockReturnValueOnce(gate.promise);
    const {controller, send, cache} = await page();
    try {
      const old = send([unit], "viewport");
      controller.forgetCached(); gate.resolve(language);
      expect(await old).toEqual([]);
      expect(calls.request).not.toHaveBeenCalled(); expect(cache.size()).toBe(0);
      expect(await send([unit], "viewport")).toHaveLength(1);
      expect(calls.request).toHaveBeenCalledTimes(1); expect(cache.size()).toBe(1);
    } finally {controller.stop();}
  });

  it("clear rejects a late successful score and its truncation follow-up", async () => {
    const reply = deferred<unknown>(), sent = deferred<ScoreBatchRequest>();
    calls.request.mockImplementationOnce((req: ScoreBatchRequest) => {sent.resolve(req); return reply.promise;});
    const {controller, send, cache} = await page();
    try {
      const old = send([unit], "viewport"), req = await sent.promise;
      controller.forgetCached();
      reply.resolve({backend: "up", model: MODEL, results: req.blocks.map((block) => ({
        id: block.id, bucket: 3, score: 1, probs: [0, 0, 0, 1], truncated: true,
      }))});
      expect(await old).toEqual([]); expect(cache.size()).toBe(0);
      expect(calls.request).toHaveBeenCalledTimes(1);
    } finally {controller.stop();}
  });

  it.each(["stop", "rescan"] as const)("%s retires pre-existing work", async (action) => {
    const gate = deferred<null>(); calls.detect.mockReturnValueOnce(gate.promise);
    const {controller, send, cache} = await page();
    try {
      const old = send([unit], "viewport"); controller[action](); gate.resolve(null);
      expect(await old).toEqual([]); expect(cache.size()).toBe(0);
      expect(calls.request).not.toHaveBeenCalled();
    } finally {controller.stop();}
  });

  it("reports the producer carried by the batch reply", async () => {
    const {controller, send} = await page();
    try {
      expect(await send([unit], "viewport")).toHaveLength(1);
      const report = await calls.reports[0]();
      expect(report).toContain("model");
    } finally {controller.stop();}
  });

  it("drops the old scan when this reply changes model", async () => {
    const {controller, send, cache} = await page();
    try {
      await send([unit], "viewport"); expect(cache.size()).toBe(1);
      const next = {...unit, id: "next", text: text + "New evidence from another paragraph."};
      calls.request.mockImplementationOnce(async (req: ScoreBatchRequest) => ({backend: "up",
        model: {id: "replacement-model", ver: "2", calibration: "new"},
        results: req.blocks.map((block) => ({id: block.id, bucket: 3, score: 1, probs: [0, 0, 0, 1]})),
      }));
      expect(await send([next], "viewport")).toEqual([]);
      expect(cache.size()).toBe(0);
      expect(await calls.reports[0]()).toContain("replacement-model");
    } finally {controller.stop();}
  });
  it("keeps a virtual document coverage limit in reports even when source metadata is private", async () => {
    const {controller: original} = await page();
    const controller = createOrchestrator(null, {reportScopeNote: () => "PDF scope: 2 of 30 rendered pages; incomplete document."});
    try {
      const report = await calls.reports.at(-1)!();
      expect(report).toContain("PDF scope: 2 of 30 rendered pages; incomplete document.");
      expect(report).not.toContain("https://");
    } finally {controller.stop(); original.stop();}
  });

});

describe("work abandoned by stop, rescan and a cleared cache", () => {
  const settle = async () => {for (let i = 0; i < 10; i++) await Promise.resolve();};
  const badged = (flagged: number) => ({action: "updateBadge", flagged});

  it("stop has the worker drop this run's batches, once the toolbar count is cleared", async () => {
    const badge = deferred<undefined>();
    calls.message.mockImplementation((m: {action: string}) => m.action === "updateBadge" ? badge.promise : Promise.resolve(undefined));
    const controller = createOrchestrator(null);
    controller.start(); await settle();
    controller.stop(); await settle();
    // A page analyzed on a one-off grant is authorized by the session it has: the count
    // has to reach the worker over that one.
    expect(calls.message).toHaveBeenCalledWith(badged(0));
    expect(calls.cancel).not.toHaveBeenCalled();
    badge.resolve(undefined); await settle();
    expect(calls.cancel).toHaveBeenCalledOnce();
  });

  it.each(["restarted", "replaced"] as const)("stop leaves a session alone that is in use again (%s)", async (how) => {
    const badge = deferred<undefined>();
    calls.message.mockImplementation((m: {action: string}) => m.action === "updateBadge" ? badge.promise : Promise.resolve(undefined));
    const controller = createOrchestrator(null);
    try {
      controller.start(); await settle();
      controller.stop();
      if (how === "restarted") controller.start(); else calls.session = "second";
      badge.resolve(undefined); await settle();
      expect(calls.cancel).not.toHaveBeenCalled();
    } finally {controller.stop();}
  });

  it("rescan keeps the session, so what it asks for again joins the batches the worker is running", async () => {
    const {controller} = await page();
    try {
      controller.rescan(); await settle();
      expect(calls.cancel).not.toHaveBeenCalled();
    } finally {controller.stop();}
  });

  it("a cleared cache puts the units of an abandoned batch back before the observers", async () => {
    const live = {id: "live", text, order: 0, parts: [], isScored: false} as unknown as Unit;
    calls.units = [live];
    const gate = deferred<null>(); calls.detect.mockReturnValueOnce(gate.promise);
    const {controller, send} = await page();
    try {
      const old = send([live], "viewport");
      controller.forgetCached(); gate.resolve(null);
      expect(await old).toEqual([]);
      // The one-shot viewport dispatch was spent on this batch: without a second placement
      // an on-screen paragraph waits for the idle prefetch's background lane.
      expect(calls.reobserve).toHaveBeenCalledWith(live);
      expect(calls.cancel).not.toHaveBeenCalled();
    } finally {controller.stop();}
  });

  it("a stopped run puts nothing back", async () => {
    const live = {id: "live", text, order: 0, parts: [], isScored: false} as unknown as Unit;
    calls.units = [live];
    const gate = deferred<null>(); calls.detect.mockReturnValueOnce(gate.promise);
    const {controller, send} = await page();
    const old = send([live], "viewport");
    controller.stop(); gate.resolve(null);
    expect(await old).toEqual([]);
    expect(calls.reobserve).not.toHaveBeenCalled();
  });
});

describe("requests the worker turns down", () => {
  it("makes a refused unit Unavailable instead of leaving it to be asked for again", async () => {
    calls.request.mockResolvedValue({results: [], backend: "refused"});
    const {controller, send, cache} = await page();
    try {
      const [verdict] = await send([unit], "viewport");
      expect(verdict?.result.degraded).toBe(true);
      expect(cache.size()).toBe(0);
    } finally {controller.stop();}
  });

  it("never sends a request past the worker's caps, even for a unit NFKC made longer", async () => {
    // Some 190 000 characters in over a hundred windows, each two thirds longer once "ﬃ"
    // becomes "ffi": far past the 256 000 characters the worker takes in one request.
    const text = Array.from({length: 22_000}, (_, i) => `ﬃﬃﬃ${i}`).join(" ");
    const long = {id: "long", text, order: 1} as Unit;
    const sizes: {blocks: number; chars: number}[] = [];
    calls.request.mockImplementation(async (req: ScoreBatchRequest) => {
      const size = {blocks: req.blocks.length, chars: req.blocks.reduce((n, b) => n + b.text.length, 0)};
      sizes.push(size);
      // What lib/access/messages.ts answers to anything larger.
      if (size.blocks > 256 || size.chars > 256_000) return {results: [], backend: "refused"};
      return {backend: "up", model: MODEL, results: req.blocks.map((block) => ({id: block.id, bucket: 3, score: 1, probs: [0, 0, 0, 1]}))};
    });
    const {controller, send} = await page();
    try {
      const [verdict] = await send([long], "background");
      expect(verdict?.result.degraded).toBeUndefined();
      expect(verdict?.windows.length).toBeGreaterThan(100);
      expect(sizes.reduce((n, s) => n + s.chars, 0)).toBeGreaterThan(256_000);
      expect(sizes.every((s) => s.blocks <= 256 && s.chars <= 256_000)).toBe(true);
    } finally {controller.stop();}
  });
});

describe("same-document URL changes under the main-content scope", () => {
  it("looks for the main region again only when a route change is collected again", async () => {
    vi.useFakeTimers();
    calls.scope = "main";
    const region = {isConnected: true};
    calls.main.mockReturnValue(region);
    const {controller} = await page();
    const navigation = (window as unknown as {navigation: EventTarget}).navigation;
    const go = (href: string, navigationType: string) => {
      location.href = href;
      navigation.dispatchEvent(Object.assign(new Event("currententrychange"), {navigationType}));
    };
    try {
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const booted = calls.main.mock.calls.length;
      expect(booted).toBeGreaterThan(0);
      // Discourse rewrites the address on every scroll step: nothing to collect, nothing to find.
      for (let i = 0; i < 20; i++) go(`https://example.test/article?post=${i}`, "replace");
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.main).toHaveBeenCalledTimes(booted);
      // A pushed entry, and the router correcting it, are one refresh and one search.
      go("https://example.test/next", "push");
      for (let i = 0; i < 3; i++) go(`https://example.test/next?t=${i}`, "replace");
      expect(calls.main).toHaveBeenCalledTimes(booted);
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.main).toHaveBeenCalledTimes(booted + 1);
      // A rewrite that took the region with it is a route change after all.
      region.isConnected = false;
      calls.main.mockReturnValue({isConnected: true});
      go("https://example.test/next?t=9", "replace");
      await vi.advanceTimersByTimeAsync(1000);
      expect(calls.main).toHaveBeenCalledTimes(booted + 2);
    } finally {controller.stop(); vi.useRealTimers();}
  });
});
