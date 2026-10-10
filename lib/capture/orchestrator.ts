import { beforeDocumentLeaves, cancelDocumentSession, documentSessionId, postDocumentMessage, sendDocumentMessage } from "../access/session";
// lib/capture/orchestrator.ts — ties walker + observers + scheduler + cache +
// messaging + renderer + toolbar reporting into the live capture→annotate loop.
//
// v2 ownership model: every text node of a live unit is CLAIMED in a WeakMap
// (node → owning unit). Re-scans skip runs whose exact node-set is already owned;
// a run that grew/shrunk/changed invalidates its stale owner and is re-taken. The
// page DOM carries NO marker attributes and NO injected inline styles — the only
// mutation is inserting badge hosts (and text-node splits in plain-text docs).
//
// Invalidation keeps everything honest against dynamic pages: units whose DOM was
// removed or whose text changed lose their badge/underline/result and are either
// re-collected or gone. SPA navigations (pushState included — the Navigation API's
// currententrychange, plus popstate/hashchange) refresh incrementally without
// flickering still-valid badges. The popup Rescan button remains the full teardown+rescan.
import type { ContentScriptContext } from "#imports";
import { ACTIONS } from "../messaging/protocol";
import type { BackendStatus, CommentAccessReply, EngineSetup } from "../messaging/protocol";
import { commentOriginsIn } from "../access/commentFrames";
import type { Unit, Lane } from "../types";
import type { ModelInfo, ScoreBlock, ScoreResult, ScoreBatchRequest } from "../contract";
import { CONTRACT_VERSION, PAGE_IN_FLIGHT, modelDim } from "../contract";
import { collectUnitsInSlices, inPageOrder, type CollectOptions } from "../dom/walker";
import { SLICE_MS, finishInSlices } from "../slices";
import { restoreSplits } from "../dom/splits";
import { partTextOf, isShortText, MAX_UNIT_TEXT_CHARS } from "../dom/text";
import { createObservers, type Observers } from "./observers";
import { createScheduler, type Scheduler } from "./scheduler";
import { createScoreCache, type ScoreCache } from "./cache";
import { readInWindows, requestSlices, unavailableResult, unitVerdict, type UnitVerdict, type WindowVerdict } from "./windows";
import { detectUnsupported, unsupportedResult } from "./langGate";
import { requestScores, requestTokenCounts, contextAlive } from "../messaging/client";
import { deviceKind } from "../backend/deviceKind";
import { createBadgeLayer, type BadgeLayer, type BadgeLayerOptions } from "../render/badge";
import {
  setHighlight,
  clearHighlight,
  registerHighlightStyles,
  setHighlightsVisible,
  refreshHighlightTheme,
} from "../render/highlight";
import { REPORT_PAGE_SIZE, reportOffset, type PageReport, type ReportCounts } from "./pageReport";
import { DEFAULT_FLAG_FROM, band, flagFromOf, flagLevel, isFlagged, type FlagFrom } from "../render/band";
import { levelOf } from "../render/scale";
import { settings } from "../settings/settings";
import { createLogger } from "../log";
import { createBackgroundPace } from "./pace";
import { createInsertionGate } from "./insertionGate";
import { createFling } from "./fling";
import { createBackendWatch } from "./backendWatch";
import { createKeptLedger, type KeptVerdict } from "./keptLedger";
import { createReadingMeter, inPrivateWindow, type RecorderModule } from "../stats/meter";
import { kindFrom, kindSignals } from "../stats/pageKind";
import { configOf } from "../stats/config";
import type { PageKind, Surface, VisitRow } from "../stats/model";

const log = createLogger("orchestrator");

// Per-lane batch sizes (chars): the viewport lane favours time-to-first-chip, the
// background prefetch lane favours model throughput (see scheduler.ts).
const LANE_BATCH_CHARS = { near: 4000, background: 6000 } as const;
/** The lanes' budgets. On screen one unit a batch, always: each chip goes up as soon as its
 *  paragraph is read, the first after one paragraph's pass rather than all of the screen's, and
 *  a pass costs the engine little beyond its tokens (12 ms on an M4's GPU, a paragraph's tenth).
 *  Off screen, one unit a batch too while `one` says so. */
function laneBudgets(one: () => boolean): Record<Lane, () => number> {
  const of = (lane: "near" | "background") => () => (one() ? 1 : LANE_BATCH_CHARS[lane]);
  return { viewport: () => 1, near: of("near"), background: of("background") };
}
/** How soon the idle prefetch looks again for units the observers have still not placed (the
 *  observers ask as they place them; Observers.placed gives up waiting after a second). */
const PLACE_RETRY_MS = 1100;
/** Background prefetch may hold at most this many of the in-flight slots (PAGE_IN_FLIGHT). */
const MAX_BACKGROUND_IN_FLIGHT = 1;
/** Units enqueued per idle prefetch pass (huge pages drain in successive passes). */
const PREFETCH_PASS = 300;
// The Navigation API (window.navigation) fires `currententrychange` for every
// same-document navigation — pushState/replaceState included — and is reachable
// from the content script's isolated world, so no MAIN-world history patch is needed.
/** A route change is answered once, not once per entry: frameworks that push and then
 *  correct the address (a redirect, a canonical slug, a query the router rewrites) fire
 *  several changes in a row, and one walk answers all of them. */
const URL_REFRESH_DEBOUNCE_MS = 300;
/** While the daemon is down: how often the content script asks the worker to re-probe. */
const DOWN_POLL_MS = 5000;
/** How long a jump to a kept paragraph waits for its page to be drawn, and how much of a
 *  regrouped paragraph's opening must match for the jump to land on it. */
const JUMP_WAIT_MS = 5000;
const JUMP_MATCH_CHARS = 40;

const navigationApi = (): EventTarget => (window as unknown as { navigation: EventTarget }).navigation;

export interface Orchestrator {
  /** Begin capture: initial scan + observers + scheduler. Idempotent. */
  start(): void;
  /** Full teardown: disconnect observers, bump epoch, remove all badges, and
   *  have the worker drop what it was still scoring for this run. */
  stop(): void;
  /** Force a fresh full scan (popup "Rescan"): drop everything, re-collect. */
  rescan(): void;
  /**
   * The units a surface hands out (`OrchestratorOptions.collect`) changed: purge what is
   * gone, collect what is new, and put back the chips the surface took down. Everything
   * still valid keeps its chip, marks and verdict — the PDF reader calls this each time a
   * page is drawn, recycled, re-laid at a new zoom or read again by the structure.
   */
  refresh(): void;
  /** Toggle paragraph marks from the toolbar or keyboard. First call also scans. */
  toggle(): void;
  /** Number of units that have rendered a badge (popup GET_TAB_STATE). */
  scoredCount(): number;
  /** Number of units flagged heavily edited / AI-generated (popup GET_TAB_STATE). */
  flaggedCount(): number;
  /** Number of units skipped as an unsupported language (popup GET_TAB_STATE). */
  unsupportedCount(): number;
  /** Number of units left with a degraded "Unavailable" verdict (popup GET_TAB_STATE). */
  unavailableCount(): number;
  /** Document-specific action shown in the toolbar (Google Docs reading view etc.). */
  setPageAction(label: string | null, onAction?: () => void): void;
  /**
   * Score paragraphs that are not on screen — no DOM, only their text — in the background
   * lane: the PDF reader's whole-document reading. Their windows go to the score cache, so the
   * paragraph costs nothing when its page is drawn, and their verdicts to the kept ledger, so
   * the report counts them meanwhile. Resolves with what it cost.
   */
  scoreDetached(items: readonly DetachedParagraph[]): Promise<DetachedReport>;
  /** Whether a paragraph's text has a verdict here, on screen or kept. */
  knows(text: string): boolean;
  /** Whether a unit on screen has this text: it is read by the page's own lanes. */
  onScreen(text: string): boolean;
  /** Whether work for what is on screen is waiting or in flight, or nothing may be sent now
   *  (stopped, the engine down, the page hidden): when work for what is not waits. */
  busy(): boolean;
  pageReport(offset?: number): PageReport;
  runPageAction(documentId: string, id: number): boolean;
  jumpToResult(documentId: string, id: string): boolean;
  /** Popup "Retry": re-probe the daemon now; re-queue every "Unavailable" unit. */
  retryBackend(): void;
  /** The worker's push while the in-browser engine's model downloads; false when this page no
   *  longer shows the download. */
  setupProgress(setup: EngineSetup | null): boolean;
  /** Drop the per-tab verdict cache and leave the page exactly as it is (options →
   *  "Clear cached verdicts"): the next scan or Rescan asks the backend again. */
  forgetCached(): void;
  /** Keyboard command: scroll to the next (1) / previous (-1) flagged paragraph. */
  jumpFlagged(dir: 1 | -1): void;
}

function newSessionId(): string {
  return "s_" + Math.random().toString(36).slice(2, 10);
}

/** A paragraph of a paged document that is not on screen, to be read in the background. */
export interface DetachedParagraph {
  /** The page its chip will stand on (Unit.page). */
  page: number;
  /** Its place in the document's reading order (Unit.order). */
  order: number;
  /** Exactly the text its unit will have when the page is drawn: the cache is keyed by it. */
  text: string;
  wordCount: number;
}

/** What one scoreDetached() call cost: the time, and how many windows the engine was sent. */
export interface DetachedReport {
  ms: number;
  /** Windows of the batch the engine read: not cache hits, not settled by the language gate. */
  sent: number;
  /** Characters in those windows: what the pace learns from. */
  chars: number;
  /** Paragraphs that came back with a verdict. */
  scored: number;
  /** The run was stopped or started over while the batch was out: nothing of it counts. */
  retired: boolean;
  /** The engine was down when the batch came back: what it failed says nothing of the text. */
  down: boolean;
}

/** Everything the FIRST collect depends on, read as one snapshot before it runs. */
interface SettingsSnapshot {
  showHighlights: boolean;
  underlineScope: "flagged" | "all";
  displayMode: "all" | "flagged";
  flagFrom: FlagFrom;
}

