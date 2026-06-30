// lib/capture/orchestrator.ts — ties walker + observers + scheduler + cache + messaging
// + renderer + the floating toggle into the live capture→annotate loop (spec §1, §4.1).
//
// On start(): collectUnits(document.body), register each unit with the observers (anchored
// on topElement), and mount the floating toggle button. As a unit becomes visible the
// scheduler scores it (cache-first) and render() paints the gutter badge AND underlines the
// AI sentences (sentence_flags) so it is clear *which* sentence is flagged.
//
// The floating button toggles the overlay's VISIBILITY without re-detecting: hide() just
// CSS-hides the badges and disables the highlight stylesheet (results stay cached and in the
// DOM); show() reveals them instantly. stop() (popup disable) is the full teardown.
import type { ContentScriptContext } from "#imports";
import type { Unit, Lane } from "../types";
import type {
  ScoreBlock,
  ScoreResult,
  ScoreBatchRequest,
} from "../contract";
import { CONTRACT_VERSION } from "../contract";
import { collectUnits } from "../dom/walker";
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
} from "../render/highlight";
import { createFab, type Fab } from "../render/fab";
import { band } from "../render/band";
import { createLogger } from "../log";

const log = createLogger("orchestrator");

const BATCH_CHAR_BUDGET = 800;
const MAX_IN_FLIGHT = 4;

export interface Orchestrator {
  /** Begin capture: initial scan + observers + scheduler + floating toggle. Idempotent. */
  start(): void;
  /** Full teardown: disconnect observers, bump epoch, remove all badges + the toggle. */
  stop(): void;
  /** Force a fresh full scan (popup "Rescan"): bump epoch, re-collect, re-enqueue. */
  rescan(): void;
  /** Toggle the overlay's visibility (the floating button). First call also scans. */
  toggle(): void;
  /** Number of paragraphs that have rendered a badge (popup GET_TAB_STATE). */
  scoredCount(): number;
}

/** A short random per-tab scan-session id. */
function newSessionId(): string {
  return "s_" + Math.random().toString(36).slice(2, 10);
}

/** A paragraph worth surfacing in the floating counter: AI or AI-Assisted. */
function isFlagged(r: ScoreResult): boolean {
  const b = band(r);
  return b === "ai" || b === "mixed";
}

