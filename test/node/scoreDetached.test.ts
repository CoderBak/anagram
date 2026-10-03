// test/node/scoreDetached.test.ts — paragraphs read with no DOM (Orchestrator.scoreDetached):
// the PDF reader's whole-document reading. Their verdicts go to the score cache, so the unit
// a paragraph becomes when its page is drawn costs no request, and to the kept ledger, so the
// report counts them meanwhile. The harness is captureCancellation's: the orchestrator's real
// cache, windows and report over a mocked worker, scheduler, observers and chips; the last
// case puts the PDF reader's real unit source (lib/pdf/units.ts) under it, on a linkedom page.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { parseHTML } from "linkedom";
import type { ScoreBatchRequest } from "../../lib/contract";
import type { Unit, Lane } from "../../lib/types";
import type { ScoreCache } from "../../lib/capture/cache";
import type { UnitVerdict } from "../../lib/capture/windows";
import { createOrchestrator, type DetachedParagraph, type OrchestratorOptions } from "../../lib/capture/orchestrator";
import { createPdfUnitSource } from "../../lib/pdf/units";
import type { ReflowBlock } from "../../lib/pdf/reflow";
import { deferred } from "./scoreStore";

const calls = vi.hoisted(() => ({
  detect: vi.fn(), request: vi.fn(), message: vi.fn(), cancel: vi.fn(),
  session: "first", units: [] as Unit[], pending: 0,
  caches: [] as ScoreCache[],
  sends: [] as ((units: Unit[], lane: Lane) => Promise<UnitVerdict[]>)[],
  renders: [] as ((verdicts: UnitVerdict[], epoch: number) => void)[],
  budgets: [] as unknown[],
  enqueued: [] as [string, Lane][],
  observerOptions: null as {onPlaced?: () => void} | null,
  placed: (_unit: Unit): boolean => true,
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
vi.mock("../../lib/capture/scheduler", () => ({createScheduler: (options: {send: typeof calls.sends[number]; render: typeof calls.renders[number]; batchCharBudget: unknown}) => {
  calls.sends.push(options.send); calls.renders.push(options.render); calls.budgets.push(options.batchCharBudget);
  return {enqueue: (unit: Unit, lane: Lane) => calls.enqueued.push([unit.id, lane]), requeue() {}, bumpEpoch() {}, stop() {}, pause() {}, resume() {}, pendingCount: () => calls.pending};
}}));
vi.mock("../../lib/capture/observers", () => ({createObservers: (options: {onPlaced?: () => void}) => (calls.observerOptions = options, {
  start() {}, stop() {}, observeUnit() {}, observeRoot() {}, dropUnit() {}, reobserve() {}, placed: (unit: Unit) => calls.placed(unit),
})}));
vi.mock("../../lib/render/badge", () => ({createBadgeLayer: () => ({
  remove() {}, teardownAll() {}, resetTheme() {}, renderPending() {}, render() {}, placed: () => true, setVisible() {}, flash() {},
})}));
vi.mock("../../lib/render/highlight", () => ({
  setHighlight() {}, clearHighlight() {}, registerHighlightStyles() {}, setHighlightsVisible() {},
  refreshHighlightTheme() {},
}));
vi.mock("../../lib/dom/walker", () => ({collectUnits: () => calls.units, inPageOrder: (units: Unit[]) => [...units]}));
vi.mock("../../lib/settings/settings", () => {
  const setting = (value: unknown) => ({getValue: async () => value, watch: () => () => {}});
  return {settings: {
    debug: setting(false),
    showHighlights: setting(false), displayMode: setting("all"), mergeShorts: setting(true), minWords: setting(75),
  }};
});

const MODEL = {id: "model", ver: "1", calibration: "none"};
/** A paragraph of `tag`: "HUMAN" ones are scored human, every other one AI-generated. */
const text = (tag: string) => `${tag} This paragraph has enough words for the real window planner to ask for a verdict about its text. `.repeat(3).trim();
const detached = (tag: string, page: number, order: number): DetachedParagraph => ({page, order, text: text(tag), wordCount: 60});
const nothing = {ms: 0, sent: 0, chars: 0, scored: 0, retired: false};

let doc: EventTarget & {visibilityState: string};
beforeEach(() => {
  fakeBrowser.reset();
  vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue({manifest_version: 3, version: "0.4.1", name: "Anagram"});
  vi.clearAllMocks(); calls.caches.length = 0; calls.sends.length = 0; calls.renders.length = 0; calls.budgets.length = 0;
  calls.detect.mockReset(); calls.request.mockReset();
  calls.detect.mockResolvedValue(null);
  calls.message.mockReset(); calls.message.mockResolvedValue(undefined);
  calls.session = "first"; calls.units = []; calls.pending = 0; calls.enqueued.length = 0; calls.placed = () => true;
  calls.request.mockImplementation(async (req: ScoreBatchRequest) => ({backend: "up", model: MODEL, results: req.blocks.map((block) => (
    block.text.startsWith("HUMAN")
      ? {id: block.id, bucket: 0, score: 0, probs: [1, 0, 0, 0]}
      : {id: block.id, bucket: 3, score: 1, probs: [0, 0, 0, 1]}
  ))}));
  vi.stubGlobal("location", {hostname: "example.test", href: "https://example.test/reader"});
  const window = Object.assign(new EventTarget(), {
    navigation: new EventTarget(), requestIdleCallback: (run: () => void) => {queueMicrotask(run); return 1;},
  });
  vi.stubGlobal("window", window);
  doc = Object.assign(new EventTarget(), {body: {}, querySelector: () => null, querySelectorAll: () => [], visibilityState: "visible"});
  vi.stubGlobal("document", doc);
});
afterEach(() => {vi.unstubAllGlobals();});

const settle = async () => {for (let i = 0; i < 10; i++) await Promise.resolve();};

async function reader(options: OrchestratorOptions = {}) {
  const controller = createOrchestrator(null, {toolbarOwner: false, ...options});
  controller.start();
  await settle();
  return {controller, cache: calls.caches[0]!};
}

describe("scoreDetached", () => {
  it("reads paragraphs with no DOM in the background lane and keeps their verdicts, counted and listed by page", async () => {
    const revealPage = vi.fn();
    const {controller, cache} = await reader({reportScopeNote: (pages) => `pages read: ${pages}`, revealPage});
    try {
      const items = [detached("FAR", 9, 30), detached("HUMAN", 4, 12), detached("NEAR", 3, 8)];
      const cost = await controller.scoreDetached(items);
      expect(cost).toMatchObject({sent: 3, chars: items.reduce((n, p) => n + p.text.length, 0), scored: 3, retired: false});
      expect(cost.ms).toBeGreaterThanOrEqual(0);
      expect(calls.request).toHaveBeenCalledTimes(1);
      expect((calls.request.mock.calls[0]![0] as ScoreBatchRequest).priority).toBe("background");
      expect(cache.size()).toBe(3);
      for (const p of items) {
        expect(controller.knows(p.text)).toBe(true);
        expect(controller.onScreen(p.text)).toBe(false);
      }
      const report = controller.pageReport();
      expect(report.counts).toMatchObject({read: 3, bands: [1, 0, 0, 2], pending: 0, unavailable: 0});
      expect(report.scopeNote).toBe("pages read: 3");
      // The flagged ones, by page: the paragraph on page 3 before the one on page 9.
      expect(report.entries.map((e) => e.snippet.split(" ")[0])).toEqual(["NEAR", "FAR"]);
      expect(report.entries.every((e) => e.id.startsWith("k"))).toBe(true);
      // The list goes to a paragraph whose page is not drawn by asking the reader for the page.
      expect(controller.jumpToResult(report.documentId, report.entries[1]!.id)).toBe(true);
      expect(revealPage).toHaveBeenCalledWith(9);
    } finally {controller.stop();}
  });

  it("asks nothing twice: a paragraph read once is a cache hit, costs the engine nothing, and is counted once", async () => {
    const {controller} = await reader();
    try {
      const items = [detached("ONE", 2, 1), detached("TWO", 2, 2)];
      await controller.scoreDetached(items);
      const again = await controller.scoreDetached(items);
      expect(again).toMatchObject({sent: 0, chars: 0, scored: 2, retired: false});
      expect(calls.request).toHaveBeenCalledTimes(1);
      expect(controller.pageReport().counts.read).toBe(2);
    } finally {controller.stop();}
  });

  it("does not count what the language gate settles as the engine's work", async () => {
    const chinese = detached("ZH", 2, 1), english = detached("EN", 2, 2);
    calls.detect.mockImplementation(async (t: string) => (t === chinese.text ? {lang: "zh", prob: 0.99} : null));
    const {controller} = await reader();
    try {
      const cost = await controller.scoreDetached([chinese, english]);
      expect(cost).toMatchObject({sent: 1, chars: english.text.length, scored: 2});
      expect((calls.request.mock.calls[0]![0] as ScoreBatchRequest).blocks.map((b) => b.text)).toEqual([english.text]);
      expect(controller.pageReport().counts).toMatchObject({read: 1, notEnglish: 1});
    } finally {controller.stop();}
  });

  it("does not count what the service worker answered from its cache as the engine's work", async () => {
    calls.request.mockImplementation(async (req: ScoreBatchRequest) => ({backend: "up", model: MODEL,
      results: req.blocks.map((block) => ({id: block.id, bucket: 3, score: 1, probs: [0, 0, 0, 1], cached: true}))}));
    const {controller} = await reader();
    try {
      const cost = await controller.scoreDetached([detached("REOPENED", 2, 1), detached("AGAIN", 2, 2)]);
      expect(cost).toMatchObject({sent: 0, chars: 0, scored: 2, down: false});
      expect(calls.request).toHaveBeenCalledTimes(1);
    } finally {controller.stop();}
  });

  it("says the engine was down when the batch came back, so that what it failed is not held against the text", async () => {
    calls.request.mockResolvedValue({results: [], backend: "down"});
    const {controller} = await reader();
    try {
      const p = detached("OUTAGE", 2, 0);
      expect(await controller.scoreDetached([p])).toMatchObject({scored: 0, retired: false, down: true});
      expect(controller.knows(p.text)).toBe(false);
    } finally {controller.stop();}
  });

  it("is what the unit finds in the cache when its page is drawn: no request for it", async () => {
    const {controller} = await reader();
    try {
      const p = detached("DRAWN", 5, 3);
      await controller.scoreDetached([p]);
      expect(calls.request).toHaveBeenCalledTimes(1);
      const unit = {id: "u5", text: p.text, wordCount: p.wordCount, order: p.order, page: p.page, parts: [], isScored: false} as unknown as Unit;
      const [verdict] = await calls.sends[0]!([unit], "viewport");
      expect(verdict?.result.score).toBe(1);
      expect(calls.request).toHaveBeenCalledTimes(1);
    } finally {controller.stop();}
  });

  it("does not count a kept verdict beside a live unit with the same text", async () => {
    const p = detached("LIVE", 1, 0);
    calls.units = [{id: "live", text: p.text, wordCount: p.wordCount, order: 0, page: 1, parts: [], isScored: false} as unknown as Unit];
    const {controller} = await reader();
    try {
      expect(controller.onScreen(p.text)).toBe(true);
      expect(controller.knows(p.text)).toBe(false);
      await controller.scoreDetached([p]);
      expect(controller.knows(p.text)).toBe(true);
      // The live unit counts (it waits for its verdict here: the scheduler is mocked); the
      // kept one does not count a second time.
      expect(controller.pageReport().counts).toMatchObject({read: 0, pending: 1});
    } finally {controller.stop();}
  });

  it("counts and lists a kept verdict only while its text is one of the document's paragraphs now", async () => {
    let texts: Set<string> | null = null;
    const {controller} = await reader({documentTexts: () => texts});
    try {
      const old = detached("STALE", 2, 0), current = detached("CURRENT", 2, 1);
      await controller.scoreDetached([old, current]);
      expect(controller.pageReport().counts.read).toBe(2); // the reader knows no texts yet
      texts = new Set([current.text]);
      const report = controller.pageReport();
      expect(report.counts).toMatchObject({read: 1, bands: [0, 0, 0, 1]});
      expect(report.total).toBe(1);
      expect(report.entries.map((e) => e.snippet.split(" ")[0])).toEqual(["CURRENT"]);
      texts = new Set([old.text, current.text]);
      expect(controller.pageReport().counts.read).toBe(2);
    } finally {controller.stop();}
  });

  it("keeps no degraded verdict: the page asks again when it is drawn", async () => {
    calls.request.mockResolvedValue({results: [], backend: "refused"});
    const {controller} = await reader();
    try {
      const p = detached("REFUSED", 2, 0);
      const cost = await controller.scoreDetached([p]);
      expect(cost).toMatchObject({scored: 0, retired: false});
      expect(controller.knows(p.text)).toBe(false);
      expect(controller.pageReport().counts).toMatchObject({read: 0, unavailable: 0});
    } finally {controller.stop();}
  });

  it("keeps nothing a stop retired while it was out, and says it was retired", async () => {
    const reply = deferred<unknown>(), sent = deferred<ScoreBatchRequest>();
    calls.request.mockImplementationOnce((req: ScoreBatchRequest) => {sent.resolve(req); return reply.promise;});
    const {controller} = await reader();
    const p = detached("RETIRED", 2, 0);
    const out = controller.scoreDetached([p]);
    const req = await sent.promise;
    controller.stop();
    reply.resolve({backend: "up", model: MODEL, results: req.blocks.map((b) => ({id: b.id, bucket: 3, score: 1, probs: [0, 0, 0, 1]}))});
    expect(await out).toMatchObject({scored: 0, retired: true});
    expect(controller.knows(p.text)).toBe(false);
  });

  it("makes every lane's batch one unit while the reader says so, asked as the scheduler asks", async () => {
    let one = false;
    const {controller} = await reader({oneUnitBatches: () => one});
    try {
      const lanes = calls.budgets[0] as Record<Lane, () => number>;
      const now = () => ({viewport: lanes.viewport(), near: lanes.near(), background: lanes.background()});
      expect(now()).toEqual({viewport: 1, near: 4000, background: 6000});
      one = true;
      expect(now()).toEqual({viewport: 1, near: 1, background: 1});
    } finally {controller.stop();}
  });

  it("makes every batch one unit where the engine scores on the processor, as its status says, and not elsewhere", async () => {
    const device = (name: string | undefined) => calls.message.mockImplementation(async (msg: {action?: string}) =>
      msg?.action === "getBackendStatus" ? {active: "server", server: {ok: true, checkedAt: 0, device: name}} : undefined);
    const now = () => {
      const lanes = calls.budgets.at(-1) as Record<Lane, () => number>;
      return {viewport: lanes.viewport(), near: lanes.near(), background: lanes.background()};
    };
    for (const [name, expected] of [
      ["wasm", {viewport: 1, near: 1, background: 1}],
      ["cpu", {viewport: 1, near: 1, background: 1}],
      ["webgpu", {viewport: 1, near: 4000, background: 6000}],
      ["mps", {viewport: 1, near: 4000, background: 6000}],
      [undefined, {viewport: 1, near: 4000, background: 6000}],
    ] as const) {
      device(name);
      const {controller} = await reader();
      try {
        await settle();
        expect(now(), String(name)).toEqual(expected);
      } finally {controller.stop();}
    }
  });
});

describe("busy", () => {
  it("holds the background while the reader is not started", async () => {
    const controller = createOrchestrator(null, {toolbarOwner: false});
    expect(controller.busy()).toBe(true);
    expect(await controller.scoreDetached([detached("EARLY", 1, 0)])).toMatchObject(nothing);
    expect(calls.request).not.toHaveBeenCalled();
  });

  it("holds it while any of the page's own work waits or is out, its background lane included, and lets it go after", async () => {
    const {controller} = await reader();
    try {
      calls.pending = 1;
      expect(controller.busy()).toBe(true);
      expect(await controller.scoreDetached([detached("WAITS", 1, 0)])).toMatchObject(nothing);
      expect(calls.request).not.toHaveBeenCalled();
      calls.pending = 0;
      expect(controller.busy()).toBe(false);
      expect((await controller.scoreDetached([detached("WAITS", 1, 0)])).scored).toBe(1);
    } finally {controller.stop();}
  });

  it("holds it while the page is hidden, and lets it go when it is shown", async () => {
    const {controller} = await reader();
    try {
      doc.visibilityState = "hidden";
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(controller.busy()).toBe(true);
      expect(await controller.scoreDetached([detached("HIDDEN", 1, 0)])).toMatchObject(nothing);
      expect(calls.request).not.toHaveBeenCalled();
      doc.visibilityState = "visible";
      doc.dispatchEvent(new Event("visibilitychange"));
      expect(controller.busy()).toBe(false);
    } finally {controller.stop();}
  });

  it("sends nothing for an empty batch", async () => {
    const {controller} = await reader();
    try {
      expect(await controller.scoreDetached([])).toMatchObject(nothing);
      expect(calls.request).not.toHaveBeenCalled();
    } finally {controller.stop();}
  });
});

// A paragraph carried over a page, its first page drawn: its unit reads the whole paragraph as
// far as the reader has the text. When the next page is read ahead the text grows, and the
// drawn nodes do not change — no claim can tell. The unit is minted again with the new text,
// and the stale one, claimed by nobody, is retired by the refresh: one unit, counted once.
describe("a drawn paragraph whose text grows when the next page is read ahead", () => {
  const LINES = [
    "The first line of a paragraph that goes on over the page carries a dozen ordinary words or so",
    "and the second line carries as many again so that the part on this page alone is long enough",
    "to be read by itself under the floor of seventy-five words that the settings here ask for, and",
    "the fourth line closes the part that stands on the first page without ending the sentence it is",
  ];
  const REST = "in, which goes on at the top of the second page and ends there with a full stop.";

  it("is one unit under its new text, retired and minted again by a refresh, and its verdict counted once", async () => {
    const { document: page } = parseHTML("<!doctype html><html><body></body></html>");
    vi.stubGlobal("document", page);
    vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
    const layer = page.createElement("div");
    const spans = LINES.map((line) => {
      const span = page.createElement("span");
      span.textContent = line;
      layer.append(span);
      return span as unknown as HTMLElement;
    });
    page.body.append(layer);
    const runsOnPage1 = LINES.map((line, item) => ({ page: 1, item, at: LINES.slice(0, item).join(" ").length + (item ? 1 : 0), length: line.length, from: 0 }));
    const drawnText = LINES.join(" ");
    const wholeText = `${drawnText} ${REST}`;
    const block = (t: string, runs: ReflowBlock["runs"]): ReflowBlock => ({ kind: "paragraph", text: t, page: 1, runs, apart: false, columnBreak: true });
    const source = createPdfUnitSource();
    source.setBlocks([block(drawnText, runsOnPage1)]);
    source.setPage(1, { layer: layer as unknown as Element, spans });

    const minted: Unit[] = [];
    let claims = 0;
    const {controller} = await reader({
      collect: (_root, claim, options) => {
        const units = source.collect((nodes) => { claims++; return claim(nodes); }, options.mergeShorts, options.minWords);
        minted.push(...units);
        return units;
      },
    });
    try {
      expect(minted.map((u) => u.text)).toEqual([drawnText]);
      const first = minted[0]!;
      calls.renders[0]!(await calls.sends[0]!([first], "viewport"), 0);
      expect(controller.pageReport().counts).toMatchObject({read: 1, pending: 0});

      // Page 2 is read ahead: the paragraph is read whole, in the background.
      const cost = await controller.scoreDetached([{ page: 2, order: 0, text: wholeText, wordCount: 90 }]);
      expect(cost.scored).toBe(1);
      const requests = calls.request.mock.calls.length;

      // The reader rebuilds: the same block, its text now the whole paragraph, a run on page 2
      // that is not drawn.
      source.setBlocks([block(wholeText, [...runsOnPage1, { page: 2, item: 0, at: drawnText.length + 1, length: REST.length, from: 0 }])]);
      claims = 0;
      controller.refresh();
      await settle();
      const second = minted.at(-1)!;
      expect(minted).toHaveLength(2);
      expect(second.id).not.toBe(first.id);
      expect(second.text).toBe(wholeText);
      expect(second.parts.flatMap((p) => p.nodes)).toEqual(first.parts.flatMap((p) => p.nodes));
      expect(claims, "no claim is asked for a unit that changed only its text").toBe(0);
      expect(controller.onScreen(drawnText)).toBe(false);
      expect(controller.onScreen(wholeText)).toBe(true);

      // Its verdict is the one read ahead, from the cache; one unit, counted once.
      calls.renders[0]!(await calls.sends[0]!([second], "viewport"), 0);
      expect(calls.request.mock.calls.length).toBe(requests);
      expect(controller.pageReport().counts).toMatchObject({read: 1, pending: 0});
    } finally {controller.stop();}
  });
});

// A drawn page the viewer lets go: its paragraphs' verdicts are kept for the report where the
// document's paragraphs are known (the structure), and not under the reflow, whose text for a
// paragraph changes with the run of pages drawn — each run's reading would be counted again.
describe("a drawn page let go", () => {
  const LINE = "A paragraph on a page the viewer draws and later lets go, with words enough to be read by itself as one unit here.";

  async function drawnThenLetGo(documentTexts: () => ReadonlySet<string> | null) {
    const { document: page } = parseHTML("<!doctype html><html><body></body></html>");
    vi.stubGlobal("document", page);
    vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
    const layer = page.createElement("div");
    const span = page.createElement("span");
    span.textContent = LINE;
    layer.append(span);
    page.body.append(layer);
    const source = createPdfUnitSource();
    source.setBlocks([{ kind: "paragraph", text: LINE, page: 1, runs: [{ page: 1, item: 0, at: 0, length: LINE.length, from: 0 }], apart: false, columnBreak: true }]);
    source.setPage(1, { layer: layer as unknown as Element, spans: [span as unknown as HTMLElement] });
    const minted: Unit[] = [];
    const {controller} = await reader({
      documentTexts,
      collect: (_root, claim, options) => { const units = source.collect(claim, options.mergeShorts, 1); minted.push(...units); return units; },
    });
    calls.renders[0]!(await calls.sends[0]!([minted[0]!], "viewport"), 0);
    expect(controller.pageReport().counts.read).toBe(1);
    layer.remove();
    source.removePage(1);
    controller.refresh();
    await settle();
    return controller;
  }

  it("keeps its verdict where the document's paragraphs are known", async () => {
    const controller = await drawnThenLetGo(() => new Set([LINE]));
    try {
      expect(controller.knows(LINE)).toBe(true);
      expect(controller.pageReport().counts.read).toBe(1);
    } finally {controller.stop();}
  });

  it("keeps nothing under the reflow: the report covers the pages drawn now", async () => {
    const controller = await drawnThenLetGo(() => null);
    try {
      expect(controller.knows(LINE)).toBe(false);
      expect(controller.pageReport().counts.read).toBe(0);
    } finally {controller.stop();}
  });
});

describe("the idle prefetch", () => {
  it("leaves to the observers what they have not placed yet, and takes it once they have", async () => {
    vi.useFakeTimers();
    try {
      const unit = (id: string, order: number) => ({id, text: `${id} ${text("X")}`, wordCount: 60, order, parts: [], isScored: false, container: {isConnected: true}}) as unknown as Unit;
      calls.units = [unit("top", 0), unit("middle", 1), unit("bottom", 2)];
      const unplaced = new Set(["top", "middle"]);
      calls.placed = (u) => !unplaced.has(u.id);
      const {controller} = await reader();
      try {
        await vi.advanceTimersByTimeAsync(0);
        // Only what the observers have placed (far down the page) goes in the background lane.
        expect(calls.enqueued).toEqual([["bottom", "background"]]);
        // The observers place the rest, and say so: the prefetch goes on at once.
        unplaced.clear();
        calls.observerOptions?.onPlaced?.();
        await vi.advanceTimersByTimeAsync(0);
        // (The scheduler takes a unit queued again as the one it holds.)
        expect([...new Set(calls.enqueued.map(([id]) => id))].sort()).toEqual(["bottom", "middle", "top"]);
      } finally {controller.stop();}
    } finally {vi.useRealTimers();}
  });
});
