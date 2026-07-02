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
import { extractPartText, MAX_UNIT_TEXT_CHARS } from "../dom/text";
import { createObservers, type Observers } from "./observers";
import { createScheduler, type Scheduler } from "./scheduler";
import { createScoreCache, type ScoreCache } from "./cache";
import { requestScores } from "../messaging/client";
import { createBadgeLayer, type BadgeLayer } from "../render/badge";
import {
  setHighlight,
  clearHighlight,
  registerHighlightStyles,
  setHighlightsVisible,
  refreshHighlightTheme,
} from "../render/highlight";
import { createFab, type Fab } from "../render/fab";
import { band } from "../render/band";
import { settings } from "../settings/settings";
import { createLogger } from "../log";

const log = createLogger("orchestrator");

const BATCH_CHAR_BUDGET = 800;
const MAX_IN_FLIGHT = 4;
const URL_POLL_MS = 500;

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
  /** Configure the FAB's secondary action chip (Google Docs reading view etc.). */
  setFabAction(label: string | null, onAction?: () => void, opts?: { attention?: boolean }): void;
}

function newSessionId(): string {
  return "s_" + Math.random().toString(36).slice(2, 10);
}

/** A unit worth surfacing in the floating counter: AI or AI-Assisted. */
function isFlagged(r: ScoreResult): boolean {
  const b = band(r);
  return b === "ai" || b === "mixed";
}

export interface OrchestratorOptions {
  /** Mount the floating toggle. False in subframes — one FAB per TAB, in the top frame. */
  mountFab?: boolean;
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
  let unwatchHighlights: (() => void) | null = null;
  let unwatchDisplay: (() => void) | null = null;
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
            pct: Math.round(r.e_theta * 100),
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
    },
  });

  /** Painted under the current display mode? Everything is analyzed regardless. */
  function visibleUnderMode(r: ScoreResult): boolean {
    return displayMode === "all" || isFlagged(r);
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
    }
    return out;
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
    const scanned = new Set<Element>();
    let queue: Element[] = dedupeRoots([...roots, ...seedQueue]);
    for (let round = 0; round < 4 && queue.length > 0; round++) {
      const extra = new Set<Element>();
      const filter = makeClaimFilter(extra);
      for (const root of queue) {
        if (scanned.has(root) || !root.isConnected) continue;
        scanned.add(root);
        ingestUnits(collectUnits(root, { claimFilter: filter }));
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
    if (document.body) {
      ingestUnits(collectUnits(document.body, { claimFilter: makeClaimFilter() }));
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

    observers.start();
    ingestUnits(collectUnits(document.body, { claimFilter: makeClaimFilter() }));

    window.addEventListener("popstate", onUrlMaybeChanged);
    window.addEventListener("hashchange", onUrlMaybeChanged);
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
    if (urlTimer !== null) {
      clearInterval(urlTimer);
      urlTimer = null;
    }
    unwatchHighlights?.();
    unwatchHighlights = null;
    unwatchDisplay?.();
    unwatchDisplay = null;
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
    if (document.body) {
      ingestUnits(collectUnits(document.body, { claimFilter: makeClaimFilter() }));
    }
    updateFab();
    log.log("rescan");
  }

  function scoredCount(): number {
    return scoredIds.size;
  }

  function setFabAction(
    label: string | null,
    onAction?: () => void,
    opts?: { attention?: boolean },
  ): void {
    fab.setAction(label, onAction, opts);
  }

  return { start, stop, rescan, toggle, scoredCount, setFabAction };
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