/** Storage answered nothing (dead extension context) — boot with the shipped defaults. */
const DEFAULT_SNAPSHOT: SettingsSnapshot = {
  showHighlights: true,
  underlineScope: "flagged",
  displayMode: "all",
  flagFrom: DEFAULT_FLAG_FROM,
};

export interface OrchestratorOptions {
  /** The top frame owns the tab's toolbar count; subframes only draw paragraph marks. */
  toolbarOwner?: boolean;
  /** Reader-specific coverage shown beside the popup counts, told how many pages of a paged
   *  document (Unit.page) have verdicts, drawn now or kept. */
  reportScopeNote?: (pagesRead: number) => string;
  /** Bring a page of a paged document into view: the report's list asked for a paragraph on a
   *  page the viewer let go, which is jumped to once the page is drawn and read again. */
  revealPage?: (page: number) => void;
  /** The texts of the document's paragraphs as the surface reads them now, where it knows
   *  them all (the PDF reader with Zotero's structure): a kept verdict on any other text is
   *  of a paragraph read differently since, and is not counted. */
  documentTexts?: () => ReadonlySet<string> | null;
  /** Whether every batch is one unit, asked at each batch: the PDF reader's, where the engine
   *  is not fast (lib/pdf/readAhead.ts). Without it, where the engine scores on the processor
   *  (its status's device): a request there takes seconds and cannot be interrupted, and one
   *  paragraph at a time puts each chip up as soon as it is read. */
  oneUnitBatches?: () => boolean;
  /** Whether the background lane keeps to the pace (lib/capture/pace.ts); yes unless said. The
   *  PDF reader says no: its read-ahead keeps its own, and waits for the page's own queue. */
  pacedBackground?: boolean;
  /**
   * Where the units come from, when they do not come from a DOM walk. The PDF reader
   * supplies this: a PDF's paragraphs are the document's own reconstruction, decided by
   * geometry rather than by markup, and only the reader knows which span of which page
   * each one was set in (lib/pdf/units.ts). Everything downstream is unchanged — the
   * units it returns are ordinary units and are scheduled, marked and chipped as such —
   * and it is asked exactly where collectUnits would have been, with the same ownership
   * filter, so a re-scan leaves live units alone in exactly the same way.
   */
  collect?: (
    root: ParentNode,
    claimFilter: (nodes: Text[]) => "take" | "skip",
    opts: CollectOptions,
  ) => Unit[];
  /**
   * Where a unit's chip goes, for a surface on which "after the last text node" means
   * nothing. The badge layer's own rule is the page's flow; a PDF page is a drawing with
   * an absolutely positioned text layer over it, so the reader places the host itself
   * (see BadgeLayerOptions.place). Left out everywhere else, which is every other surface.
   */
  placeBadge?: BadgeLayerOptions["place"];
  /** The kind of page, for the reading statistics, where the caller knows it: "document" on
   *  a surface and in the PDF reader. Elsewhere it is told from the page (lib/stats/pageKind.ts). */
  pageKind?: () => PageKind;
  /** What the page's text comes from, for the reading statistics: a surface's document, the
   *  PDF reader, a Google Doc; a web page when left out. */
  statsSurface?: Surface;
  /** The PDF reader's document, for the statistics: its pages, which reader read it, how many
   *  pages were drawn. */
  statsPdf?: () => VisitRow["pdf"];
  /** Where the statistics' recorder comes from: the page chunk unless said (an extension page
   *  bundles it, lib/stats/meter.ts). */
  statsRecorder?: () => Promise<RecorderModule>;
}

