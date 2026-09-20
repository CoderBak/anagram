// lib/capture/orchestrator.ts — ties walker + observers + scheduler + cache +
// messaging + renderer + the floating toggle into the live capture→annotate loop.
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
import { browser } from "#imports";
import type { ContentScriptContext } from "#imports";
import { ACTIONS } from "../messaging/protocol";
import type { BackendStatus } from "../messaging/protocol";
import type { Unit, Lane } from "../types";
import type { ModelInfo, ScoreBlock, ScoreResult, ScoreBatchRequest } from "../contract";
import { CONTRACT_VERSION } from "../contract";
import { collectUnits, type CollectOptions } from "../dom/walker";
import { findMainContent, useReadability } from "../dom/mainContent";
import { loadReadability } from "../lazy";
import { partTextOf, MAX_UNIT_TEXT_CHARS } from "../dom/text";
import { createObservers, type Observers } from "./observers";
import { createScheduler, type Scheduler } from "./scheduler";
import { createScoreCache, type ScoreCache } from "./cache";
import { readInWindows, unitVerdict, type UnitVerdict } from "./windows";
import { detectUnsupported, unsupportedResult } from "./langGate";
import { requestScores, contextAlive, lastModel } from "../messaging/client";
import { modelDim } from "../backend/router";
import { createBadgeLayer, type BadgeLayer, type BadgeLayerOptions } from "../render/badge";
import {
  setHighlight,
  clearHighlight,
  registerHighlightStyles,
  setHighlightsVisible,
  setMarkStyle,
  refreshHighlightTheme,
  type MarkStyle,
} from "../render/highlight";
import { createFab, type Fab, type PanelCounts } from "../render/fab";
import { t, tn } from "../i18n";
import { band, bandLabel, BUCKET_BANDS, isFlagged } from "../render/band";
import { formatScore } from "../render/score";
import { windowReadout } from "../render/coverage";
import { normalizeMarkStyle, settings } from "../settings/settings";
import { createLogger } from "../log";

const log = createLogger("orchestrator");

// Per-lane batch sizes (chars): the viewport lane favours time-to-first-chip, the
// background prefetch lane favours model throughput (see scheduler.ts).
const BATCH_CHAR_BUDGET = { viewport: 2400, near: 4000, background: 6000 } as const;
const MAX_IN_FLIGHT = 4;
/** Background prefetch may hold at most this many of the in-flight slots. */
const MAX_BACKGROUND_IN_FLIGHT = 1;
/** Units enqueued per idle prefetch pass (huge pages drain in successive passes). */
const PREFETCH_PASS = 300;
// The Navigation API (window.navigation, Chrome 102+) fires `currententrychange` for
// every same-document navigation — pushState/replaceState included — and is reachable
// from the content script's isolated world, so no MAIN-world history patch is needed.
// Where it is missing (Firefox before it shipped the API; it is there in 156) a slow URL
// poll covers pushState instead.
const URL_POLL_MS = 2500;
/** A route change is answered once, not once per entry: frameworks that push and then
 *  correct the address (a redirect, a canonical slug, a query the router rewrites) fire
 *  several changes in a row, and one walk answers all of them. */
const URL_REFRESH_DEBOUNCE_MS = 300;
/** While the daemon is down: how often the content script asks the worker to re-probe. */
const DOWN_POLL_MS = 5000;
/** How long the first collect waits for the Readability chunk under "main" scope. */
const READABILITY_BOOT_MS = 1500;

/**
 * Pages that are rendered on a server and HYDRATED in the browser check the markup they
 * were served against what the framework renders now, and a chip host inserted into that
 * tree before the check makes React log its recoverable #418 and render the subtree again
 * (jestjs.io in three runs of three, nextjs.org in two — never on the same page without
 * us). Nothing visible broke, but we are not going to be the reason a page's console has
 * errors in it. These are the roots and payload scripts such a page carries, read once
 * from our own world: whether React has FINISHED hydrating is only legible from the main
 * world, through the `__reactFiber$…` keys it hangs on the nodes it owns, and injecting a
 * script into somebody's page to look is not something a reading tool should do. So the
 * gate is a timing one, and the list is kept short on purpose — every entry costs every
 * page one selector match, and a page not on it keeps exactly today's behaviour.
 */
const HYDRATION_MARKERS = [
  "#__next", // Next.js pages router
  "script#__NEXT_DATA__",
  'script[src*="/_next/"]', // Next.js app router: no #__next, but every page loads these
  "#__docusaurus",
  "#___gatsby",
  "#__nuxt",
  "[data-server-rendered]", // Nuxt 2 and Vue SSR
  "[data-reactroot]", // React 17 and earlier
  "astro-island",
  "[data-sveltekit-preload-data]",
  "[ng-server-context]", // Angular Universal
].join(",");
/** Idle is what hydration finishing looks like from outside: the framework has run and
 *  given the main thread back. Requested with a timeout so a page that never idles still
 *  reaches the gate. */
const HYDRATION_IDLE_MS = 1200;
/** And in any case chips appear within this long of the run starting. A live page (a
 *  ticker, a video, a feed still loading images) may never be idle, and a reader who can
 *  see the text is owed the numbers. */
const HYDRATION_MAX_MS = 2500;

function navigationApi(): EventTarget | null {
  const n = (window as unknown as { navigation?: EventTarget }).navigation;
  return n && typeof n.addEventListener === "function" ? n : null;
}

