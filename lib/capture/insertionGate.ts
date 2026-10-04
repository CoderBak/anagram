// lib/capture/insertionGate.ts — when Anagram may put a node into the page's own tree.
//
// Everything that puts a node into the PAGE goes through the gate — chips, pending chips, the
// underline styles. Scoring does not: reading the page and asking the daemon change nothing,
// so a hydrating page pays no latency for this, only the paint waits (lib/capture/orchestrator.ts).

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

export interface InsertionGate {
  /** Run `insert` now, or once the page's own tree is safe to touch. */
  whenSafe(insert: () => void): void;
  /**
   * Decide when that is. A page with no hydration marker — nearly every page, every static
   * article, every fixture — is safe at once, and its time-to-first-chip does not move. A
   * page with one waits for `readyState === "complete"` and one idle period after it,
   * capped at HYDRATION_MAX_MS. Nothing happens while the gate is open or already waiting.
   */
  watch(): void;
  /** Let go of what is waiting to be drawn, and leave the gate as it is: a rescan's held
   *  insertions paint units it has just dropped. */
  dropHeld(): void;
  /**
   * The run is over, or the document it was about has been replaced. Nothing that was
   * waiting to be drawn is wanted any more, nothing stays armed to draw it later, and the
   * next watch() asks the tree it finds THEN whether it may be touched.
   */
  reset(): void;
}

export function createInsertionGate(log: { log(...args: unknown[]): void; warn(...args: unknown[]): void }): InsertionGate {
  /** The page's own tree may be touched: it carries no hydration marker, or the framework
   *  that owns it has had its turn. */
  let safe = false;
  /** Insertions held back until it is. */
  const held: (() => void)[] = [];
  /** What the gate has armed to open itself with, so a teardown can take it all back. */
  let cap: ReturnType<typeof setTimeout> | null = null;
  let fallback: ReturnType<typeof setTimeout> | null = null;
  let idle: number | null = null;
  let load: (() => void) | null = null;

  function open(): void {
    if (safe) return;
    disarm(); // whichever of the three ways in got here, the others are done
    safe = true;
    log.log("insertion gate open,", held.length, "held");
    for (const insert of held.splice(0)) {
      try {
        insert();
      } catch (e) {
        log.warn("held insertion failed", e);
      }
    }
  }

  /** Take back every timer, idle callback and listener the gate armed. */
  function disarm(): void {
    if (cap !== null) {
      clearTimeout(cap);
      cap = null;
    }
    if (fallback !== null) {
      clearTimeout(fallback);
      fallback = null;
    }
    if (idle !== null) {
      const cic = (window as Window & { cancelIdleCallback?: (h: number) => void }).cancelIdleCallback;
      if (typeof cic === "function") cic.call(window, idle);
      idle = null;
    }
    if (load !== null) {
      window.removeEventListener("load", load);
      load = null;
    }
  }

  return {
    whenSafe(insert) {
      if (safe) {
        insert();
        return;
      }
      held.push(insert);
    },
    watch() {
      if (safe || cap !== null || load !== null) return; // open, or already waiting
      if (!document.querySelector(HYDRATION_MARKERS)) {
        open();
        return;
      }
      cap = setTimeout(open, HYDRATION_MAX_MS);
      const afterIdle = (): void => {
        load = null;
        const ric = (window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number })
          .requestIdleCallback;
        // Called ON window: Gecko's binding rejects a detached call (see the orchestrator's
        // schedulePrefetch).
        if (typeof ric === "function") idle = ric.call(window, open, { timeout: HYDRATION_IDLE_MS });
        else fallback = setTimeout(open, 200);
      };
      load = afterIdle;
      if (document.readyState === "complete") afterIdle();
      else window.addEventListener("load", afterIdle, { once: true });
    },
    dropHeld() {
      held.length = 0;
    },
    reset() {
      disarm();
      held.length = 0;
      safe = false;
    },
  };
}