export function createOrchestrator(
  // The context is part of the content-script contract and deliberately unused; the PDF
  // reader runs the same pipeline from an extension page, where there is no context.
  _ctx: ContentScriptContext | null,
  opts: OrchestratorOptions = {},
): Orchestrator {
  const toolbarOwner = opts.toolbarOwner ?? true;
  const cache: ScoreCache = createScoreCache();
  const badges: BadgeLayer = createBadgeLayer({
    place: opts.placeBadge,
    onCard: (id, what) => { const unit = unitsById.get(id); if (unit) reading.ui(what, unit); },
  });

  let unitsById = new Map<string, Unit>();
  /**
   * Prose the walk found and left unread — under the evidence floor, with nobody of its
   * voice to join — kept as the FIRST text node of each such stretch. A node, not a
   * tally: a re-scan of the same subtree reports the same stretches again, and counting
   * them twice would inflate the popup's "short" the longer a reader stayed on a feed.
   * Entries leave when the node is taken into a unit (the reader opened a "see more" and
   * it now has neighbours) or when the DOM lets it go (purgeDisconnected).
   */
  const shortTexts = new Map<Text, Text[]>();
  /** One verdict per analyzed unit — the aggregate everything counts by, plus its windows. */
  let verdictsById = new Map<string, UnitVerdict>();
  /** PAGED DOCUMENTS: the verdicts on paragraphs whose page is not drawn now, let go with it
   *  (purgeDisconnected) or read without it (scoreDetached) — lib/capture/keptLedger.ts. */
  const kept = createKeptLedger();
  let detachedSeq = 0;
  /** A kept paragraph the report's list asked for: jumped to once its page is read again, if
   *  that is soon — later, the reader has moved on. */
  let pendingJump: { page: number; text: string; until: number } | null = null;
  /** Text-node ownership: node → live unit. Recreated on stop/rescan. */
  let nodeOwner = new WeakMap<Text, Unit>();
  /** The voice scopes walks have gone into (CollectOptions.scopesRead): a re-scan passes by
   *  the ones nothing changed in. Recreated with the units. */
  let scopesRead = new WeakSet<Element>();

  const session = newSessionId();
  const domain = location.hostname || "und";

  let started = false;
  /** True once the settings snapshot has been applied AND the first collect has run. */
  let booted = false;
  /** Boot generation: a stop()+start() pair must not let the older boot finish. */
  let bootSeq = 0;
  /** Retire page work across awaits too, before it can refill L1 or send old text. */
  let captureGeneration = 0;
  let visible = true;
  let highlightsEnabled = true;
  let displayMode: "all" | "flagged" = "all";
  /** The word a paragraph is flagged from (Settings): counted, listed, underlined. */
  let flagFrom: FlagFrom = DEFAULT_FLAG_FROM;
  /** Underlines on the flagged paragraphs, or on every paragraph read (Settings). */
  let underlineScope: "flagged" | "all" = "flagged";
  const flagged = (r: ScoreResult): boolean => isFlagged(r, flagFrom);
  let unwatchHighlights: (() => void) | null = null;
  let unwatchDisplay: (() => void) | null = null;
  let unwatchFlagFrom: (() => void) | null = null;
  let unwatchUnderlineScope: (() => void) | null = null;
  let lastBadgeSent = -1;
  /** Backend identity the L1 cache currently belongs to (from the last reply). */
  let l1Dim: string | null = null;
  let lastHref = location.href;
  /** A route change's refresh, waiting out the burst it arrived in. */
  let urlRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whether the page's own tree may be touched yet (lib/capture/insertionGate.ts). */
  const gate = createInsertionGate(log);
  const whenSafeToInsert = gate.whenSafe;
  /** The idle prefetch reads what nobody has scrolled to yet at a pace (lib/capture/pace.ts);
   *  the PDF reader keeps its own (OrchestratorOptions.pacedBackground). */
  const pace = opts.pacedBackground !== false ? createBackgroundPace() : null;
  /** While the page is flung past, what is on screen for a moment waits (lib/capture/fling.ts). */
  const fling = createFling();
  /**
   * What of the page is read, for the reading statistics — only while the reader has asked
   * for them (Settings, Statistics), and never in a private window (lib/stats/meter.ts).
   */
  const reading = createReadingMeter({
    fling,
    surface: opts.statsSurface ?? "web",
    frame: toolbarOwner ? "top" : "frame",
    verdictOf: (unit) => verdictsById.get(unit.id)?.result,
    kind: () => {
      const said = opts.pageKind?.();
      if (said) return { kind: said, signals: null };
      const signals = kindSignals(document, location, firstUnits(64));
      return { kind: kindFrom(signals), signals };
    },
    display: () => ({ chips: displayMode, underlines: highlightsEnabled ? underlineScope : "off", flagFrom }),
    flagged: (result) => flagged(result),
    found: () => {
      let words = 0;
      for (const unit of unitsById.values()) words += unit.wordCount;
      return { units: unitsById.size, words };
    },
    ...(opts.statsPdf ? { pdf: opts.statsPdf } : {}),
    ownsDwell: toolbarOwner,
    send: (wire) => sendDocumentMessage({ action: ACTIONS.STATS_RECORD, wire }),
    post: (wire) => postDocumentMessage({ action: ACTIONS.STATS_RECORD, wire }),
  }, opts.statsRecorder);
  let unwatchStats: (() => void) | null = null;
  /** The reading log's last message of the visit, said on the session's port as the page goes
   *  (while started). */
  let unwatchLeaving: (() => void) | null = null;
  /** The address of the page view `reading` counts: a route to another path is another. */
  let statsView = location.origin + location.pathname;
  /** The daemon stopped answering: dispatch is paused until a probe succeeds
   *  (lib/capture/backendWatch.ts). */
  const backend = createBackendWatch({
    pollMs: DOWN_POLL_MS,
    probe: async (force) => (await sendDocumentMessage({ action: ACTIONS.GET_BACKEND_STATUS, probe: force })) as BackendStatus | undefined,
    alive: contextAlive,
    freeze: () => freeze(),
    changed(down) {
      syncDispatch();
      if (down) log.warn("scoring daemon not answering — dispatch paused, re-checking every", DOWN_POLL_MS, "ms");
      else {
        retryUnavailable();
        log.log("scoring daemon back");
      }
    },
    learned: (s) => learnDevice(s),
    // The daemon may have come back as a DIFFERENT model.
    adopt: (m) => adoptBackend(m),
    generation: () => captureGeneration,
  });
  /** The tab is in the background: dispatch is paused until it is shown again. */
  let pageHidden = false;
  /** The flagged unit the last jump parked on. Without it a second next-flagged press
   *  would re-pick the paragraph the first one centred, since "the next one past the
   *  scroll position" is that very paragraph. */
  let flaggedCursor: string | null = null;

  /**
   * Units in the order a reader meets them — what the popup lists, the next/previous
   * commands walk, the report numbers and the prefetch follows. A walked page is asked
   * where each unit stands (inPageOrder); units that come from `opts.collect` are already
   * numbered in their document's own order, which only the reader knows.
   */
  const readingOrder = (units: readonly Unit[]): Unit[] =>
    opts.collect ? [...units].sort((a, b) => a.order - b.order) : inPageOrder(units);

  /** The first units found: what the page kind is told from. */
  function firstUnits(n: number): Unit[] {
    const out: Unit[] = [];
    for (const unit of unitsById.values()) {
      if (out.length >= n) break;
      out.push(unit);
    }
    return out;
  }

  /** Flagged units with their verdicts, in reading order. */
  function flaggedInOrder(): { unit: Unit; v: UnitVerdict }[] {
    const units: Unit[] = [];
    for (const [id, v] of verdictsById) {
      const unit = unitsById.get(id);
      if (unit && flagged(v.result)) units.push(unit);
    }
    return readingOrder(units).map((unit) => ({ unit, v: verdictsById.get(unit.id)! }));
  }

  let pageAction: { id: number; label: string; run?: () => void } | null = null;
  let actionRevision = 0;
  let lastCommentRefresh = 0;
  const reportDocumentId = (): string => `${session}:${captureGeneration}`;

  /** The report's list: flagged units, and on a paged document the flagged kept verdicts of
   *  pages not drawn now, by page and then place on it. */
  function flaggedEntries(): { id: string; text: string; result: ScoreResult }[] {
    const live = flaggedInOrder().map(({ unit, v }) => ({ id: unit.id, page: unit.page ?? 0, order: unit.order, text: unit.text, result: v.result }));
    const gone = keptNow().filter((k) => flagged(k.result));
    if (gone.length === 0) return live;
    return [...live, ...gone].sort((a, b) => a.page - b.page || a.order - b.order);
  }

  function pageReport(requestedOffset = 0): PageReport {
    if (Date.now() - lastCommentRefresh > 5000) {
      lastCommentRefresh = Date.now();
      refreshCommentOffer();
    }
    const flagged = flaggedEntries();
    const offset = reportOffset(requestedOffset, flagged.length);
    return {
      documentId: reportDocumentId(), visible, counts: reportCounts(),
      total: flagged.length, offset,
      entries: flagged.slice(offset, offset + REPORT_PAGE_SIZE).map(({ id, text, result }) => ({
        id, score: result.score, band: band(result), snippet: text.slice(0, 140).trimEnd(),
      })),
      scopeNote: opts.reportScopeNote?.(pagesRead()) ?? "", commentOrigins: commentOffer,
      pageAction: pageAction ? { id: pageAction.id, label: pageAction.label, enabled: !!pageAction.run } : null,
    };
  }

  function setPageAction(label: string | null, run?: () => void): void {
    pageAction = label ? { id: ++actionRevision, label, run } : null;
  }

  function runPageAction(documentId: string, id: number): boolean {
    if (documentId !== reportDocumentId() || pageAction?.id !== id || !pageAction.run) return false;
    pageAction.run();
    return true;
  }

  function jumpToResult(documentId: string, id: string): boolean {
    if (documentId !== reportDocumentId()) return false;
    const away = keptNow().find((k) => k.id === id);
    if (away && opts.revealPage) {
      if (!visible) setVisible(true);
      pendingJump = { page: away.page, text: away.text, until: Date.now() + JUMP_WAIT_MS };
      opts.revealPage(away.page);
      return true;
    }
    if (!unitsById.get(id)?.container.isConnected) return false;
    if (!visible) setVisible(true);
    pendingJump = null;
    jumpTo(id);
    return true;
  }

  /**
   * The coverage line's numbers. "Read" is verdicts the model really gave, so an outage
   * and a page of Chinese are both counted where they belong rather than passing for
   * analysis; "short" is what the walk found and did not score (see shortTexts); and
   * "lessReliable" counts the verdicts on texts under the model's 75-word training minimum,
   * the ones whose card says "Short text: less reliable" (shortTextNote, lib/render/coverage.ts).
   */
  function reportCounts(): ReportCounts {
    let read = 0;
    let notEnglish = 0;
    let unavailable = 0;
    let lessReliable = 0;
    const bands = [0, 0, 0, 0];
    for (const [id, v] of verdictsById) {
      if (v.result.unsupported) notEnglish++;
      else if (v.result.degraded) unavailable++;
      else {
        read++;
        bands[levelOf(v.result.score)]!++;
        const unit = unitsById.get(id);
        if (unit && isShortText(unit.wordCount)) lessReliable++;
      }
    }
    for (const k of keptNow()) {
      if (k.result.unsupported) notEnglish++;
      else if (k.result.degraded) unavailable++;
      else {
        read++;
        bands[levelOf(k.result.score)]!++;
        if (isShortText(k.wordCount)) lessReliable++;
      }
    }
    let pending = 0;
    for (const id of unitsById.keys()) if (!verdictsById.has(id)) pending++;
    return { read, bands, short: shortTexts.size, notEnglish, pending, unavailable, lessReliable };
  }

  /**
   * Comment threads this page shows in frames of a site nobody has granted (Disqus,
   * Facebook's comments plugin — lib/access/commentFrames.ts): no script runs in those
   * frames, so the popup says so and offers to allow the site. Asked when the page is first
   * read and whenever the popup opens, because such a frame is usually put in late.
   */
  let commentOffer: readonly string[] = [];
  let commentAsked = 0;
  function refreshCommentOffer(): void {
    if (!toolbarOwner || opts.collect || !started) return;
    const origins = commentOriginsIn(document);
    const asked = ++commentAsked;
    if (origins.length === 0) {
      setCommentOffer([]);
      return;
    }
    void sendDocumentMessage({ action: ACTIONS.COMMENT_ACCESS, origins })
      .then((reply) => {
        if (asked === commentAsked && started) setCommentOffer((reply as CommentAccessReply | undefined)?.missing ?? []);
      })
      .catch(() => undefined);
  }
  function setCommentOffer(next: readonly string[]): void {
    if (next.join(" ") === commentOffer.join(" ")) return;
    commentOffer = next;
  }

  /** Centre a unit in the viewport and pulse its chip (popup rows and the
   *  next/previous-flagged commands land the same way). */
  function jumpTo(id: string): void {
    const unit = unitsById.get(id);
    if (!unit || !unit.container.isConnected) return;
    flaggedCursor = id;
    reading.ui("jump", unit);
    unit.container.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => badges.flash(id), 350); // pulse once the scroll settles
  }

  /** Flagged units still in the DOM, in document order. */
  function flaggedUnits(): Unit[] {
    return flaggedInOrder()
      .map(({ unit }) => unit)
      .filter((unit) => unit.container.isConnected);
  }

  function jumpFlagged(dir: 1 | -1): void {
    const list = flaggedUnits();
    if (list.length === 0) return;
    const at = flaggedCursor === null ? -1 : list.findIndex((u) => u.id === flaggedCursor);
    const onScreen = at >= 0 && intersectsViewport(list[at]!.container);
    let target: Unit;
    if (onScreen) {
      target = list[(at + dir + list.length) % list.length]!;
    } else {
      // Nothing to continue from (first press, or the reader scrolled away): take the
      // nearest one in that direction from the middle of the viewport, wrapping around.
      const vh = window.innerHeight || 0;
      const ref = window.scrollY + vh / 2;
      const mid = (u: Unit): number => {
        const r = u.container.getBoundingClientRect();
        return window.scrollY + r.top + r.height / 2;
      };
      target =
        dir === 1
          ? (list.find((u) => mid(u) > ref + 4) ?? list[0]!)
          : ([...list].reverse().find((u) => mid(u) < ref - 4) ?? list[list.length - 1]!);
    }
    jumpTo(target.id);
  }

  /** Painted under the current display mode? Everything is analyzed regardless. */
  /** Whether a verdict has a chip: not on a paragraph in another language (only English is
   *  read; the toolbar menu counts the rest), and under "Flagged only" only on a flagged one. */
  function visibleUnderMode(v: UnitVerdict): boolean {
    if (v.result.unsupported) return false;
    return displayMode === "all" || flagged(v.result);
  }

  /** A painted unit's underlines: only a flagged one's, and of it only the stretches at the
   *  level or above (setHighlight), so below it a paragraph has its chip only — unless the
   *  reader asked for underlines on every paragraph. */
  function mark(unit: Unit, v: UnitVerdict): void {
    const every = underlineScope === "all";
    if (highlightsEnabled && (every || flagged(v.result))) setHighlight(unit, v, every ? 0 : flagLevel(flagFrom));
    else clearHighlight(unit.id);
  }

  // --- ownership / invalidation ----------------------------------------------------

  /** The unit's CURRENT text, recomputed the same way the walker built it — except where
   *  the unit says its text is the document's and not the page's (see Unit.textFixed). */
  function currentTextOf(unit: Unit): string {
    if (unit.textFixed) return unit.text;
    return unit.parts
      .map(partTextOf)
      .join("\n\n")
      .slice(0, MAX_UNIT_TEXT_CHARS);
  }

  /** Drop a unit everywhere: badge, underline, result, claims, observation. */
  function invalidateUnit(unit: Unit, rescanQueue?: Set<Element>): void {
    badges.remove(unit.id);
    clearHighlight(unit.id);
    observers.dropUnit(unit);
    reading.forget(unit);
    for (const part of unit.parts) {
      for (const n of part.nodes) {
        if (nodeOwner.get(n) === unit) nodeOwner.delete(n);
      }
      if (rescanQueue && part.container.isConnected) rescanQueue.add(part.container);
    }
    unitsById.delete(unit.id);
    verdictsById.delete(unit.id);
  }

  /** Purge units whose DOM disappeared (SPA swaps, virtualized lists). */
  function purgeDisconnected(rescanQueue?: Set<Element>): void {
    // Detached text nodes are held by nothing else here — a feed that scrolls for an hour
    // would otherwise keep every short paragraph it ever showed.
    for (const node of shortTexts.keys()) if (!node.isConnected) shortTexts.delete(node);
    let left = false;
    for (const unit of [...unitsById.values()]) {
      const gone =
        !unit.container.isConnected ||
        unit.parts.some((p) => {
          const first = p.nodes[0];
          const last = p.nodes[p.nodes.length - 1];
          return (first && !first.isConnected) || (last && !last.isConnected);
        });
      if (!gone) continue;
      const v = verdictsById.get(unit.id);
      // Kept only where the document's paragraphs are known (the PDF reader's structure):
      // the reflow reads a run of drawn pages as a whole, and a paragraph across the edge of
      // the run reads differently with every run — each would be counted again.
      if (unit.page !== undefined && v && !v.result.degraded && opts.documentTexts?.()) {
        kept.keep({ page: unit.page, order: unit.order, text: unit.text, wordCount: unit.wordCount }, v.result);
        left = true;
      }
      invalidateUnit(unit, rescanQueue);
    }
    if (left) updateToolbar();
  }

  /** What is kept of the paragraphs not on screen now. */
  function keptNow(): KeptVerdict[] {
    return kept.now(Array.from(unitsById.values(), (unit) => unit.text), opts.documentTexts?.() ?? null);
  }

  /** Pages with verdicts, drawn now or kept. */
  function pagesRead(): number {
    const pages = new Set<number>(kept.pages());
    for (const id of verdictsById.keys()) {
      const page = unitsById.get(id)?.page;
      if (page !== undefined) pages.add(page);
    }
    return pages.size;
  }

  function knows(text: string): boolean {
    if (kept.has(text)) return true;
    for (const [id, v] of verdictsById) if (!v.result.degraded && unitsById.get(id)?.text === text) return true;
    return false;
  }

  function onScreen(text: string): boolean {
    for (const unit of unitsById.values()) if (unit.text === text) return true;
    return false;
  }

  // Anything of the page's own out or waiting holds the read-ahead: on screen it comes
  // first, and whatever a batch waits behind would be timed as the engine's pace.
  function busy(): boolean {
    return !started || !booted || frozen || backend.down || pageHidden || scheduler.pendingCount() > 0;
  }

  /**
   * Walker ownership filter. "skip" when the run is an exact live part; otherwise
   * invalidate any stale owners (run grew/shrunk/split) and let the walker re-take.
   */
  function makeClaimFilter(rescanQueue?: Set<Element>, seen?: Set<string>) {
    return (nodes: Text[]): "take" | "skip" => {
      const owners = new Set<Unit>();
      for (const n of nodes) {
        const u = nodeOwner.get(n);
        if (u) owners.add(u);
      }
      if (owners.size === 0) return "take";
      if (owners.size === 1) {
        const u = owners.values().next().value as Unit;
        if (unitsById.has(u.id)) {
          const part = u.parts.find((p) => p.nodes.includes(nodes[0]!));
          if (
            part &&
            part.nodes.length === nodes.length &&
            part.nodes.every((n, i) => n === nodes[i])
          ) {
            seen?.add(u.id);
            return "skip"; // unchanged — already rendered
          }
        }
      }
      for (const u of owners) {
        if (unitsById.has(u.id)) invalidateUnit(u, rescanQueue);
      }
      return "take";
    };
  }

  /**
   * WALKS. A walk of the page pauses between blocks to let the page's own work through
   * (collectUnitsInSlices): a table of twenty thousand rows held the page for a second in
   * one go. So walks go one at a time — another walk meanwhile would claim the nodes this one
   * is reading — and what one finds is taken only if the run it was for is still on. A
   * surface's own collect (OrchestratorOptions.collect) answers at once, as before.
   */
  let walks: Promise<unknown> = Promise.resolve();
  function walkInTurn<T>(job: () => Promise<T>): Promise<T> {
    const run = walks.then(job);
    walks = run.catch((e) => log.warn("walk failed", e));
    return run;
  }

  /** One walk under `root`: shadow roots it descends into become observer targets. `meter`
   *  adds up the time the walk handed back to the page (finishInSlices). */
  function collect(root: ParentNode, claimFilter: (nodes: Text[]) => "take" | "skip", changed?: readonly Node[], meter?: { waited: number }): Unit[] | Promise<Unit[]> {
    const options: CollectOptions = {
      claimFilter,
      scopesRead,
      ...(changed ? { changed } : {}),
      onShortText: (nodes) => {
        if (nodes[0]) shortTexts.set(nodes[0], nodes);
        reading.trackShort(nodes);
      },
      onShadowRoot: observers.observeRoot,
      // What the walk left out, for the reading log; only while it records.
      ...(reading.running() ? { onLeftOut: reading.leftOut } : {}),
    };
    return opts.collect
      ? opts.collect(root, claimFilter, options)
      : finishInSlices(collectUnitsInSlices(root, options), SLICE_MS, meter);
  }

  /** Register freshly collected units: claim their nodes, observe, index. */
  function ingestUnits(units: Unit[]): void {
    for (const u of units) {
      if (unitsById.has(u.id)) continue;
      // A node is one unit's: a unit minted on nodes another still holds (the PDF reader's,
      // its text restated by a page read since) retires that one, chip and all.
      for (const part of u.parts) {
        for (const n of part.nodes) {
          const owner = nodeOwner.get(n);
          if (owner && owner !== u && unitsById.get(owner.id) === owner) invalidateUnit(owner);
        }
      }
      unitsById.set(u.id, u);
      for (const part of u.parts) {
        for (const n of part.nodes) {
          nodeOwner.set(n, u);
          shortTexts.delete(n); // it found neighbours after all — it is read now
        }
      }
      observers.observeUnit(u);
      reading.track(u);
    }
    if (pendingJump && Date.now() > pendingJump.until) pendingJump = null;
    if (pendingJump) {
      const { page, text } = pendingJump;
      const onPage = units.filter((u) => u.page === page);
      // The same paragraph, or, regrouped since, the unit that holds its opening (an opening
      // long enough to be its own).
      const opens = (whole: string, part: string) => part.length >= JUMP_MATCH_CHARS && whole.includes(part.slice(0, 80));
      const target = onPage.find((u) => u.text === text) ?? onPage.find((u) => opens(u.text, text) || opens(text, u.text));
      if (target) {
        pendingJump = null;
        jumpTo(target.id);
      }
    }
    schedulePrefetch();
  }

  // --- idle prefetch -----------------------------------------------------------------
  // Everything the observers have not yet asked for is scored in the background lane
  // during idle time, in document order and at the pace lib/capture/pace.ts sets, so by the
  // time the reader scrolls there the verdict is already cached (here and in the worker's
  // persistent cache, lib/backend/swCache.ts). The lane is lowest priority and holds one
  // batch in flight at most, so what comes on screen waits behind that one batch at most (the
  // engine finishes a pass it has begun); a unit that scrolls into view meanwhile is upgraded.
  let prefetchScheduled = false;
  function schedulePrefetch(): void {
    if (prefetchScheduled || frozen) return;
    prefetchScheduled = true;
    const run = () => {
      prefetchScheduled = false;
      if (!started || frozen) return;
      let n = 0;
      const unscored = [...unitsById.values()].filter((u) => !u.isScored && !verdictsById.has(u.id));
      // What the observers have not placed yet is theirs: the screen goes in the viewport
      // lane, a paragraph at a time (Observers.placed). Asked again once they have.
      const pending = readingOrder(unscored.filter((u) => observers.placed(u)));
      for (const u of pending) {
        scheduler.enqueue(u, "background");
        if (++n >= PREFETCH_PASS) break;
      }
      if (n > 0) log.log("prefetch: queued", n, "of", pending.length, "unscored units");
      // The observers ask for the rest as they place it (onPlaced); this is for any they never do.
      if (pending.length < unscored.length) setTimeout(schedulePrefetch, PLACE_RETRY_MS);
    };
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    // Called ON window: Gecko's binding rejects a detached call ("called on an object that
    // does not implement interface Window") — Chromium tolerates it, which is how the
    // whole idle lane stayed dead on Firefox without any Chromium suite noticing.
    if (typeof ric === "function") ric.call(window, run, { timeout: 1500 });
    else setTimeout(run, 400);
  }

  // --- scheduler send/render seam ----------------------------------------------------

  /**
   * Scheduler send(): one verdict per unit. A unit longer than the model reads in one
   * pass is read in windows (lib/capture/windows.ts); every window of every unit in the
   * batch goes through scoreBlocks() TOGETHER, and a unit gets a verdict only once all
   * of its windows have one — so nothing of a long paragraph is ever painted half-read.
   * What aggregation does with a failed or a non-English window is unitVerdict()'s rule.
   */
  /** Token counts for this run of the capture. A count that meets a stopped engine turns the
   *  page down exactly as a score would, so what it leaves Unavailable is queued again when
   *  the engine is back. */
  const countTokensFor = (generation: number) => async (texts: string[]) => {
    const reply = await requestTokenCounts(texts);
    if (generation === captureGeneration) {
      backend.heard(reply.backend);
    }
    return reply.counts;
  };

  async function send(units: Unit[], lane: Lane): Promise<UnitVerdict[]> {
    const generation = captureGeneration;
    const timed = pace !== null && lane === "background";
    const began = performance.now();
    let chars = 0;
    const read = await readInWindows(units, async (blocks, owners) => {
      if (!timed) return scoreBlocks(blocks, owners, lane, generation);
      const cached = new Set(blocks.filter((b) => cache.get(b.text)).map((b) => b.id));
      const out = await scoreBlocks(blocks, owners, lane, generation);
      chars += engineRead(blocks, cached, out).chars;
      return out;
    }, countTokensFor(generation));
    if (timed && generation === captureGeneration) pace!.done(performance.now() - began, chars);
    if (generation !== captureGeneration) {
      // Clearing a cache leaves existing verdicts visible, but an abandoned batch
      // must not leave its unfinished chips behind or paint a late result. Where only the
      // caches went, its units are still on the page and have spent the one dispatch the
      // observers give a unit: they are placed again, so the ones on screen go back in the
      // viewport lane instead of waiting for the idle prefetch.
      for (const unit of units) {
        if (verdictsById.has(unit.id)) continue;
        badges.remove(unit.id);
        if (started && !frozen && unitsById.get(unit.id) === unit) observers.reobserve(unit);
      }
      return [];
    }
    const out: UnitVerdict[] = [];
    for (const unit of units) {
      const windows = read.get(unit.id);
      if (windows) out.push(unitVerdict(unit.id, unit.text.length, windows));
      // Hard transport failure (extension reloaded/updated mid-flight): some window of
      // this unit was never answered — retire its pending chip instead of leaving
      // "analyzing…" stuck on the page forever.
      else badges.remove(unit.id);
    }
    return out;
  }

  /** What of a batch the engine itself read, which is what the pace learns from
   *  (lib/capture/pace.ts): not what this page or the service worker had cached
   *  (`cached`, ScoreResult.cached), not what the language gate settled. */
  function engineRead(blocks: readonly ScoreBlock[], cached: ReadonlySet<string>, out: ReadonlyMap<string, ScoreResult>): { sent: number; chars: number } {
    let sent = 0, chars = 0;
    for (const b of blocks) {
      const r = out.get(b.id);
      if (!cached.has(b.id) && r && !r.cached && !r.unsupported && !r.degraded) { sent++; chars += b.text.length; }
    }
    return { sent, chars };
  }

  /**
   * Paragraphs with no DOM, read exactly as a unit is (send): windows planned by
   * readInWindows, blocks through scoreBlocks in the background lane — the cache first, the
   * same requests, the same cache entries after — so the unit the paragraph becomes when its
   * page is drawn finds every window cached. A degraded verdict is not kept: the page asks
   * again when it is drawn.
   */
  async function scoreDetached(items: readonly DetachedParagraph[]): Promise<DetachedReport> {
    const began = performance.now();
    const generation = captureGeneration;
    if (busy() || items.length === 0) return { ms: 0, sent: 0, chars: 0, scored: 0, retired: false, down: backend.down };
    const given = items.map((p) => ({ id: `d${(detachedSeq++).toString(36)}`, text: p.text, order: p.order, p }));
    let sent = 0, chars = 0;
    const read = await readInWindows(given, async (blocks, owners) => {
      const cached = new Set(blocks.filter((b) => cache.get(b.text)).map((b) => b.id));
      const out = await scoreBlocks(blocks, owners, "background", generation);
      const engine = engineRead(blocks, cached, out);
      sent += engine.sent;
      chars += engine.chars;
      return out;
    }, countTokensFor(generation)).catch(() => new Map<string, WindowVerdict[]>());
    if (generation !== captureGeneration) return { ms: performance.now() - began, sent, chars, scored: 0, retired: true, down: backend.down };
    let scored = 0;
    for (const { id, text, p } of given) {
      const windows = read.get(id);
      if (!windows?.length) continue;
      const verdict = unitVerdict(id, text.length, windows);
      if (verdict.result.degraded) continue;
      kept.keep(p, verdict.result);
      scored++;
    }
    if (scored > 0) updateToolbar();
    return { ms: performance.now() - began, sent, chars, scored, retired: false, down: backend.down };
  }

  /**
   * Blocks in, results out, by block id: cache-first, local language gate, then batched
   * requestScores() for the misses, in slices the worker takes (requestSlices — one, but
   * for a unit read in dozens of windows). A block is a whole unit or one window of a
   * long one and is treated the same either way — per-window text is what gets cached,
   * gated and deduplicated. So when some windows of a unit are cache hits and others are
   * not, only the missing ones travel; and when one window comes back degraded, its
   * siblings are cached all the same (each is a true answer about its own text), which
   * makes the retry ask for the failed window alone.
   */
  async function scoreBlocks(
    blocks: ScoreBlock[],
    owners: ReadonlyMap<string, string>,
    lane: Lane,
    generation: number,
  ): Promise<Map<string, ScoreResult>> {
    const current = () => generation === captureGeneration;
    if (!current()) return new Map();
    const out = new Map<string, ScoreResult>();
    const misses: ScoreBlock[] = [];

    const candidates: ScoreBlock[] = [];
    for (const b of blocks) {
      const hit = cache.get(b.text);
      if (hit) out.set(b.id, { ...hit, id: b.id });
      else candidates.push(b);
    }
    // Confidently non-English paragraphs are settled here (browser CLD) — the daemon's
    // fastText gate would refuse them anyway, so they never cost a round trip.
    const gate = await Promise.all(candidates.map((b) => detectUnsupported(b.text)));
    if (!current()) return new Map();
    candidates.forEach((b, i) => {
      const g = gate[i];
      if (g) {
        const r = unsupportedResult(b.id, g.lang, g.prob);
        cache.set(b.text, r);
        out.set(b.id, r);
      } else {
        misses.push(b);
      }
    });

    if (misses.length > 0) {
      // The chip appears in its "analyzing…" state the moment real work starts
      // (cache hits render instantly and never flash it). Skipped in flagged-only
      // mode — most pending chips would pop in and vanish again.
      if (visible && displayMode === "all") {
        for (const unitId of new Set(misses.map((b) => owners.get(b.id)))) {
          const unit = unitId ? unitsById.get(unitId) : undefined;
          if (!unit) continue;
          // A pending chip is an insertion like any other: on a page that has still to
          // hydrate it waits with the rest (see whenSafeToInsert).
          whenSafeToInsert(() => {
            if (!current() || !unitsById.has(unit.id) || verdictsById.has(unit.id)) return; // gone, or answered
            try {
              badges.renderPending(unit);
            } catch {
              /* detached mid-flight — purge will collect it */
            }
          });
        }
      }
      // Dedup the REQUEST by text: score each unique text once, then fan the result
      // out to every block sharing it — duplicate paragraphs each still get a badge.
      const repByKey = new Map<string, ScoreBlock>();
      const idsByKey = new Map<string, string[]>();
      for (const b of misses) {
        const k = cache.keyOf(b.text);
        if (!repByKey.has(k)) {
          repByKey.set(k, b);
          idsByKey.set(k, []);
        }
        idsByKey.get(k)!.push(b.id);
      }

      for (const slice of requestSlices([...repByKey], ([, rep]) => rep.text.length)) {
        const req: ScoreBatchRequest = {
          v: CONTRACT_VERSION,
          session,
          priority: lane,
          blocks: slice.map(([, rep]) => rep),
        };
        const reply = await requestScores(req);
        if (!current()) return new Map();
        const fresh = reply.results;
        backend.heard(reply.backend);
        // The reply names the backend that produced it — adopt it, dropping whatever the
        // previous one left behind (both cached and already painted).
        adoptBackend(reply.model ?? null);
        if (!current()) return new Map(); // adoption may have retired this scan
        // Turned down, and it would be turned down again: these are Unavailable now,
        // instead of units without a verdict that every idle prefetch pass asks for anew.
        const byId = new Map(
          reply.backend === "refused"
            ? req.blocks.map((b) => [b.id, unavailableResult(b.id)] as const)
            : fresh.map((r) => [r.id, r] as const),
        );
        for (const [k, rep] of slice) {
          const r = byId.get(rep.id);
          if (!r) continue;
          if (!r.degraded) cache.set(rep.text, r); // fallbacks must not outlive the outage
          for (const id of idsByKey.get(k)!) out.set(id, { ...r, id });
        }
        // Dead extension context: no future request can ever succeed. Freeze in
        // place — existing verdicts stay readable, everything else goes quiet.
        if (fresh.length === 0 && !contextAlive()) {
          freeze();
          break;
        }
      }
    }
    return out;
  }

  /**
   * The extension context was invalidated under us (update/reload). Stop all
   * observation, scheduling and timers WITHOUT tearing down rendered badges —
   * the reader keeps what was analyzed; new content simply stops being scored.
   */
  let frozen = false;
  function freeze(): void {
    if (frozen) return;
    frozen = true;
    captureGeneration++;
    try {
      observers.stop();
      scheduler.stop();
      reading.stop(false); // no message can reach the worker any more
    } catch {
      /* observers may be half-dead — freezing must never throw */
    }
    unwatchUrl();
    backend.halt();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    pace?.watch(false);
    fling.watch(false);
  }

  // --- dispatch: held while the daemon is down or nobody can see the tab -----------------

  /** Queued units wait (in-flight batches finish) for as long as either reason holds. */
  function syncDispatch(): void {
    if (backend.down || pageHidden) scheduler.pause();
    else scheduler.resume();
  }

  /** A hidden tab asks the engine for nothing — no chip there can be read — and picks up
   *  where it was when it is shown again, as Firefox's full-page translation does. */
  function onVisibilityChange(): void {
    pageHidden = document.visibilityState === "hidden";
    syncDispatch();
  }

  // --- daemon down / back: lib/capture/backendWatch.ts --------------------------------

  /**
   * Adopt the identity of the backend that answered. A different one than this tab's L1
   * cache belongs to means every entry — and every verdict already on the page — is the
   * previous model's, so both go and the page is derived again. Afterwards l1Dim names
   * the new backend, so the rescan's own replies cannot start this over.
   */
  function adoptBackend(m: ModelInfo | null): void {
    if (!m) return;
    const dim = modelDim(m);
    if (dim === l1Dim) return;
    const previous = l1Dim;
    l1Dim = dim;
    if (previous === null) return; // first answer in this frame — nothing to drop
    log.log("backend changed", previous, "→", dim, "— dropping", cache.size(), "L1 entries");
    forgetCached();
    if (started) rescan();
  }

  /** Forget every degraded verdict and let the observers re-dispatch those units. */
  function retryUnavailable(): void {
    let n = 0;
    for (const [id, v] of [...verdictsById]) {
      if (!v.result.degraded) continue;
      const unit = unitsById.get(id);
      if (!unit) continue;
      badges.remove(id);
      clearHighlight(id);
      verdictsById.delete(id);
      unit.isScored = false;
      observers.observeUnit(unit);
      n++;
    }
    if (n > 0) {
      schedulePrefetch();
      updateToolbar();
      log.log("re-queued", n, "unavailable units");
    }
  }

  function retryBackend(): void {
    if (!started) return;
    if (backend.down) void backend.check(true);
    else retryUnavailable();
  }

  /** The worker pushes setup progress to paused pages
   *  (lib/backend/setupFeed.ts); whatever comes after the download is asked for at once. */
  function setupProgress(setup: EngineSetup | null): boolean {
    if (!started || frozen || !backend.down) return false;
    if (setup?.state !== "downloading") void backend.check(false);
    return true;
  }

  /**
   * The worker's caches were cleared, so this layer — which answers before them — has to go
   * too. Nothing is re-scanned or repainted: the verdicts on the page were real when they
   * were made, and the user cleared the caches to affect what happens NEXT. What was being
   * scored is asked for again (see send()); the worker gave up its own share of that work
   * when it cleared, before it said so (router.invalidate in lib/backend/router.ts).
   */
  function forgetCached(): void {
    captureGeneration++;
    cache.clear();
  }

  /**
   * Scheduler render(): id-keyed badge paint + per-window underline. A unit invalidated
   * while its batch was in flight is gone from unitsById (a changed paragraph comes back
   * as a NEW unit with a new id), so a verdict whose window offsets describe the old text
   * can never be painted onto the new one.
   */
  function render(verdicts: UnitVerdict[], _epoch: number): void {
    for (const v of verdicts) {
      const unit = unitsById.get(v.id);
      if (!unit) continue; // invalidated while the batch was in flight
      verdictsById.set(v.id, v);
      unit.isScored = true;
      observers.dropUnit(unit); // analyzed — stop viewport tracking
      reading.verdict(unit, v.result);
    }
    // A verdict is KNOWN the moment it arrives; PAINTING it touches the page, and on a
    // page that has still to hydrate that waits (see whenSafeToInsert). Scoring early
    // costs the page nothing, so the latency is bought back either way.
    whenSafeToInsert(() => paint(verdicts));
    updateToolbar();
  }

  /** Put the verdicts on the page. Re-entrant: what it paints is decided when it runs, not
   *  when it was queued, so a unit invalidated or re-answered while the insertion gate was
   *  closed is simply skipped. */
  function paint(verdicts: UnitVerdict[]): void {
    for (const v of verdicts) {
      const unit = unitsById.get(v.id);
      if (!unit || verdictsById.get(v.id) !== v) continue; // gone, or already superseded
      if (!visibleUnderMode(v)) {
        // Analyzed but not painted (flagged-only, another language): nor is its pending chip.
        badges.remove(v.id);
        clearHighlight(v.id);
        continue;
      }
      try {
        badges.render(unit, v);
        mark(unit, v);
      } catch (e) {
        log.warn("render failed for", v.id, e);
      }
    }
    badges.setVisible(visible);
    setHighlightsVisible(visible && highlightsEnabled);
    updateToolbar();
  }

  /** Repaint everything under a new display mode (results are all cached). */
  function applyDisplayMode(v: "all" | "flagged"): void {
    if (v === displayMode) return;
    displayMode = v;
    repaintAll();
  }

  /** Flag from another word: what is counted, listed, shown under "Flagged only" and underlined. */
  function applyFlagFrom(v: unknown): void {
    const next = flagFromOf(v);
    if (next === flagFrom) return;
    flagFrom = next;
    repaintAll();
    updateToolbar();
  }

  function applyUnderlineScope(v: unknown): void {
    const next = v === "all" ? "all" : "flagged";
    if (next === underlineScope) return;
    underlineScope = next;
    repaintAll();
  }

  function repaintAll(): void {
    for (const [id, verdict] of verdictsById) {
      const unit = unitsById.get(id);
      if (!unit) continue;
      if (visibleUnderMode(verdict)) {
        try {
          badges.render(unit, verdict);
          mark(unit, verdict);
        } catch {
          /* detached mid-flight — purge will catch it */
        }
      } else {
        badges.remove(id);
        clearHighlight(id);
      }
    }
    badges.setVisible(visible);
    setHighlightsVisible(visible && highlightsEnabled);
  }

  function updateToolbar(): void {
    void notifyToolbarBadge(flaggedCount());
  }

  /** Per-tab flagged count on the toolbar icon (top frame owns the tab's number). Settles
   *  once the worker has it, or could not be told. */
  function notifyToolbarBadge(flagged: number): Promise<void> {
    if (!toolbarOwner || flagged === lastBadgeSent) return Promise.resolve();
    lastBadgeSent = flagged;
    return sendDocumentMessage({ action: ACTIONS.UPDATE_BADGE, flagged })
      .then(() => undefined, () => undefined);
  }

  /** The engine scores on the processor (BackendStatus.server.device), as its status last said. */
  let onProcessor = false;
  function learnDevice(s: BackendStatus | undefined): void {
    const kind = deviceKind(s?.server?.device);
    if (kind) onProcessor = kind === "cpu";
    pace?.seed(s?.server?.device);
  }

  const scheduler: Scheduler = createScheduler<UnitVerdict>({
    batchCharBudget: laneBudgets(opts.oneUnitBatches ?? (() => onProcessor)),
    maxInFlight: PAGE_IN_FLIGHT,
    maxBackgroundInFlight: MAX_BACKGROUND_IN_FLIGHT,
    send,
    render,
    backgroundDelay: () => pace?.delay() ?? 0,
    foregroundDelay: () => fling.delay(),
    // A prefetch pass is capped (PREFETCH_PASS): keep draining while work is left.
    onIdle: () => {
      if (started && !frozen && !backend.down) schedulePrefetch();
    },
  });

  // --- observers ---------------------------------------------------------------------

  // The observers follow the reader both ways; the idle prefetch only ever enqueues, so it
  // never pulls down a unit the reader is looking at.
  const observers: Observers = createObservers({
    onVisible(unit) {
      scheduler.requeue(unit, "viewport");
    },
    onNear(unit) {
      scheduler.requeue(unit, "near");
    },
    onPlaced() {
      schedulePrefetch();
    },
    onFar(unit) {
      scheduler.requeue(unit, "background");
    },
    onDirty(nodes, removed, quiet) {
      return walkInTurn(() => handleDirty(nodes, removed, quiet)).catch((e) => {
        log.warn("dirty re-scan failed", e);
        return 0;
      });
    },
    onDocumentReplaced() {
      // document.open()/write() swapped <html> under us (challenge pages, legacy
      // SPAs): every element we held is detached — start over on the new tree.
      log.log("document replaced — restarting");
      if (!started) return;
      // The tree we were allowed to touch is not there any more, and what was waiting to
      // be drawn into it describes nothing: the NEW document decides the gate again.
      gate.reset();
      rescan();
    },
  });

  /** Resolves to what it cost the main thread, in ms: its time less the time its walks handed
   *  back to the page. */
  async function handleDirty(dirtyNodes: Node[], removed: Node[], quiet: Map<Text, Element> = new Map()): Promise<number> {
    const startedAt = performance.now();
    const meter = { waited: 0 };
    const spent = (): number => performance.now() - startedAt - meter.waited;
    const generation = captureGeneration;
    const seedQueue = new Set<Element>();
    const nodes = [...dirtyNodes];

    // 0') Text that changed without changing shape (lib/capture/observers.ts): it matters
    //     to a unit that owns it, and as the short text the coverage line counts, which is
    //     read again where it stood. Anything else could not make or unmake a unit, and
    //     costs no walk.
    for (const [n, parent] of quiet) {
      const owner = nodeOwner.get(n);
      if (owner && unitsById.has(owner.id)) {
        if (!n.isConnected || currentTextOf(owner) !== owner.text) invalidateUnit(owner, seedQueue);
      } else if (!n.isConnected && shortTexts.delete(n) && parent.isConnected) {
        nodes.push(parent);
      }
    }

    // 0) Direct hits: dirty/removed TEXT nodes owned by a live unit. This catches
    //    in-place characterData edits in MIDDLE parts and under nested inline
    //    wrappers, where the subtree-root containment test below cannot see them.
    for (const n of nodes.concat(removed)) {
      if (n.nodeType !== Node.TEXT_NODE) continue;
      const owner = nodeOwner.get(n as Text);
      if (!owner || !unitsById.has(owner.id)) continue;
      if (!(n as Text).isConnected || currentTextOf(owner) !== owner.text) {
        invalidateUnit(owner, seedQueue);
      }
    }

    // 1) Purge units whose DOM went away entirely (released parts get re-scanned).
    purgeDisconnected(seedQueue);

    // 2) Invalidate units whose text changed: a unit's text changes only where something
    //    changed inside one of its parts' containers, or around one. (The scan roots below
    //    are wider — a whole feed, for a post appended to it — and every unit in a feed
    //    read anew at every post grew with the feed.)
    const roots = computeScanRoots(nodes);
    const bases = nodes.flatMap((n) => {
      const el = n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
      return el?.isConnected ? [el] : [];
    });
    if (bases.length > 0) {
      // A part is touched where a base holds its container, or its container holds a base:
      // one climb from each, not a question of every base about every part.
      const underBase = heldBy(new Set(bases));
      const overBase = new Set<Node>();
      for (const b of bases) for (let at: Node | null = b; at && !overBase.has(at); at = at.parentNode) overBase.add(at);
      for (const unit of [...unitsById.values()]) {
        const touched = unit.parts.some((p) => overBase.has(p.container) || underBase(p.container));
        if (touched && currentTextOf(unit) !== unit.text) invalidateUnit(unit, seedQueue);
      }
    }

    // 3) Re-scan the dirty roots PLUS every container released by invalidations
    //    above (multi-part units span containers outside the mutation root).
    //    Stale-claim invalidations during scanning queue further rounds.
    const scanned = new Set<Element>();
    let queue: Element[] = boundRoots(dedupeRoots([...roots, ...seedQueue]));
    // What the burst itself was reduced to, before the rounds that stale claims add.
    const planned = queue.length;
    // The walks go only into the posts something changed in (CollectOptions.changed): the
    // burst's nodes, and the containers invalidations released.
    const changed: Node[] = [...nodes, ...seedQueue];
    for (let round = 0; round < 4 && queue.length > 0; round++) {
      const extra = new Set<Element>();
      const filter = makeClaimFilter(extra);
      for (const root of queue) {
        if (scanned.has(root) || !root.isConnected) continue;
        scanned.add(root);
        const units = await collect(root, filter, changed, meter);
        if (generation !== captureGeneration || !started) return spent();
        ingestUnits(units);
      }
      queue = [...extra].filter((r) => !scanned.has(r));
      changed.push(...queue);
    }
    updateToolbar();
    // What a page costs us over time is the sum of THIS line: how many walks a mutation
    // burst turned into — the ones it PLANNED (bounded by MAX_SCAN_ROOTS) and the ones
    // stale claims added afterwards — and how long they took. A number that climbs with
    // the page is the whole-container re-walk the scan-root rule exists to avoid.
    log.log(
      "dirty scan:", nodes.length, "dirty,", removed.length, "removed,",
      planned, "planned,", scanned.size, "roots,",
      Math.round(spent()), "ms,", quiet.size, "quiet",
    );
    return spent();
  }

  // --- URL / SPA navigation ------------------------------------------------------------

  /**
   * A same-document URL change. Two of them are not the same thing:
   *
   * A REWRITE of the current entry (replaceState; the Navigation API calls it "replace")
   * is usually not a navigation at all — Discourse rewrites the address with the number of
   * the post you are looking at on every scroll step, which answered a 90-second session
   * with 51 whole-document re-walks and 1 058 layouts where the page itself did 725. The
   * page did not change: the MutationObserver is what covers real DOM changes, and it
   * never missed one in the survey. So a rewrite that left every live unit connected is
   * answered by the purge alone: a fresh walk of the page on every scroll step is not worth it.
   *
   * Anything else — a pushed entry, a traversal, a popstate, a hash change — is a real route change and gets
   * the full refresh, debounced so that a burst of them is one walk.
   */
  function onUrlMaybeChanged(kind: "rewrite" | "route"): void {
    if (!started || location.href === lastHref) return;
    lastHref = location.href;
    const live = unitsById.size;
    purgeDisconnected();
    // Another path is another page view for the statistics: what is still on the page may be
    // read again in it. A query or a fragment that changes is the same page.
    const view = location.origin + location.pathname;
    if (view !== statsView) {
      statsView = view;
      reading.newView(unitsById.values());
    }
    if (kind === "rewrite" && unitsById.size === live) {
      updateToolbar();
      return;
    }
    scheduleUrlRefresh();
  }

  /** Purge what's gone, pick up what's new. Still-valid badges stay put (no flicker);
   *  MutationObserver covers the DOM swap itself. */
  function scheduleUrlRefresh(): void {
    if (urlRefreshTimer !== null) clearTimeout(urlRefreshTimer);
    urlRefreshTimer = setTimeout(() => {
      urlRefreshTimer = null;
      if (!started) return;
      // Another route is another document: its share of the engine's time starts again.
      pace?.newDocument();
      void walkInTurn(async () => {
        if (!started) return;
        purgeDisconnected();
        const generation = captureGeneration;
        const units = await collect(document.body, makeClaimFilter());
        if (generation !== captureGeneration || !started) return;
        ingestUnits(units);
        updateToolbar();
        log.log("url change refresh", location.href);
      });
    }, URL_REFRESH_DEBOUNCE_MS);
  }

  // --- visibility (instant, no re-detection) -------------------------------------------

  function setVisible(v: boolean): void {
    visible = v;
    badges.setVisible(v);
    setHighlightsVisible(v && highlightsEnabled);
  }

  function toggle(): void {
    if (!started) {
      start();
      return;
    }
    setVisible(!visible);
  }

  // --- lifecycle -----------------------------------------------------------------------

  function start(): void {
    if (started) return;
    if (!document.body) return;
    started = true;
    booted = false;
    visible = true;
    lastHref = location.href;
    pageHidden = document.visibilityState === "hidden";
    document.addEventListener("visibilitychange", onVisibilityChange);
    pace?.watch(true);
    fling.watch(true);
    syncDispatch();

    gate.watch();
    // The underline rules wait with the chips they paint, so that neither touches the
    // document before framework hydration is done with it.
    whenSafeToInsert(registerHighlightStyles);
    // Nothing is COLLECTED until the user's own settings have been read: see boot().
    void boot(++bootSeq);
  }

  /**
   * The asynchronous half of start(). The first collect has to run under the settings
   * the user chose, not under the defaults: scanning first and correcting afterwards
   * flashed "analyzing…" chips at a "Flagged only" reader and dispatched paragraphs a
   * reader with marks off never asked for, before tearing the whole page down again. `seq` retires a boot whose start() has
   * since been undone by a stop() or overtaken by a newer start().
   */
  async function boot(seq: number): Promise<void> {
    // Where the engine scores decides how much a request carries; the settings don't wait for it.
    void sendDocumentMessage({ action: ACTIONS.GET_BACKEND_STATUS })
      .then((s) => { if (seq === bootSeq) learnDevice(s as BackendStatus | undefined); }, () => undefined);
    // The statistics setting too, read beside the rest: the first walk then reports what it
    // leaves out and leaves short to a reading log that is already listening.
    const statsRead = Promise.resolve().then(() => settings.statsConfig.getValue()).catch(() => undefined);
    const [snapshot, statsValue] = await Promise.all([readSettings(), statsRead]);
    applySnapshot(snapshot);
    if (seq !== bootSeq || !started) return; // stopped or restarted while we waited

    watchSettings();
    observers.start();
    booted = true;
    statsView = location.origin + location.pathname;
    try {
      unwatchStats?.();
      unwatchStats = settings.statsConfig.watch(applyStatsConfig);
      unwatchLeaving?.();
      unwatchLeaving = beforeDocumentLeaves(() => reading.leave());
      applyStatsConfig(statsValue);
    } catch {
      /* dead extension context: no statistics either */
    }
    const generation = captureGeneration;
    await walkInTurn(async () => {
      const units = await collect(document.body, makeClaimFilter());
      if (generation === captureGeneration && started) ingestUnits(units);
    });
    if (seq !== bootSeq || !started) return;
    refreshCommentOffer();

    watchUrl();
    log.log("started", { session, domain });
  }

  /** The reader turned the statistics on or off, or chose to keep something else (Settings,
   *  Statistics). Never in a private window: the worker would not record it, and nothing need
   *  be measured for nothing. */
  function applyStatsConfig(value: unknown): void {
    const config = configOf(value);
    const wanted = started && config.on && !inPrivateWindow();
    if (wanted) reading.start(config.layers, () => unitsById.values(), () => shortTexts.values());
    else if (reading.running()) reading.stop(false);
  }

  /** One awaited read of every setting the first collect depends on. */
  async function readSettings(): Promise<SettingsSnapshot> {
    try {
      const [showHighlights, scope, mode, from] = await Promise.all([
        settings.showHighlights.getValue(),
        settings.underlineScope.getValue(),
        settings.displayMode.getValue(),
        settings.flagFrom.getValue(),
      ]);
      return {
        showHighlights,
        underlineScope: scope === "all" ? "all" : "flagged",
        displayMode: mode,
        flagFrom: flagFromOf(from),
      };
    } catch (e) {
      // Storage throws once the extension context is invalidated (reload/update).
      log.warn("settings unreadable — booting with the defaults", e);
      return DEFAULT_SNAPSHOT;
    }
  }

  /**
   * Adopt the snapshot in place. Nothing has been collected yet, so none of these values
   * needs the repaint or the re-scan its live watcher performs.
   */
  function applySnapshot(s: SettingsSnapshot): void {
    highlightsEnabled = s.showHighlights;
    underlineScope = s.underlineScope;
    displayMode = s.displayMode;
    flagFrom = s.flagFrom;
    setHighlightsVisible(visible && highlightsEnabled);
  }

  /** Live changes from here on, exactly as they behaved before the snapshot existed. */
  function watchSettings(): void {
    try {
      unwatchHighlights?.();
      unwatchHighlights = settings.showHighlights.watch(applyHighlightSetting);
      unwatchDisplay?.();
      unwatchDisplay = settings.displayMode.watch(applyDisplayMode);
      unwatchFlagFrom?.();
      unwatchFlagFrom = settings.flagFrom.watch(applyFlagFrom);
      unwatchUnderlineScope?.();
      unwatchUnderlineScope = settings.underlineScope.watch(applyUnderlineScope);
    } catch (e) {
      // Dead extension context: the page keeps the settings it booted with.
      log.warn("settings watchers unavailable", e);
    }
  }

  const onRouteChanged = (): void => onUrlMaybeChanged("route");
  /** `currententrychange` carries the navigation that caused it — "push", "replace",
   *  "reload", "traverse" — or nothing at all when the entry was merely updated
   *  (navigation.updateCurrentEntry), which is a rewrite by another name. */
  const onEntryChanged = (e: Event): void => {
    const how = (e as Event & { navigationType?: string | null }).navigationType;
    onUrlMaybeChanged(how === "replace" || how === undefined || how === null ? "rewrite" : "route");
  };

  function watchUrl(): void {
    window.addEventListener("popstate", onRouteChanged);
    window.addEventListener("hashchange", onRouteChanged);
    navigationApi().addEventListener("currententrychange", onEntryChanged);
  }

  function unwatchUrl(): void {
    window.removeEventListener("popstate", onRouteChanged);
    window.removeEventListener("hashchange", onRouteChanged);
    navigationApi().removeEventListener("currententrychange", onEntryChanged);
    if (urlRefreshTimer !== null) {
      clearTimeout(urlRefreshTimer);
      urlRefreshTimer = null;
    }
  }

  function applyHighlightSetting(v: boolean): void {
    highlightsEnabled = v;
    if (v) {
      for (const [id, verdict] of verdictsById) {
        const unit = unitsById.get(id);
        if (unit && visibleUnderMode(verdict)) {
          try {
            mark(unit, verdict);
          } catch {
            /* detached mid-flight — purge will catch it */
          }
        }
      }
    } else {
      for (const id of [...unitsById.keys()]) clearHighlight(id);
    }
    setHighlightsVisible(visible && v);
  }

  function clearAllResults(): void {
    reading.drop();
    for (const id of unitsById.keys()) clearHighlight(id);
    badges.teardownAll();
    flaggedCursor = null; // the ids it names are about to stop existing
    unitsById = new Map();
    verdictsById = new Map();
    kept.clear();
    pendingJump = null;
    shortTexts.clear();
    nodeOwner = new WeakMap();
    scopesRead = new WeakSet();
  }

  function stop(): void {
    if (!started) return;
    // What was read goes out before the units it was read in are let go.
    reading.stop();
    unwatchStats?.();
    unwatchStats = null;
    unwatchLeaving?.();
    unwatchLeaving = null;
    captureGeneration++;
    started = false;
    booted = false;
    // Whatever was waiting for the page to be safe to touch is not wanted any more: the
    // run is over and everything it drew is about to be taken down.
    gate.reset();
    observers.stop();
    scheduler.stop();
    backend.reset();
    document.removeEventListener("visibilitychange", onVisibilityChange);
    pace?.watch(false);
    fling.watch(false);
    commentOffer = [];
    commentAsked++;
    clearAllResults();
    // Every text node the walker cut gets its text back: a page Anagram has left is the
    // page its own script wrote.
    restoreSplits();
    setHighlightsVisible(false);
    unwatchUrl();
    unwatchHighlights?.();
    unwatchHighlights = null;
    unwatchDisplay?.();
    unwatchDisplay = null;
    unwatchFlagFrom?.();
    unwatchFlagFrom = null;
    unwatchUnderlineScope?.();
    unwatchUnderlineScope = null;
    // The worker is still at this run's batches, and a new document session is what makes
    // it drop them. Only once the toolbar count is cleared, and only if nothing has started
    // again or replaced the session meanwhile: a page analyzed on a one-off grant is
    // authorized by the session it has, and every way back into it grants the new one
    // afresh (ensureInjected in lib/access/worker.ts). A rescan keeps its session — its
    // requests for text that has not changed join the batches the worker is running.
    const session = documentSessionId();
    const abandon = (): void => {
      if (!started && documentSessionId() === session) cancelDocumentSession();
    };
    void notifyToolbarBadge(0).then(abandon);
    log.log("stopped");
  }

  function rescan(): void {
    if (!started) {
      start();
      return;
    }
    // Between start() and the first collect there is nothing to re-derive, and scanning
    // here would do it under the defaults — which is the very thing boot() avoids. The
    // boot's own collect, moments away, is the rescan.
    if (!booted) return;
    captureGeneration++;
    scheduler.bumpEpoch();
    for (const unit of [...unitsById.values()]) observers.dropUnit(unit);
    clearAllResults();
    cache.clear(); // a rescan must re-derive every verdict from the current backend
    gate.dropHeld(); // they paint units this rescan has just dropped
    gate.watch(); // no-op unless the gate was reset with the document
    whenSafeToInsert(registerHighlightStyles); // no-op unless the page let go of the rules
    badges.resetTheme(); // the site theme may have toggled since the last scan
    refreshHighlightTheme();
    const generation = captureGeneration;
    void walkInTurn(async () => {
      const units = await collect(document.body, makeClaimFilter());
      if (generation !== captureGeneration || !started) return;
      ingestUnits(units);
      updateToolbar();
      log.log("rescan");
    });
  }

  function refresh(): void {
    if (!started || !booted) return;
    void walkInTurn(async () => {
      if (!started) return;
      purgeDisconnected();
      const generation = captureGeneration;
      const seen = new Set<string>();
      const fresh = await collect(document.body, makeClaimFilter(undefined, seen));
      if (generation !== captureGeneration || !started) return;
      refreshWith(fresh, seen);
    });
  }

  function refreshWith(fresh: Unit[], seen: Set<string>): void {
    ingestUnits(fresh);
    // A unit the surface no longer hands out is one its new reading drew otherwise — the PDF
    // reader's quick reflow read a figure's caption as prose, Zotero's structure does not —
    // and goes, though its text is still on the page.
    for (const unit of fresh) seen.add(unit.id);
    for (const unit of [...unitsById.values()]) if (!seen.has(unit.id)) invalidateUnit(unit);
    // A surface may take a chip down with the layer it lived in (pdf.js empties a page it
    // re-lays at a new zoom) while the unit itself stays: draw it again from its verdict.
    const lost = [...verdictsById.values()].filter((v) => !badges.placed(v.id));
    if (lost.length) whenSafeToInsert(() => paint(lost));
    updateToolbar();
  }

  function scoredCount(): number {
    return verdictsById.size;
  }

  function flaggedCount(): number {
    let n = 0;
    for (const v of verdictsById.values()) if (flagged(v.result)) n++;
    for (const k of keptNow()) if (flagged(k.result)) n++;
    return n;
  }

  function unsupportedCount(): number {
    let n = 0;
    for (const v of verdictsById.values()) if (v.result.unsupported) n++;
    return n;
  }

  /** Degraded verdicts are the daemon's silence, not an analysis — counted apart. */
  function unavailableCount(): number {
    let n = 0;
    for (const v of verdictsById.values()) if (v.result.degraded) n++;
    return n;
  }

  return {
    start,
    stop,
    rescan,
    refresh,
    toggle,
    scoredCount,
    flaggedCount,
    unsupportedCount,
    unavailableCount,
    setPageAction,
    scoreDetached,
    knows,
    onScreen,
    busy,
    pageReport,
    runPageAction,
    jumpToResult,
    retryBackend,
    setupProgress,
    forgetCached,
    jumpFlagged,
  };
}