export interface Orchestrator {
  /** Begin capture: initial scan + observers + scheduler + floating toggle. Idempotent. */
  start(): void;
  /** Full teardown: disconnect observers, bump epoch, remove all badges + the toggle. */
  stop(): void;
  /** Force a fresh full scan (popup "Rescan"): drop everything, re-collect. */
  rescan(): void;
  /** Toggle the overlay's visibility (the floating button). First call also scans. */
  toggle(): void;
  /** Number of units that have rendered a badge (popup GET_TAB_STATE). */
  scoredCount(): number;
  /** Number of units flagged heavily edited / AI-generated (popup GET_TAB_STATE). */
  flaggedCount(): number;
  /** Number of units skipped as an unsupported language (popup GET_TAB_STATE). */
  unsupportedCount(): number;
  /** Number of units left with a degraded "Unavailable" verdict (popup GET_TAB_STATE). */
  unavailableCount(): number;
  /** Configure the FAB's secondary action chip (Google Docs reading view etc.). */
  setFabAction(label: string | null, onAction?: () => void, opts?: { attention?: boolean }): void;
  /** Popup/panel "Retry": re-probe the daemon now; re-queue every "Unavailable" unit. */
  retryBackend(): void;
  /** Drop the per-tab verdict cache and leave the page exactly as it is (options →
   *  "Clear cached verdicts"): the next scan or Rescan asks the backend again. */
  forgetCached(): void;
  /** Keyboard command: open the triage panel and hand it the focus. */
  openPanel(): void;
  /** Keyboard command: scroll to the next (1) / previous (-1) flagged paragraph. */
  jumpFlagged(dir: 1 | -1): void;
}

function newSessionId(): string {
  return "s_" + Math.random().toString(36).slice(2, 10);
}

/** Everything the FIRST collect depends on, read as one snapshot before it runs. */
interface SettingsSnapshot {
  showHighlights: boolean;
  displayMode: "all" | "flagged";
  mergeShorts: boolean;
  markStyle: MarkStyle;
  analysisScope: "page" | "main";
}

/** Storage answered nothing (dead extension context) — boot with the shipped defaults. */
const DEFAULT_SNAPSHOT: SettingsSnapshot = {
  showHighlights: true,
  displayMode: "all",
  mergeShorts: true,
  markStyle: "quiet",
  analysisScope: "page",
};

export interface OrchestratorOptions {
  /** Mount the floating toggle. False in subframes — one FAB per TAB, in the top frame. */
  mountFab?: boolean;
  /**
   * Pin the analysis scope regardless of the user setting. Docs editor pages set
   * "page": the real content lives in our overlay's shadow root, which the
   * main-region probe cannot see into — "main" would mis-scope to app chrome.
   */
  lockScope?: "page";
  /**
   * What the copied report names as the page. The PDF reader is an extension page, so
   * its own address ("chrome-extension://…/reader.html?src=…") says nothing to whoever
   * reads the report — it passes the PDF's own URL instead.
   */
  reportUrl?: string;
  /**
   * The panel footer's "Turn off on <host>" was used. The rule is written by the footer
   * itself; this tells the OWNER of the page's on/off state to stop, which the settings
   * watch cannot always do — writing "off" where "off" is already stored changes nothing.
   */
  onSiteOff?: () => void;
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
}

