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
// re-collected or gone. SPA navigations (pushState included — watched by URL poll,
// popstate and hashchange) refresh incrementally without flickering still-valid
// badges. The popup Rescan button remains the full teardown+rescan.
import { browser } from "#imports";
import type { ContentScriptContext } from "#imports";
import { ACTIONS } from "../messaging/protocol";
import type { Unit, Lane } from "../types";
import type { ScoreBlock, ScoreResult, ScoreBatchRequest } from "../contract";
import { CONTRACT_VERSION } from "../contract";
import { collectUnits } from "../dom/walker";
import { findMainContent } from "../dom/mainContent";
import { extractPartText, MAX_UNIT_TEXT_CHARS } from "../dom/text";
import { createObservers, type Observers } from "./observers";
import { createScheduler, type Scheduler } from "./scheduler";
import { createScoreCache, type ScoreCache } from "./cache";
import { requestScores, contextAlive, lastModel } from "../messaging/client";
import { createBadgeLayer, type BadgeLayer } from "../render/badge";
import {
  setHighlight,
  clearHighlight,
  registerHighlightStyles,
  setHighlightsVisible,
  setMarkStyle,
  refreshHighlightTheme,
} from "../render/highlight";
import { createFab, type Fab } from "../render/fab";
import { band, BAND_LABEL, BUCKET_BANDS, isFlagged, scorePct } from "../render/band";
import { settings } from "../settings/settings";
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
// The MAIN-world nav hook (entrypoints/nav-hook.content.ts) announces pushState/
// replaceState instantly via "anagram:navigate"; the poll is only a slow fallback
// for exotic navigation paths the hook cannot see.
const URL_POLL_MS = 2500;

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
  /** Configure the FAB's secondary action chip (Google Docs reading view etc.). */
  setFabAction(label: string | null, onAction?: () => void, opts?: { attention?: boolean }): void;
}

function newSessionId(): string {
  return "s_" + Math.random().toString(36).slice(2, 10);
}

export interface OrchestratorOptions {
  /** Mount the floating toggle. False in subframes — one FAB per TAB, in the top frame. */
  mountFab?: boolean;
  /**
   * Pin the analysis scope regardless of the user setting. Docs editor pages set
   * "page": the real content lives in our overlay's shadow root, which the
   * main-region probe cannot see into — "main" would mis-scope to app chrome.
   */
  lockScope?: "page";
}