/** Any part of the element on screen right now. */
function intersectsViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.top < (window.innerHeight || 0);
}

/** Merge scan roots, dropping disconnected ones and any contained by another. */
function dedupeRoots(all: Element[]): Element[] {
  const uniq = new Set(all.filter((el) => el.isConnected));
  const held = heldBy(uniq);
  return [...uniq].filter((r) => !held(r.parentNode));
}

/**
 * Whether one of `holders` is `node` or an ancestor of it, as contains() has it (in the
 * node's own tree). Every node a question climbs through is remembered, so the questions
 * about a burst cost one climb through the part of the page they pass, however many there
 * are: asking each holder about each node cost their product, and a page that changed
 * fifty thousand nodes at once held its main thread for minutes.
 */
function heldBy(holders: ReadonlySet<Node>): (node: Node | null) => boolean {
  const known = new Map<Node, boolean>();
  return (node) => {
    const path: Node[] = [];
    let held = false;
    for (let at = node; at; at = at.parentNode) {
      const k = known.get(at);
      if (k !== undefined || holders.has(at)) {
        held = k ?? true;
        break;
      }
      path.push(at);
    }
    for (const n of path) known.set(n, held);
    return held;
  };
}

/**
 * How many separate walks one mutation burst may become. EVERY walk pays a price over the
 * whole document, not over its root: lib/dom/scope.ts surveys the page for bylines once
 * per walk, and the computed styles and boxes it resolves are cached per walk. So narrow
 * roots are cheaper only while there are FEW of them. Measured on dev.to, which re-renders
 * its Preact islands continuously rather than only appending: a drain there carries some
 * 200 dirty nodes, walking 200 roots cost 1.4-2.0 s of main thread every time, and ONE
 * walk of the container they share costs about 40 ms on the same page. A walk of an
 * 11 000-element page is worth roughly ten byline surveys of it, so past ten roots a burst
 * is cheaper merged than kept apart.
 */