export function createOrchestrator(
  // The context is part of the content-script contract and deliberately unused; the PDF
  // reader runs the same pipeline from an extension page, where there is no context.
  _ctx: ContentScriptContext | null,
  opts: OrchestratorOptions = {},
): Orchestrator {
  const mountFab = opts.mountFab ?? true;
  const cache: ScoreCache = createScoreCache();
  const badges: BadgeLayer = createBadgeLayer({ place: opts.placeBadge });

  let unitsById = new Map<string, Unit>();
  /**
   * Prose the walk found and left unread — under the evidence floor, with nobody of its
   * voice to join — kept as the FIRST text node of each such stretch. A node, not a
   * tally: a re-scan of the same subtree reports the same stretches again, and counting
   * them twice would inflate the panel's "short" the longer a reader stayed on a feed.
   * Entries leave when the node is taken into a unit (the reader opened a "see more" and
   * it now has neighbours) or when the DOM lets it go (purgeDisconnected).
   */
  const shortTexts = new Set<Text>();
  /** One verdict per analyzed unit — the aggregate everything counts by, plus its windows. */
  let verdictsById = new Map<string, UnitVerdict>();
  /** Text-node ownership: node → live unit. Recreated on stop/rescan. */
  let nodeOwner = new WeakMap<Text, Unit>();

  const session = newSessionId();
  const domain = location.hostname || "und";

  let started = false;
  /** True once the settings snapshot has been applied AND the first collect has run. */
  let booted = false;
  /** Boot generation: a stop()+start() pair must not let the older boot finish. */
  let bootSeq = 0;
  /** The Readability chunk is in the main-content detector's hands. */
  let readabilityLoaded = false;
  let visible = true;
  let highlightsEnabled = true;
  let displayMode: "all" | "flagged" = "all";
  let mergeShorts = true;
  let analysisScope: "page" | "main" = "page";
  /** Resolved scope root when analysisScope === "main"; null → whole page. */
  let scopeRoot: Element | null = null;
  let unwatchHighlights: (() => void) | null = null;
  let unwatchDisplay: (() => void) | null = null;
  let unwatchMerge: (() => void) | null = null;
  let unwatchMarkStyle: (() => void) | null = null;
  let unwatchScope: (() => void) | null = null;
  let lastBadgeSent = -1;
  /** Backend identity the L1 cache currently belongs to (from the last reply). */
  let l1Dim: string | null = null;
  let lastHref = location.href;
  let urlTimer: ReturnType<typeof setInterval> | null = null;
  /** A route change's refresh, waiting out the burst it arrived in. */
  let urlRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  /** The page's own tree may be touched: it carries no hydration marker, or the framework
   *  that owns it has had its turn (see HYDRATION_MARKERS). */
  let safeToInsert = false;
  /** Insertions held back until it is. */
  const heldInsertions: (() => void)[] = [];
  /** What the gate has armed to open itself with, so a teardown can take it all back. */
  let gateCap: ReturnType<typeof setTimeout> | null = null;
  let gateFallback: ReturnType<typeof setTimeout> | null = null;
  let gateIdle: number | null = null;
  let gateLoad: (() => void) | null = null;
  /** The daemon stopped answering: dispatch is paused until a probe succeeds. */
  let backendDown = false;
  let downTimer: ReturnType<typeof setInterval> | null = null;
  /** The flagged unit the last jump parked on. Without it a second next-flagged press
   *  would re-pick the paragraph the first one centred, since "the next one past the
   *  scroll position" is that very paragraph. */
  let flaggedCursor: string | null = null;

  const fab: Fab = createFab({
    onToggle: () => toggle(),
    onRetry: () => retryBackend(),
    panel: {
      entries: () =>
        [...verdictsById.entries()]
          .filter(([id, v]) => isFlagged(v.result) && unitsById.has(id))
          .map(([id, { result: r }]) => ({
            id,
            score: r.score,
            band: band(r),
            snippet: unitsById.get(id)!.text.slice(0, 70),
            order: unitsById.get(id)!.order,
          }))
          .sort((a, b) => a.order - b.order),
      counts: panelCounts,
      onJump: jumpTo,
      buildReport,
    },
    // The panel's "Turn off on <host>" writes the rule itself; the content script is what
    // knows whether this page is running because of the settings or because it was asked
    // for once, so it gets to end the run.
    onSiteOff: opts.onSiteOff,
  });

  /**
   * The coverage line's numbers. "Read" is verdicts the model really gave, so an outage
   * and a page of Chinese are both counted where they belong rather than passing for
   * analysis; "short" is what the walk found and left alone (see shortTexts).
   */
  function panelCounts(): PanelCounts {
    let read = 0;
    let notEnglish = 0;
    let unavailable = 0;
    for (const v of verdictsById.values()) {
      if (v.result.unsupported) notEnglish++;
      else if (v.result.degraded) unavailable++;
      else read++;
    }
    let pending = 0;
    for (const id of unitsById.keys()) if (!verdictsById.has(id)) pending++;
    return { read, short: shortTexts.size, notEnglish, pending, unavailable };
  }

  /** Centre a unit in the viewport and pulse its chip (panel rows and the
   *  next/previous-flagged commands land the same way). */
  function jumpTo(id: string): void {
    const unit = unitsById.get(id);
    if (!unit || !unit.container.isConnected) return;
    flaggedCursor = id;
    unit.container.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => badges.flash(id), 350); // pulse once the scroll settles
  }

  /** Flagged units still in the DOM, in document order. */
  function flaggedUnits(): Unit[] {
    const out: Unit[] = [];
    for (const [id, v] of verdictsById) {
      const unit = unitsById.get(id);
      if (unit && isFlagged(v.result) && unit.container.isConnected) out.push(unit);
    }
    return out.sort((a, b) => a.order - b.order);
  }

  function jumpFlagged(dir: 1 | -1): void {
    const list = flaggedUnits();
    if (list.length === 0) return;
    const at = flaggedCursor === null ? -1 : list.findIndex((u) => u.id === flaggedCursor);
    const onScreen = at >= 0 && intersectsViewport(list[at].container);
    let target: Unit;
    if (onScreen) {
      target = list[(at + dir + list.length) % list.length];
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
          ? (list.find((u) => mid(u) > ref + 4) ?? list[0])
          : ([...list].reverse().find((u) => mid(u) < ref - 4) ?? list[list.length - 1]);
    }
    jumpTo(target.id);
  }

  function openPanel(): void {
    if (started && mountFab) fab.openPanel(true);
  }

  /** Markdown summary of this page's verdicts — the triage panel's Copy report. */
  function buildReport(): string {
    const flagged = [...verdictsById.entries()]
      .filter(([id, v]) => isFlagged(v.result) && unitsById.has(id))
      .map(([id, v]) => ({ unit: unitsById.get(id)!, v, r: v.result }))
      .sort((a, b) => a.unit.order - b.unit.order);

    const lines: string[] = [];
    lines.push(`# ${t("reportTitle", document.title || location.hostname)}`);
    lines.push("");
    lines.push(`- ${t("reportPage", opts.reportUrl ?? location.href)}`);
    lines.push(`- ${t("reportGenerated", new Date().toLocaleString())}`);
    // "Analyzed" is real verdicts only. A paragraph the language gate refused and one
    // the daemon never answered for were both counted as analyzed before, which made
    // an outage look like a clean sweep.
    let skipped = 0;
    let unavailable = 0;
    for (const { result: r } of verdictsById.values()) {
      if (r.unsupported) skipped++;
      else if (r.degraded) unavailable++;
    }
    const analyzed = verdictsById.size - skipped - unavailable;
    lines.push(
      "- " +
        [
          tn("reportAnalyzed", analyzed),
          t("reportFlagged", flagged.length),
          ...(unavailable > 0 ? [t("reportUnavailable", unavailable)] : []),
          ...(skipped > 0 ? [t("reportSkipped", skipped)] : []),
        ].join(" · "),
    );
    lines.push("");
    // Every surface of the product says the number is an EXTENT of editing; the report
    // used to print it as "62% AI", which reads as a share of AI-written words. It now
    // carries the same 0–1 number the chips do and the card footer's own sentence to
    // read it by.
    lines.push(t("reportEstimate"));
    lines.push("");
    if (flagged.length === 0) {
      lines.push(t("reportNothingFlagged"));
    } else {
      lines.push(`## ${t("reportFlaggedHeading", flagged.length)}`);
      lines.push("");
      flagged.forEach(({ unit, v, r }, i) => {
        const score = formatScore(r.score);
        const dist = r.probs
          .map((p, i) => `${bandLabel(BUCKET_BANDS[i])} ${Math.round(p * 100)}%`)
          .join(" · ");
        const snippet = unit.text.replace(/\s+/g, " ").slice(0, 220);
        const ellipsis = unit.text.length > 220 ? "…" : "";
        // A long paragraph's score is an average over windows; whoever reads the
        // report without the page in front of them needs the parts it was made from.
        const read = windowReadout(v);
        const windows = read
          ? t("reportWindows", read.count, read.scores.join(" · ")) +
            (v.unreadChars > 0 ? t("reportUnread") : "")
          : "";
        lines.push(
          `${i + 1}. **${bandLabel(band(r))} · ${score}** ` +
            `(${dist}; ${t("reportWords", unit.wordCount)}${windows})`,
        );
        lines.push(`   > ${snippet}${ellipsis}`);
      });
    }
    lines.push("");
    const m = lastModel();
    const backend = m ? t("reportModel", m.id, m.ver) : t("reportNoModel");
    lines.push("---", backend);
    return lines.join("\n");
  }

  /** Painted under the current display mode? Everything is analyzed regardless. */
  function visibleUnderMode(v: UnitVerdict): boolean {
    return displayMode === "all" || isFlagged(v.result);
  }

  // --- analysis scope ----------------------------------------------------------------

  /** Re-detect the main-content region (scope "main"); body-wide otherwise. */
  function resolveScopeRoot(): void {
    scopeRoot = analysisScope === "main" ? findMainContent() : null;
  }

  /**
   * Fetch the on-demand Readability chunk once and hand it to the detector. Resolves
   * false when it cannot be loaded — the text-mass probe then answers alone, which is
   * also what happens for as long as the chunk is in flight.
   */
  async function loadReadabilityOnce(): Promise<boolean> {
    if (readabilityLoaded) return true;
    try {
      useReadability(await loadReadability());
      readabilityLoaded = true;
      log.log("Readability chunk loaded");
      return true;
    } catch (e) {
      log.warn("Readability chunk failed to load", e);
      return false;
    }
  }

  /** The element full scans start from under the current scope. */
  function scanBase(): Element | null {
    if (scopeRoot && scopeRoot.isConnected) return scopeRoot;
    if (scopeRoot) resolveScopeRoot(); // SPA replaced the region — re-detect
    return scopeRoot ?? document.body;
  }

  /** Under "main" scope, ignore dirty roots outside the region. */
  function inScope(el: Element): boolean {
    if (!scopeRoot) return true;
    if (!scopeRoot.isConnected) {
      resolveScopeRoot(); // stale region — re-detect before judging
      if (!scopeRoot) return true;
    }
    return scopeRoot.contains(el) || el.contains(scopeRoot);
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
    for (const node of shortTexts) if (!node.isConnected) shortTexts.delete(node);
    for (const unit of [...unitsById.values()]) {
      const gone =
        !unit.container.isConnected ||
        unit.parts.some((p) => {
          const first = p.nodes[0];
          const last = p.nodes[p.nodes.length - 1];
          return (first && !first.isConnected) || (last && !last.isConnected);
        });
      if (gone) invalidateUnit(unit, rescanQueue);
    }
  }

  /**
   * Walker ownership filter. "skip" when the run is an exact live part; otherwise
   * invalidate any stale owners (run grew/shrunk/split) and let the walker re-take.
   */
  function makeClaimFilter(rescanQueue?: Set<Element>) {
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
          const part = u.parts.find((p) => p.nodes.includes(nodes[0]));
          if (
            part &&
            part.nodes.length === nodes.length &&
            part.nodes.every((n, i) => n === nodes[i])
          ) {
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

  /** One walk under `root`: shadow roots it descends into become observer targets. */
  function collect(root: ParentNode, claimFilter: (nodes: Text[]) => "take" | "skip"): Unit[] {
    const options: CollectOptions = {
      claimFilter,
      mergeShorts,
      onShortText: (nodes) => {
        if (nodes[0]) shortTexts.add(nodes[0]);
      },
      onShadowRoot: observers.observeRoot,
    };
    return opts.collect
      ? opts.collect(root, claimFilter, options)
      : collectUnits(root, options);
  }

  /** Register freshly collected units: claim their nodes, observe, index. */
  function ingestUnits(units: Unit[]): void {
    for (const u of units) {
      if (unitsById.has(u.id)) continue;
      unitsById.set(u.id, u);
      for (const part of u.parts) {
        for (const n of part.nodes) {
          nodeOwner.set(n, u);
          shortTexts.delete(n); // it found neighbours after all — it is read now
        }
      }
      observers.observeUnit(u);
    }
    schedulePrefetch();
  }

  // --- idle prefetch -----------------------------------------------------------------
  // Everything the observers have not yet asked for is scored in the background lane
  // during idle time, in document order, so by the time the reader scrolls there the
  // verdict is already cached (both here and in the daemon-side persistent cache).
  // The lane is lowest priority and capped to one in-flight batch, so it never delays
  // the viewport; a unit that scrolls into view meanwhile is simply upgraded.
  let prefetchScheduled = false;
  function schedulePrefetch(): void {
    if (prefetchScheduled || frozen) return;
    prefetchScheduled = true;
    const run = () => {
      prefetchScheduled = false;
      if (!started || frozen) return;
      let n = 0;
      const pending = [...unitsById.values()]
        .filter((u) => !u.isScored && !verdictsById.has(u.id))
        .sort((a, b) => a.order - b.order);
      for (const u of pending) {
        scheduler.enqueue(u, "background");
        if (++n >= PREFETCH_PASS) break;
      }
      if (n > 0) log.log("prefetch: queued", n, "of", pending.length, "unscored units");
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
  async function send(units: Unit[], lane: Lane): Promise<UnitVerdict[]> {
    const read = await readInWindows(units, (blocks, owners) => scoreBlocks(blocks, owners, lane));
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

  /**
   * Blocks in, results out, by block id: cache-first, local language gate, then one
   * batched requestScores() for the misses. A block is a whole unit or one window of a
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
  ): Promise<Map<string, ScoreResult>> {
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
            if (!unitsById.has(unit.id) || verdictsById.has(unit.id)) return; // gone, or answered
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

      const req: ScoreBatchRequest = {
        v: CONTRACT_VERSION,
        session,
        priority: lane,
        blocks: [...repByKey.values()],
      };
      const reply = await requestScores(req);
      const fresh = reply.results;
      if (reply.backend === "down") enterDown();
      else if (reply.backend === "up") leaveDown();
      // The reply names the backend that produced it — adopt it, dropping whatever the
      // previous one left behind (both cached and already painted).
      adoptBackend(lastModel());
      const byId = new Map(fresh.map((r) => [r.id, r] as const));
      for (const [k, rep] of repByKey) {
        const r = byId.get(rep.id);
        if (!r) continue;
        if (!r.degraded) cache.set(rep.text, r); // fallbacks must not outlive the outage
        for (const id of idsByKey.get(k)!) out.set(id, { ...r, id });
      }
      // Dead extension context: no future request can ever succeed. Freeze in
      // place — existing verdicts stay readable, everything else goes quiet.
      if (fresh.length === 0 && !contextAlive()) freeze();
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
    try {
      observers.stop();
      scheduler.stop();
    } catch {
      /* observers may be half-dead — freezing must never throw */
    }
    unwatchUrl();
    stopDownPolling();
  }

  // --- daemon down / back --------------------------------------------------------------
  // In-flight batches render "Unavailable" (degraded results, never cached). Nothing
  // else is dispatched until the worker's probe succeeds again; then every Unavailable
  // unit is re-observed so it re-dispatches by visibility, and the queue resumes.

  function enterDown(): void {
    if (backendDown) return;
    backendDown = true;
    scheduler.pause();
    fab.setBackendDown(true);
    if (downTimer === null) downTimer = setInterval(() => void checkBackend(false), DOWN_POLL_MS);
    log.warn("scoring daemon not answering — dispatch paused, re-checking every", DOWN_POLL_MS, "ms");
  }

  function leaveDown(): void {
    if (!backendDown) return;
    backendDown = false;
    stopDownPolling();
    fab.setBackendDown(false);
    scheduler.resume();
    retryUnavailable();
    log.log("scoring daemon back");
  }

  function stopDownPolling(): void {
    if (downTimer !== null) {
      clearInterval(downTimer);
      downTimer = null;
    }
  }

  async function checkBackend(force: boolean): Promise<void> {
    if (!contextAlive()) {
      freeze();
      return;
    }
    try {
      const s = (await browser.runtime.sendMessage({ action: ACTIONS.GET_BACKEND_STATUS, probe: force })) as
        | BackendStatus
        | undefined;
      if (s?.active === "server") {
        leaveDown();
        // The daemon may have come back as a DIFFERENT model. A page whose paragraphs
        // are all cache hits sends no request at all, so the probe is the only place
        // such a tab can ever notice.
        adoptBackend(s.model);
      }
    } catch {
      /* worker restarting — next tick */
    }
  }

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
    cache.clear();
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
      updateFab();
      log.log("re-queued", n, "unavailable units");
    }
  }

  function retryBackend(): void {
    if (!started) return;
    if (backendDown) void checkBackend(true);
    else retryUnavailable();
  }

  /**
   * The worker's caches were cleared, so this layer — which answers before them — has to go
   * too. Nothing is re-scanned or repainted: the verdicts on the page were real when they
   * were made, and the user cleared the caches to affect what happens NEXT.
   */
  function forgetCached(): void {
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
    }
    // A verdict is KNOWN the moment it arrives; PAINTING it touches the page, and on a
    // page that has still to hydrate that waits (see whenSafeToInsert). Scoring early
    // costs the page nothing, so the latency is bought back either way.
    whenSafeToInsert(() => paint(verdicts));
    updateFab();
  }

  /** Put the verdicts on the page. Re-entrant: what it paints is decided when it runs, not
   *  when it was queued, so a unit invalidated or re-answered while the insertion gate was
   *  closed is simply skipped. */
  function paint(verdicts: UnitVerdict[]): void {
    for (const v of verdicts) {
      const unit = unitsById.get(v.id);
      if (!unit || verdictsById.get(v.id) !== v) continue; // gone, or already superseded
      if (!visibleUnderMode(v)) continue; // analyzed but not painted (flagged-only)
      try {
        badges.render(unit, v);
        if (highlightsEnabled) setHighlight(unit, v);
      } catch (e) {
        log.warn("render failed for", v.id, e);
      }
    }
    badges.setVisible(visible);
    setHighlightsVisible(visible && highlightsEnabled);
    updateFab();
  }

  /** Repaint everything under a new display mode (results are all cached). */
  function applyDisplayMode(v: "all" | "flagged"): void {
    if (v === displayMode) return;
    displayMode = v;
    for (const [id, verdict] of verdictsById) {
      const unit = unitsById.get(id);
      if (!unit) continue;
      if (visibleUnderMode(verdict)) {
        try {
          badges.render(unit, verdict);
          if (highlightsEnabled) setHighlight(unit, verdict);
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

  /** Merging changes the segmentation itself, so the page must be collected again. */
  function applyMergeShorts(v: boolean): void {
    if (v === mergeShorts) return;
    mergeShorts = v;
    if (started) rescan();
  }

  /** Scope is structural too: WHAT gets collected changes. */
  function applyScope(v: "page" | "main"): void {
    if (opts.lockScope) return; // pinned (Docs editor) — user scope not applied
    if (v === analysisScope) return;
    analysisScope = v;
    if (v === "main") {
      // Readability is an on-demand chunk: fetch it once, then re-collect under the
      // new scope (the text-mass probe covers the rare failure to load).
      void loadReadabilityOnce().then(() => {
        if (started && analysisScope === "main") rescan();
      });
    } else if (started) {
      rescan();
    }
  }

  function updateFab(): void {
    if (started && mountFab) fab.mount(); // re-mounts if the page wiped the host
    let flagged = 0;
    for (const v of verdictsById.values()) if (isFlagged(v.result)) flagged++;
    fab.setCount(flagged);
    notifyToolbarBadge(flagged);
  }

  /** Per-tab flagged count on the toolbar icon (top frame owns the tab's number). */
  function notifyToolbarBadge(flagged: number): void {
    if (!mountFab || flagged === lastBadgeSent) return;
    lastBadgeSent = flagged;
    void browser.runtime
      .sendMessage({ action: ACTIONS.UPDATE_BADGE, flagged })
      .catch(() => undefined);
  }

  const scheduler: Scheduler = createScheduler<UnitVerdict>({
    batchCharBudget: BATCH_CHAR_BUDGET,
    maxInFlight: MAX_IN_FLIGHT,
    maxBackgroundInFlight: MAX_BACKGROUND_IN_FLIGHT,
    send,
    render,
    // A prefetch pass is capped (PREFETCH_PASS): keep draining while work is left.
    onIdle: () => {
      if (started && !frozen && !backendDown) schedulePrefetch();
    },
  });

  // --- observers ---------------------------------------------------------------------

  const observers: Observers = createObservers({
    onVisible(unit) {
      scheduler.enqueue(unit, "viewport");
    },
    onNear(unit) {
      scheduler.enqueue(unit, "near");
    },
    onDirty(nodes, removed) {
      try {
        handleDirty(nodes, removed);
      } catch (e) {
        log.warn("dirty re-scan failed", e);
      }
    },
    onDocumentReplaced() {
      // document.open()/write() swapped <html> under us (challenge pages, legacy
      // SPAs): every element we held is detached — start over on the new tree.
      log.log("document replaced — restarting");
      if (!started) return;
      // The tree we were allowed to touch is not there any more, and what was waiting to
      // be drawn into it describes nothing: the NEW document decides the gate again.
      resetInsertionGate();
      rescan();
    },
  });

  function handleDirty(nodes: Node[], removed: Node[]): void {
    const startedAt = performance.now();
    const seedQueue = new Set<Element>();

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

    // 2) Invalidate units whose text changed inside the dirty subtrees. A unit is
    //    touched if any root intersects ANY of its parts, in either direction.
    const roots = computeScanRoots(nodes);
    if (roots.length > 0) {
      for (const unit of [...unitsById.values()]) {
        const touched = roots.some((r) =>
          unit.parts.some((p) => r.contains(p.container) || p.container.contains(r)),
        );
        if (touched && currentTextOf(unit) !== unit.text) invalidateUnit(unit, seedQueue);
      }
    }

    // 3) Re-scan the dirty roots PLUS every container released by invalidations
    //    above (multi-part units span containers outside the mutation root).
    //    Stale-claim invalidations during scanning queue further rounds.
    //    Under "main" scope, roots outside the detected region are not scanned.
    const scanned = new Set<Element>();
    // A root ABOVE the scope region (body-level swap) scans the region, not the whole
    // subtree — out-of-scope content must not sneak in from above. Applied again after
    // the bound, because merging roots upward can climb past the region too.
    const clampToScope = (r: Element): Element =>
      scopeRoot && r !== scopeRoot && r.contains(scopeRoot) ? scopeRoot : r;
    let queue: Element[] = boundRoots(
      dedupeRoots([...roots, ...seedQueue]).filter(inScope).map(clampToScope),
    ).map(clampToScope);
    // What the burst itself was reduced to, before the rounds that stale claims add.
    const planned = queue.length;
    for (let round = 0; round < 4 && queue.length > 0; round++) {
      const extra = new Set<Element>();
      const filter = makeClaimFilter(extra);
      for (const root of queue) {
        if (scanned.has(root) || !root.isConnected) continue;
        scanned.add(root);
        ingestUnits(collect(root, filter));
      }
      queue = [...extra].filter((r) => !scanned.has(r));
    }
    updateFab();
    // What a page costs us over time is the sum of THIS line: how many walks a mutation
    // burst turned into — the ones it PLANNED (bounded by MAX_SCAN_ROOTS) and the ones
    // stale claims added afterwards — and how long they took. A number that climbs with
    // the page is the whole-container re-walk the scan-root rule exists to avoid.
    log.log(
      "dirty scan:", nodes.length, "dirty,", removed.length, "removed,",
      planned, "planned,", scanned.size, "roots,",
      Math.round(performance.now() - startedAt), "ms",
    );
  }

  // --- the insertion gate --------------------------------------------------------------

  /**
   * Run `insert` now, or once the page's own tree is safe to touch. Everything that puts a
   * node into the PAGE goes through here — chips, pending chips, the underline styles.
   * Scoring does not: reading the page and asking the daemon change nothing, so a
   * hydrating page pays no latency for this, only the paint waits.
   */
  function whenSafeToInsert(insert: () => void): void {
    if (safeToInsert) {
      insert();
      return;
    }
    heldInsertions.push(insert);
  }

  function openInsertionGate(): void {
    if (safeToInsert) return;
    disarmInsertionGate(); // whichever of the three ways in got here, the others are done
    safeToInsert = true;
    log.log("insertion gate open,", heldInsertions.length, "held");
    for (const insert of heldInsertions.splice(0)) {
      try {
        insert();
      } catch (e) {
        log.warn("held insertion failed", e);
      }
    }
  }

  /**
   * Decide when that is. A page with no hydration marker — nearly every page, every static
   * article, every fixture — is safe at once, and its time-to-first-chip does not move. A
   * page with one waits for `readyState === "complete"` and one idle period after it,
   * capped at HYDRATION_MAX_MS.
   */
  function watchInsertionGate(): void {
    if (safeToInsert || gateCap !== null || gateLoad !== null) return; // open, or already waiting
    if (!document.querySelector(HYDRATION_MARKERS)) {
      openInsertionGate();
      return;
    }
    gateCap = setTimeout(openInsertionGate, HYDRATION_MAX_MS);
    const afterIdle = (): void => {
      gateLoad = null;
      const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
        .requestIdleCallback;
      // Called ON window: Gecko's binding rejects a detached call (see schedulePrefetch).
      if (typeof ric === "function") gateIdle = ric.call(window, openInsertionGate, { timeout: HYDRATION_IDLE_MS });
      else gateFallback = setTimeout(openInsertionGate, 200);
    };
    gateLoad = afterIdle;
    if (document.readyState === "complete") afterIdle();
    else window.addEventListener("load", afterIdle, { once: true });
  }

  /** Take back every timer, idle callback and listener the gate armed. */
  function disarmInsertionGate(): void {
    if (gateCap !== null) {
      clearTimeout(gateCap);
      gateCap = null;
    }
    if (gateFallback !== null) {
      clearTimeout(gateFallback);
      gateFallback = null;
    }
    if (gateIdle !== null) {
      const cic = (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
      if (typeof cic === "function") cic.call(window, gateIdle);
      gateIdle = null;
    }
    if (gateLoad !== null) {
      window.removeEventListener("load", gateLoad);
      gateLoad = null;
    }
  }

  /**
   * The run is over, or the document it was about has been replaced. Nothing that was
   * waiting to be drawn is wanted any more, nothing stays armed to draw it later, and the
   * next start() asks the tree it finds THEN whether it may be touched.
   */
  function resetInsertionGate(): void {
    disarmInsertionGate();
    heldInsertions.length = 0;
    safeToInsert = false;
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
   * never missed one in the survey. So a rewrite that left every live unit connected and
   * the main region where it was is answered by the purge and the scope re-resolve alone.
   *
   * Anything else — a pushed entry, a traversal, a popstate, a hash change, the slow poll
   * that stands in where the Navigation API is missing — is a real route change and gets
   * the full refresh, debounced so that a burst of them is one walk.
   */
  function onUrlMaybeChanged(kind: "rewrite" | "route"): void {
    if (!started || location.href === lastHref) return;
    lastHref = location.href;
    const live = unitsById.size;
    const region = scopeRoot;
    purgeDisconnected();
    resolveScopeRoot(); // the route's main region may be a different element now
    if (kind === "rewrite" && unitsById.size === live && scopeRoot === region) {
      updateFab();
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
      purgeDisconnected();
      resolveScopeRoot();
      const base = scanBase();
      if (base) ingestUnits(collect(base, makeClaimFilter()));
      updateFab();
      log.log("url change refresh", location.href);
    }, URL_REFRESH_DEBOUNCE_MS);
  }

  // --- visibility (instant, no re-detection) -------------------------------------------

  function setVisible(v: boolean): void {
    visible = v;
    badges.setVisible(v);
    setHighlightsVisible(v && highlightsEnabled);
    fab.setActive(v);
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

    watchInsertionGate();
    // The underline rules are a <style> in the page's own head, so they wait with the
    // chips they paint; the ball is ours and goes up at once, outside anything a
    // framework hydrates.
    whenSafeToInsert(registerHighlightStyles);
    if (mountFab) {
      fab.mount();
      fab.setActive(true);
    }
    // The chrome goes up synchronously — callers treat start() as immediate — but
    // nothing is COLLECTED until the user's own settings have been read: see boot().
    void boot(++bootSeq);
  }

  /**
   * The asynchronous half of start(). The first collect has to run under the settings
   * the user chose, not under the defaults: scanning first and correcting afterwards
   * dispatched paragraphs a "Main content only" reader never agreed to send, chipped
   * them outside the region, and flashed "analyzing…" chips at a "Flagged only" reader
   * before tearing the whole page down again. `seq` retires a boot whose start() has
   * since been undone by a stop() or overtaken by a newer start().
   */
  async function boot(seq: number): Promise<void> {
    applySnapshot(await readSettings());
    if (seq !== bootSeq || !started) return; // stopped or restarted while we waited

    // Under "main" scope the region is Readability's answer once the chunk is here and
    // the text-mass probe's until then, and the two can disagree — so give the chunk a
    // bounded head start instead of scanning the page twice on every load.
    let lateReadability = false;
    if (analysisScope === "main") {
      const ready = loadReadabilityOnce();
      lateReadability = await Promise.race([
        ready.then(() => false),
        new Promise<boolean>((r) => setTimeout(() => r(true), READABILITY_BOOT_MS)),
      ]);
      if (seq !== bootSeq || !started) return;
    }

    watchSettings();
    observers.start();
    booted = true;
    resolveScopeRoot();
    const base = scanBase();
    if (base) ingestUnits(collect(base, makeClaimFilter()));

    watchUrl();
    log.log("started", { session, domain });

    // The chunk was still in flight when the wait ran out, so this page was scoped by
    // the text-mass probe alone: re-derive it once if Readability does turn up.
    if (lateReadability) {
      void loadReadabilityOnce().then((ok) => {
        if (ok && started && seq === bootSeq && analysisScope === "main") rescan();
      });
    }
  }

  /** One awaited read of every setting the first collect depends on. */
  async function readSettings(): Promise<SettingsSnapshot> {
    try {
      const [showHighlights, mode, merge, mark, scope] = await Promise.all([
        settings.showHighlights.getValue(),
        settings.displayMode.getValue(),
        settings.mergeShorts.getValue(),
        settings.markStyle.getValue(),
        settings.analysisScope.getValue(),
      ]);
      return {
        showHighlights,
        displayMode: mode,
        mergeShorts: merge,
        markStyle: normalizeMarkStyle(mark),
        analysisScope: scope,
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
    displayMode = s.displayMode;
    mergeShorts = s.mergeShorts;
    setMarkStyle(s.markStyle);
    if (!opts.lockScope) analysisScope = s.analysisScope;
    setHighlightsVisible(visible && highlightsEnabled);
  }

  /** Live changes from here on, exactly as they behaved before the snapshot existed. */
  function watchSettings(): void {
    try {
      unwatchHighlights?.();
      unwatchHighlights = settings.showHighlights.watch(applyHighlightSetting);
      unwatchDisplay?.();
      unwatchDisplay = settings.displayMode.watch(applyDisplayMode);
      unwatchMerge?.();
      unwatchMerge = settings.mergeShorts.watch(applyMergeShorts);
      unwatchMarkStyle?.();
      unwatchMarkStyle = settings.markStyle.watch((v) => setMarkStyle(normalizeMarkStyle(v)));
      unwatchScope?.();
      unwatchScope = settings.analysisScope.watch(applyScope);
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
    const nav = navigationApi();
    if (nav) nav.addEventListener("currententrychange", onEntryChanged);
    else urlTimer = setInterval(onRouteChanged, URL_POLL_MS);
  }

  function unwatchUrl(): void {
    window.removeEventListener("popstate", onRouteChanged);
    window.removeEventListener("hashchange", onRouteChanged);
    navigationApi()?.removeEventListener("currententrychange", onEntryChanged);
    if (urlTimer !== null) {
      clearInterval(urlTimer);
      urlTimer = null;
    }
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
            setHighlight(unit, verdict);
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
    for (const id of unitsById.keys()) clearHighlight(id);
    badges.teardownAll();
    flaggedCursor = null; // the ids it names are about to stop existing
    unitsById = new Map();
    verdictsById = new Map();
    shortTexts.clear();
    nodeOwner = new WeakMap();
  }

  function stop(): void {
    if (!started) return;
    started = false;
    booted = false;
    // Whatever was waiting for the page to be safe to touch is not wanted any more: the
    // run is over and everything it drew is about to be taken down.
    resetInsertionGate();
    observers.stop();
    scheduler.stop();
    stopDownPolling();
    backendDown = false;
    fab.setBackendDown(false);
    clearAllResults();
    setHighlightsVisible(false);
    fab.unmount();
    unwatchUrl();
    unwatchHighlights?.();
    unwatchHighlights = null;
    unwatchDisplay?.();
    unwatchDisplay = null;
    unwatchMerge?.();
    unwatchMerge = null;
    unwatchMarkStyle?.();
    unwatchMarkStyle = null;
    unwatchScope?.();
    unwatchScope = null;
    notifyToolbarBadge(0);
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
    scheduler.bumpEpoch();
    for (const unit of [...unitsById.values()]) observers.dropUnit(unit);
    clearAllResults();
    cache.clear(); // a rescan must re-derive every verdict from the current backend
    heldInsertions.length = 0; // they paint units this rescan has just dropped
    watchInsertionGate(); // no-op unless the gate was reset with the document
    whenSafeToInsert(registerHighlightStyles); // no-op unless the document was replaced under us
    badges.resetTheme(); // the site theme may have toggled since the last scan
    refreshHighlightTheme();
    resolveScopeRoot();
    const base = scanBase();
    if (base) ingestUnits(collect(base, makeClaimFilter()));
    updateFab();
    log.log("rescan");
  }

  function scoredCount(): number {
    return verdictsById.size;
  }

  function flaggedCount(): number {
    let n = 0;
    for (const v of verdictsById.values()) if (isFlagged(v.result)) n++;
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

  function setFabAction(
    label: string | null,
    onAction?: () => void,
    opts?: { attention?: boolean },
  ): void {
    fab.setAction(label, onAction, opts);
  }

  return {
    start,
    stop,
    rescan,
    toggle,
    scoredCount,
    flaggedCount,
    unsupportedCount,
    unavailableCount,
    setFabAction,
    retryBackend,
    forgetCached,
    openPanel,
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
  const uniq = [...new Set(all)].filter((el) => el.isConnected);
  return uniq.filter((r) => !uniq.some((o) => o !== r && o.contains(r)));
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