export function createOrchestrator(_ctx: ContentScriptContext): Orchestrator {
  const cache: ScoreCache = createScoreCache();
  const badges: BadgeLayer = createBadgeLayer();

  // id → Unit, so the scheduler's id-keyed render() can recover the anchor + nodes.
  const unitsById = new Map<string, Unit>();
  // id → latest result, so show() can re-derive highlights and the FAB can count flags.
  const resultsById = new Map<string, ScoreResult>();
  // ids that have actually rendered a badge (scored count for the popup).
  const scoredIds = new Set<string>();
  // block elements already claimed by a unit — prevents the same paragraph, re-collected
  // before its badge marks the DOM, from being processed into two badges.
  const claimedBlocks = new Set<Element>();

  const session = newSessionId();
  const domain = location.hostname || "und";
  const lang = document.documentElement.getAttribute("lang") || "und";

  let started = false;
  let visible = true;

  // The floating toggle — clicking it flips visibility (or runs the first scan).
  const fab: Fab = createFab({ onToggle: () => toggle() });

  // --- scheduler send/render seam ------------------------------------------------

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
      // Dedup the REQUEST by text: score each unique text once, then fan the result out to
      // every block that shares it — so duplicate paragraphs each still get their own badge
      // without re-hitting the backend.
      const repByKey = new Map<string, ScoreBlock>(); // text-key → representative block
      const idsByKey = new Map<string, string[]>(); // text-key → all block ids sharing it
      for (const b of misses) {
        const k = cache.keyOf(b.text);
        if (!repByKey.has(k)) {
          repByKey.set(k, b);
          idsByKey.set(k, []);
        }
        idsByKey.get(k)!.push(b.id);
      }

      // Lane and ScanPriority share the same string union — pass straight through.
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
        cache.set(rep.text, r); // repeat paragraphs now skip the backend
        for (const id of idsByKey.get(k)!) out.push({ ...r, id });
      }
    }
    return out;
  }

  /** Scheduler render(): id-keyed badge paint + AI-sentence underline for flagged blocks. */
  function render(results: ScoreResult[], _epoch: number): void {
    for (const r of results) {
      const unit = unitsById.get(r.id);
      if (!unit) continue;
      resultsById.set(r.id, r);
      // One bad result must never abort the rest of the batch.
      try {
        badges.render(unit, r);
        scoredIds.add(r.id);
        // Underline every sentence by verdict — green for human, red/amber for AI-Assisted/AI
        // (setHighlight skips "insufficient"). Green marks "analyzed & human" vs "too short".
        setHighlight(unit, r);
      } catch (e) {
        log.warn("render failed for", r.id, e);
      }
    }
    // Keep freshly added badges/highlights consistent with the current visibility.
    badges.setVisible(visible);
    setHighlightsVisible(visible);
    updateFab();
  }

  /** Refresh the floating counter from the current results. */
  function updateFab(): void {
    let flagged = 0;
    for (const r of resultsById.values()) if (isFlagged(r)) flagged++;
    fab.setCount(flagged, resultsById.size);
  }

  const scheduler: Scheduler = createScheduler({
    batchCharBudget: BATCH_CHAR_BUDGET,
    maxInFlight: MAX_IN_FLIGHT,
    send,
    render,
  });

  // --- observers -----------------------------------------------------------------

  const observers: Observers = createObservers({
    onVisible(unit) {
      scheduler.enqueue(unit, "viewport");
    },
    onNear(unit) {
      scheduler.enqueue(unit, "near");
    },
    onDirty(nodes, _removed) {
      // Re-collect units from each dirty subtree and observe the new ones; the walker's
      // MARK_ATTR="scored" guard skips already-badged blocks, and the scheduler's
      // single-flight collapses any duplicate paragraphs.
      const roots = computeScanRoots(nodes);
      for (const root of roots) {
        try {
          ingestUnits(collectUnits(root));
        } catch (e) {
          log.warn("dirty re-scan failed", e);
        }
      }
    },
  });

  /** Register a freshly collected unit: index it by id and hand it to the observers. */
  function ingestUnits(units: Unit[]): void {
    for (const u of units) {
      if (unitsById.has(u.id)) continue;
      // One badge per block element: skip a paragraph already claimed by another unit
      // (the same <p> re-collected before its badge set MARK_ATTR="scored").
      if (claimedBlocks.has(u.parentElement)) continue;
      claimedBlocks.add(u.parentElement);
      unitsById.set(u.id, u);
      observers.observeUnit(u);
    }
  }

  // --- visibility (instant, no re-detection) -------------------------------------

  function setVisible(v: boolean): void {
    visible = v;
    badges.setVisible(v);
    setHighlightsVisible(v);
    fab.setActive(v);
  }

  function toggle(): void {
    if (!started) {
      start(); // first click also kicks off the scan
      return;
    }
    setVisible(!visible);
  }

  // --- lifecycle -----------------------------------------------------------------

  function start(): void {
    if (started) return;
    if (!document.body) return; // nothing to scan yet (e.g. about:blank subframe)
    started = true;
    visible = true;

    registerHighlightStyles();
    fab.mount();
    fab.setActive(true);

    observers.start();
    ingestUnits(collectUnits(document.body));

    window.addEventListener("popstate", onRoute);
    window.addEventListener("hashchange", onRoute);
    log.log("started", { session, domain });
  }

  function clearAllResults(): void {
    for (const id of unitsById.keys()) clearHighlight(id);
    badges.teardownAll();
    scoredIds.clear();
    unitsById.clear();
    resultsById.clear();
    claimedBlocks.clear();
  }

  function stop(): void {
    if (!started) return;
    started = false;
    observers.stop();
    scheduler.stop(); // bumps epoch + clears queues
    clearAllResults();
    setHighlightsVisible(false);
    fab.unmount();
    window.removeEventListener("popstate", onRoute);
    window.removeEventListener("hashchange", onRoute);
    log.log("stopped");
  }

  function rescan(): void {
    // Discard the previous generation, drop existing badges, then re-collect fresh.
    scheduler.bumpEpoch();
    clearAllResults();
    if (document.body) ingestUnits(collectUnits(document.body));
    updateFab();
    log.log("rescan");
  }

  /** SPA route change: bump epoch + re-collect against the swapped-in DOM. */
  function onRoute(): void {
    if (!started) return;
    rescan();
  }

  function scoredCount(): number {
    return scoredIds.size;
  }

  return { start, stop, rescan, toggle, scoredCount };
}

/**
 * Map a batch of dirty nodes to the set of elements to re-walk. We climb one level above
 * each dirty node so a newly inserted block element is found as a descendant by
 * selectBlocks (which only matches descendants of the scan root), then drop any root
 * contained by another to avoid redundant overlapping scans.
 */
function computeScanRoots(nodes: Node[]): Element[] {
  const roots = new Set<Element>();
  for (const n of nodes) {
    const base: Element | null =
      n.nodeType === Node.ELEMENT_NODE ? (n as Element) : n.parentElement;
    if (!base) continue;
    roots.add(base.parentElement ?? base);
  }
  const all = [...roots];
  return all.filter((r) => !all.some((o) => o !== r && o.contains(r)));
}
