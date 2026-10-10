// A page paused because the engine was down, and what its probe hears next: an engine up,
// or loading its model (the in-browser engine's, which holds what it is sent until the
// model is in), puts the page's queue back to work; one that is still down does not.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { ScoreBatchRequest } from "../../lib/contract";
import type { BackendStatus } from "../../lib/messaging/protocol";
import type { Unit, Lane } from "../../lib/types";
import type { UnitVerdict } from "../../lib/capture/windows";
import { createOrchestrator } from "../../lib/capture/orchestrator";

const calls = vi.hoisted(() => ({
  request: vi.fn(), message: vi.fn(), pause: vi.fn(), resume: vi.fn(),
  sends: [] as ((units: Unit[], lane: Lane) => Promise<UnitVerdict[]>)[],
}));
vi.mock("../../lib/capture/langGate", async (original) => ({
  ...await original<typeof import("../../lib/capture/langGate")>(), detectUnsupported: async () => null,
}));
vi.mock("../../lib/messaging/client", () => ({
  requestScores: calls.request, contextAlive: () => true,
  requestTokenCounts: async (texts: string[]) => ({ backend: "up", counts: { alone: texts.map((t) => Math.ceil(t.length / 4)), following: texts.map((t) => Math.ceil((t.length + 1) / 4)) } }),
}));
vi.mock("../../lib/access/session", () => ({
  sendDocumentMessage: calls.message, cancelDocumentSession: vi.fn(), documentSessionId: () => "session",
}));
vi.mock("../../lib/capture/scheduler", () => ({createScheduler: (options: {send: typeof calls.sends[number]}) => {
  calls.sends.push(options.send);
  return {enqueue() {}, bumpEpoch() {}, stop() {}, pause: calls.pause, resume: calls.resume, pendingCount: () => 0};
}}));
vi.mock("../../lib/capture/observers", () => ({PLACE_WAIT_MS: 1000, createObservers: () => ({
  start() {}, stop() {}, observeUnit() {}, observeRoot() {}, dropUnit() {}, reobserve() {}, placed: () => true,
})}));
vi.mock("../../lib/render/badge", () => ({createBadgeLayer: () => ({remove() {}, teardownAll() {}, resetTheme() {}})}));
vi.mock("../../lib/render/highlight", () => ({
  setHighlight() {}, clearHighlight() {}, registerHighlightStyles() {}, setHighlightsVisible() {}, refreshHighlightTheme() {},
}));
vi.mock("../../lib/dom/walker", () => ({collectUnits: () => [], collectUnitsInSlices: function* () { return []; }, inPageOrder: (units: Unit[]) => [...units]}));
vi.mock("../../lib/settings/settings", () => {
  const setting = (value: unknown) => ({getValue: async () => value, watch: () => () => {}});
  return {settings: {
    debug: setting(false), showHighlights: setting(false), displayMode: setting("all"), mergeShorts: setting(true),
  }};
});

const text = "This paragraph has enough words for the real window planner to ask for a verdict about its text. ".repeat(3);
const unit = {id: "unit", text, order: 0} as Unit;
const settle = async () => {for (let i = 0; i < 20; i++) await Promise.resolve();};
/** What the worker says of each engine (entrypoints/background.ts, lib/backend/nativeScoreClient.ts). */
const STATUS: Record<string, BackendStatus> = {
  loading: {active: "loading", model: null, server: {ok: false, checkedAt: 1, reason: "unreachable", code: "engine_loading"}, setup: {state: "loading", percent: 100}},
  // The local engine loading its model, or any engine not there.
  down: {active: "down", model: null, server: {ok: false, checkedAt: 1, reason: "unreachable", code: "not_ready"}},
};

beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({manifest_version: 3, version: "0.4.1", name: "Anagram"});
  vi.clearAllMocks(); calls.sends.length = 0;
  vi.useFakeTimers({toFake: ["setInterval", "clearInterval"]});
  // The engine is down: the batch comes back Unavailable and the page pauses.
  calls.request.mockImplementation(async (req: ScoreBatchRequest) => ({backend: "down", results: req.blocks.map((block) => ({
    id: block.id, bucket: 0, score: 0, probs: [0.25, 0.25, 0.25, 0.25], degraded: true,
  }))}));
  calls.message.mockResolvedValue(undefined);
  vi.stubGlobal("location", {hostname: "example.test", href: "https://example.test/article"});
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    navigation: new EventTarget(), requestIdleCallback: (run: () => void) => {queueMicrotask(run); return 1;},
  }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), {body: {}, querySelector: () => null, querySelectorAll: () => [], visibilityState: "visible"}));
});
afterEach(() => {vi.useRealTimers(); vi.unstubAllGlobals();});

/** A page whose batch met a down engine, and what its next probe hears: `status`. */
async function pausedPage(status: BackendStatus) {
  const controller = createOrchestrator(null, {toolbarOwner: false});
  controller.start(); await settle();
  await calls.sends[0]!([unit], "viewport");
  expect(calls.pause).toHaveBeenCalled();
  calls.pause.mockClear(); calls.resume.mockClear();
  calls.message.mockImplementation(async (m: {action: string}) => m.action === "getBackendStatus" ? status : undefined);
  // The page's own recheck of a down engine, every five seconds.
  await vi.advanceTimersByTimeAsync(5000); await settle();
  expect(calls.message).toHaveBeenCalledWith({action: "getBackendStatus", probe: false});
  return controller;
}

describe("a page paused while the engine was down", () => {
  it("goes on as soon as the engine is loading its model, and stops polling", async () => {
    const controller = await pausedPage(STATUS.loading!);
    try {
      expect(calls.resume).toHaveBeenCalled();
      // Back: the page stops asking.
      calls.message.mockClear();
      await vi.advanceTimersByTimeAsync(15_000); await settle();
      expect(calls.message).not.toHaveBeenCalledWith({action: "getBackendStatus", probe: false});
    } finally {controller.stop();}
  });

  it("stays paused while the engine is down, which is what the local engine says while it loads", async () => {
    const controller = await pausedPage(STATUS.down!);
    try {
      expect(calls.resume).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5000); await settle();
      expect(calls.resume).not.toHaveBeenCalled();
      // Once as it went down (the first probe follows the failed batch), then every five seconds
      // (besides the one at start, which asks where the engine scores).
      expect(calls.message.mock.calls.filter(([m]) => m.action === "getBackendStatus" && "probe" in m)).toHaveLength(3);
    } finally {controller.stop();}
  });
});