const MAX_SCAN_ROOTS = 10;

/**
 * Map a batch of dirty nodes to the elements to re-walk: climb one level above each dirty
 * node, then drop any root contained by another to avoid redundant overlapping scans.
 *
 * The climb is there because GROUPING NEEDS SIBLINGS: "one voice, one verdict" merges the
 * short paragraphs of a post, so a paragraph inserted into a comment is only read
 * correctly together with the ones already beside it, and an edited text node needs the
 * block it lives in.
 *
 * What was missing is a bound on how many walks that becomes, and it was most of what this
 * extension cost a live page. A node that arrives as a whole post can be walked by itself
 * — nothing outside a post takes part in what its text becomes — but that was measured and
 * is NOT worth having: it saves a fifth of the scanning on a feed that only ever appends,
 * and costs a whole-document byline survey on every mutation of a page that does not (0.71
 * s of scripting on a Wikipedia article became 1.18 s, against 0.77 s with the plain
 * climb). The bound, which needs no survey at all, is where the win is.
 */
function computeScanRoots(nodes: Node[]): Element[] {
  const roots = new Set<Element>();
  for (const n of nodes) {
    const base: Element | null =
      n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
    if (!base || !base.isConnected) continue;
    roots.add(base.parentElement ?? base);
  }
  return dedupeRoots([...roots]);
}

/**
 * Keep a burst to at most MAX_SCAN_ROOTS walks by merging its roots upward. One level at
 * a time rather than straight to the common ancestor, so a comment thread and a sidebar
 * ticker that both changed stay two walks for as long as they can instead of becoming one
 * walk of the whole page. It always terminates: every round moves each root that still
 * has a parent one level up, and the climb ends at the scan base.
 */
function boundRoots(roots: Element[]): Element[] {
  const top = document.body ?? document.documentElement;
  let all = roots;
  while (all.length > MAX_SCAN_ROOTS && all.some((r) => r !== top && r.parentElement !== null)) {
    all = dedupeRoots(all.map((r) => (r === top ? r : (r.parentElement ?? r))));
  }
  return all;
}