export function createOrchestrator(
  _ctx: ContentScriptContext,
  opts: OrchestratorOptions = {},
): Orchestrator {
  const mountFab = opts.mountFab ?? true;
  const cache: ScoreCache = createScoreCache();
  const badges: BadgeLayer = createBadgeLayer();

  let unitsById = new Map<string, Unit>();
  let resultsById = new Map<string, ScoreResult>();
  let scoredIds = new Set<string>();
  /** Text-node ownership: node → live unit. Recreated on stop/rescan. */
  let nodeOwner = new WeakMap<Text, Unit>();

  const session = newSessionId();
  const domain = location.hostname || "und";
  const lang = document.documentElement.getAttribute("lang") || "und";

  let started = false;
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
  let lastHref = location.href;
  let urlTimer: ReturnType<typeof setInterval> | null = null;

  const fab: Fab = createFab({
    onToggle: () => toggle(),
    panel: {
      entries: () =>
        [...resultsById.entries()]
          .filter(([id, r]) => isFlagged(r) && unitsById.has(id))
          .map(([id, r]) => ({
            id,
            pct: scorePct(r),
            band: band(r),
            snippet: unitsById.get(id)!.text.slice(0, 70),
            order: unitsById.get(id)!.order,
          }))
          .sort((a, b) => a.order - b.order),
      onJump: (id) => {
        const unit = unitsById.get(id);
        if (!unit || !unit.container.isConnected) return;
        unit.container.scrollIntoView({ behavior: "smooth", block: "center" });
        setTimeout(() => badges.flash(id), 350); // pulse once the scroll settles
      },
      buildReport,
    },
  });

  /** Markdown summary of this page's verdicts — the triage panel's Copy report. */
  function buildReport(): string {
    const flagged = [...resultsById.entries()]
      .filter(([id, r]) => isFlagged(r) && unitsById.has(id))
      .map(([id, r]) => ({ unit: unitsById.get(id)!, r }))
      .sort((a, b) => a.unit.order - b.unit.order);

    const lines: string[] = [];
    lines.push(`# Anagram AI report — ${document.title || location.hostname}`);
    lines.push("");
    lines.push(`- Page: ${location.href}`);
    lines.push(`- Generated: ${new Date().toLocaleString()}`);
    let skipped = 0;
    for (const r of resultsById.values()) if (r.unsupported) skipped++;
    lines.push(
      `- Analyzed: ${resultsById.size - skipped} unit${resultsById.size - skipped === 1 ? "" : "s"} · Flagged: ${flagged.length}` +
        (skipped > 0 ? ` · Skipped (unsupported language): ${skipped}` : ""),
    );
    lines.push("");
    if (flagged.length === 0) {
      lines.push("No paragraphs were flagged as heavily edited or AI-generated.");
    } else {
      lines.push(`## Flagged paragraphs (${flagged.length})`);
      lines.push("");
      flagged.forEach(({ unit, r }, i) => {
        const pct = scorePct(r);
        const dist = r.probs
          .map((p, i) => `${BAND_LABEL[BUCKET_BANDS[i]]} ${Math.round(p * 100)}%`)
          .join(" · ");
        const snippet = unit.text.replace(/\s+/g, " ").slice(0, 220);
        const ellipsis = unit.text.length > 220 ? "…" : "";
        lines.push(
          `${i + 1}. **${BAND_LABEL[band(r)]} · ${pct}% AI** ` +
            `(${dist}; ${unit.wordCount} words)`,
        );
        lines.push(`   > ${snippet}${ellipsis}`);
      });
    }
    lines.push("");
    const m = lastModel();
    const backend =
      !m || m.id === "stub"
        ? "Scores in this report come from the demo stub — the local anagramd daemon was not " +
          "running. They are placeholders, not verdicts."
        : `Scores from ${m.id} (${m.ver}) via the local anagramd daemon — EditLens estimates ` +
          "of AI-editing extent, not proof.";
    lines.push("---", backend);
    return lines.join("\n");
  }

  /** Painted under the current display mode? Everything is analyzed regardless. */
  function visibleUnderMode(r: ScoreResult): boolean {
    return displayMode === "all" || isFlagged(r);
  }

  // --- analysis scope ----------------------------------------------------------------

  /** Re-detect the main-content region (scope "main"); body-wide otherwise. */
  function resolveScopeRoot(): void {
    scopeRoot = analysisScope === "main" ? findMainContent() : null;
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

  /** The unit's CURRENT text, recomputed the same way the walker built it. */
  function currentTextOf(unit: Unit): string {
    return unit.parts
      .map((p) => extractPartText(p.nodes).replace(/\s+/g, " ").trim())
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
    resultsById.delete(unit.id);
    scoredIds.delete(unit.id);
  }

  /** Purge units whose DOM disappeared (SPA swaps, virtualized lists). */
  function purgeDisconnected(rescanQueue?: Set<Element>): void {
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

  /** Register freshly collected units: claim their nodes, observe, index. */
  function ingestUnits(units: Unit[]): void {
    for (const u of units) {
      if (unitsById.has(u.id)) continue;
      unitsById.set(u.id, u);
      for (const part of u.parts) {
        for (const n of part.nodes) nodeOwner.set(n, u);
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
        .filter((u) => !u.isScored && !resultsById.has(u.id))
        .sort((a, b) => a.order - b.order);
      for (const u of pending) {
        scheduler.enqueue(u, "background");
        if (++n >= PREFETCH_PASS) break;
      }
      if (n > 0) log.log("prefetch: queued", n, "of", pending.length, "unscored units");
    };
    const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
      .requestIdleCallback;
    if (typeof ric === "function") ric(run, { timeout: 1500 });
    else setTimeout(run, 400);
  }

  // --- scheduler send/render seam ----------------------------------------------------

  /** Scheduler send(): cache-first, then one batched requestScores() for the misses. */
  async function send(blocks: ScoreBlock[], lane: Lane): Promise<ScoreResult[]> {
    const out: ScoreResult[] = [];
    const misses: ScoreBlock[] = [];

    for (const b of blocks) {
      const hit = cache.get(b.text);
      if (hit) out.push({ ...hit, id: b.id });
      else misses.push(b);
    }

    if (misses.length > 0) {
      // The chip appears in its "analyzing…" state the moment real work starts
      // (cache hits render instantly and never flash it). Skipped in flagged-only
      // mode — most pending chips would pop in and vanish again.
      if (visible && displayMode === "all") {
        for (const b of misses) {
          const unit = unitsById.get(b.id);
          if (!unit) continue;
          try {
            badges.renderPending(unit);
          } catch {
            /* detached mid-flight — purge will collect it */
          }
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
        surface: "chrome-ext",
        priority: lane,
        lang,
        domain,
        blocks: [...repByKey.values()],
      };
      const fresh = await requestScores(req);
      const byId = new Map(fresh.map((r) => [r.id, r] as const));
      for (const [k, rep] of repByKey) {
        const r = byId.get(rep.id);
        if (!r) continue;
        if (!r.degraded) cache.set(rep.text, r); // fallbacks must not outlive the outage
        for (const id of idsByKey.get(k)!) out.push({ ...r, id });
      }
      // Hard transport failure (extension reloaded/updated mid-flight): nothing
      // came back for these — retire their pending chips instead of leaving
      // "analyzing…" stuck on the page forever.
      const answered = new Set(out.map((r) => r.id));
      for (const b of misses) {
        if (!answered.has(b.id)) badges.remove(b.id);
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
    if (urlTimer !== null) {
      clearInterval(urlTimer);
      urlTimer = null;
    }
    window.removeEventListener("popstate", onUrlMaybeChanged);
    window.removeEventListener("hashchange", onUrlMaybeChanged);
    window.removeEventListener("anagram:navigate", onUrlMaybeChanged);
  }

  /** Scheduler render(): id-keyed badge paint + per-part underline. */
  function render(results: ScoreResult[], _epoch: number): void {
    for (const r of results) {
      const unit = unitsById.get(r.id);
      if (!unit) continue; // invalidated while the batch was in flight
      resultsById.set(r.id, r);
      scoredIds.add(r.id);
      unit.isScored = true;
      observers.dropUnit(unit); // analyzed — stop viewport tracking
      if (!visibleUnderMode(r)) continue; // analyzed but not painted (flagged-only)
      try {
        badges.render(unit, r);
        if (highlightsEnabled) setHighlight(unit, r);
      } catch (e) {
        log.warn("render failed for", r.id, e);
      }
    }
    badges.setVisible(visible);
    setHighlightsVisible(visible && highlightsEnabled);
    updateFab();
    // A pass may have been capped (huge page): keep draining while there is work left.
    if (scheduler.pendingCount() === 0) schedulePrefetch();
  }

  /** Repaint everything under a new display mode (results are all cached). */
  function applyDisplayMode(v: "all" | "flagged"): void {
    if (v === displayMode) return;
    displayMode = v;
    for (const [id, r] of resultsById) {
      const unit = unitsById.get(id);
      if (!unit) continue;
      if (visibleUnderMode(r)) {
        try {
          badges.render(unit, r);
          if (highlightsEnabled) setHighlight(unit, r);
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

  function updateFab(): void {
    if (started && mountFab) fab.mount(); // re-mounts if the page wiped the host
    let flagged = 0;
    for (const r of resultsById.values()) if (isFlagged(r)) flagged++;
    fab.setCount(flagged, resultsById.size);
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

  const scheduler: Scheduler = createScheduler({
    batchCharBudget: BATCH_CHAR_BUDGET,
    maxInFlight: MAX_IN_FLIGHT,
    maxBackgroundInFlight: MAX_BACKGROUND_IN_FLIGHT,
    send,
    render,
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
  });

  function handleDirty(nodes: Node[], removed: Node[]): void {
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
    let queue: Element[] = dedupeRoots([...roots, ...seedQueue])
      .filter(inScope)
      // A root ABOVE the scope region (body-level swap) scans the region, not
      // the whole subtree — out-of-scope content must not sneak in from above.
      .map((r) => (scopeRoot && r !== scopeRoot && r.contains(scopeRoot) ? scopeRoot : r));
    for (let round = 0; round < 4 && queue.length > 0; round++) {
      const extra = new Set<Element>();
      const filter = makeClaimFilter(extra);
      for (const root of queue) {
        if (scanned.has(root) || !root.isConnected) continue;
        scanned.add(root);
        ingestUnits(collectUnits(root, { claimFilter: filter, mergeShorts }));
      }
      queue = [...extra].filter((r) => !scanned.has(r));
    }
    updateFab();
  }

  // --- URL / SPA navigation ------------------------------------------------------------

  function onUrlMaybeChanged(): void {
    if (!started || location.href === lastHref) return;
    lastHref = location.href;
    // Incremental refresh: purge what's gone, pick up what's new. Still-valid
    // badges stay put (no flicker); MutationObserver covers the DOM swap itself.
    purgeDisconnected();
    resolveScopeRoot(); // the route's main region may be a different element now
    const base = scanBase();
    if (base) {
      ingestUnits(collectUnits(base, { claimFilter: makeClaimFilter(), mergeShorts }));
    }
    updateFab();
    log.log("url change refresh", location.href);
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
    visible = true;
    lastHref = location.href;

    registerHighlightStyles();
    if (mountFab) {
      fab.mount();
      fab.setActive(true);
    }

    void settings.showHighlights.getValue().then(applyHighlightSetting);
    unwatchHighlights?.();
    unwatchHighlights = settings.showHighlights.watch(applyHighlightSetting);
    void settings.displayMode.getValue().then(applyDisplayMode);
    unwatchDisplay?.();
    unwatchDisplay = settings.displayMode.watch(applyDisplayMode);
    const applyMergeShorts = (v: boolean): void => {
      if (v === mergeShorts) return;
      mergeShorts = v; // structural — segmentation itself changes
      if (started) rescan();
    };
    void settings.mergeShorts.getValue().then(applyMergeShorts);
    unwatchMerge?.();
    unwatchMerge = settings.mergeShorts.watch(applyMergeShorts);
    void settings.markStyle.getValue().then(setMarkStyle);
    unwatchMarkStyle?.();
    unwatchMarkStyle = settings.markStyle.watch(setMarkStyle);
    const applyScope = (v: "page" | "main"): void => {
      if (opts.lockScope) return; // pinned (Docs editor) — user scope not applied
      if (v === analysisScope) return;
      analysisScope = v; // structural — what gets collected changes
      if (started) rescan();
    };
    void settings.analysisScope.getValue().then((v) => {
      // First resolution happens before the initial collect below when the value
      // is already "main"; the async path re-scans if it arrives later.
      applyScope(v);
    });
    unwatchScope?.();
    unwatchScope = settings.analysisScope.watch(applyScope);

    observers.start();
    resolveScopeRoot();
    const base = scanBase();
    if (base) ingestUnits(collectUnits(base, { claimFilter: makeClaimFilter(), mergeShorts }));

    window.addEventListener("popstate", onUrlMaybeChanged);
    window.addEventListener("hashchange", onUrlMaybeChanged);
    window.addEventListener("anagram:navigate", onUrlMaybeChanged);
    urlTimer = setInterval(onUrlMaybeChanged, URL_POLL_MS);
    log.log("started", { session, domain });
  }

  function applyHighlightSetting(v: boolean): void {
    highlightsEnabled = v;
    if (v) {
      for (const [id, r] of resultsById) {
        const unit = unitsById.get(id);
        if (unit && visibleUnderMode(r)) {
          try {
            setHighlight(unit, r);
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
    scoredIds = new Set();
    unitsById = new Map();
    resultsById = new Map();
    nodeOwner = new WeakMap();
  }

  function stop(): void {
    if (!started) return;
    started = false;
    observers.stop();
    scheduler.stop();
    clearAllResults();
    setHighlightsVisible(false);
    fab.unmount();
    window.removeEventListener("popstate", onUrlMaybeChanged);
    window.removeEventListener("hashchange", onUrlMaybeChanged);
    window.removeEventListener("anagram:navigate", onUrlMaybeChanged);
    if (urlTimer !== null) {
      clearInterval(urlTimer);
      urlTimer = null;
    }
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
    scheduler.bumpEpoch();
    for (const unit of [...unitsById.values()]) observers.dropUnit(unit);
    clearAllResults();
    badges.resetTheme(); // the site theme may have toggled since the last scan
    refreshHighlightTheme();
    resolveScopeRoot();
    const base = scanBase();
    if (base) {
      ingestUnits(collectUnits(base, { claimFilter: makeClaimFilter(), mergeShorts }));
    }
    updateFab();
    log.log("rescan");
  }

  function scoredCount(): number {
    return scoredIds.size;
  }

  function flaggedCount(): number {
    let n = 0;
    for (const r of resultsById.values()) if (isFlagged(r)) n++;
    return n;
  }

  function unsupportedCount(): number {
    let n = 0;
    for (const r of resultsById.values()) if (r.unsupported) n++;
    return n;
  }

  function setFabAction(
    label: string | null,
    onAction?: () => void,
    opts?: { attention?: boolean },
  ): void {
    fab.setAction(label, onAction, opts);
  }

  return { start, stop, rescan, toggle, scoredCount, flaggedCount, unsupportedCount, setFabAction };
}

/** Merge scan roots, dropping disconnected ones and any contained by another. */
function dedupeRoots(all: Element[]): Element[] {
  const uniq = [...new Set(all)].filter((el) => el.isConnected);
  return uniq.filter((r) => !uniq.some((o) => o !== r && o.contains(r)));
}

/**
 * Map a batch of dirty nodes to the elements to re-walk: climb one level above each
 * dirty node (so a freshly inserted block is found from its parent), then drop any
 * root contained by another to avoid redundant overlapping scans.
 */
function computeScanRoots(nodes: Node[]): Element[] {
  const roots = new Set<Element>();
  for (const n of nodes) {
    const base: Element | null =
      n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
    if (!base || !base.isConnected) continue;
    roots.add(base.parentElement ?? base);
  }
  const all = [...roots];
  return all.filter((r) => !all.some((o) => o !== r && o.contains(r)));
}
