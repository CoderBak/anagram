// lib/stats/tabs.ts — what the worker knows of windows and tabs, for the reading log: ids of
// its own for them, how each page was arrived at, which visit came before which, and how long
// a tab Anagram cannot read was in front of a focused window.
//
// Ids are random and last a browser session (storage.session): Chrome's own numbers are never
// kept. Nothing about a tab Anagram cannot read is kept but that it was in front, and for how
// long (COVER): not its address, not its title. The listeners are added when the worker
// starts, as an MV3 worker must, and do nothing while the configuration does not ask for them.
import { browser } from "#imports";
import { projectTab } from "./coarsen";
import { rank, type RecordingConfig } from "./config";
import { HEARTBEAT_MS, localDate, type Arrival, type TabEvent } from "./model";
import type { LogStore } from "./store";
import type { TabFacts } from "./worker";

/** A tab whose recorder was heard from this recently is covered: a recorder speaks every
 *  HEARTBEAT_MS at least while its page is shown, and a message may take a few seconds. */
const COVERED_MS = HEARTBEAT_MS + 10_000;
/** Shorter spells in front of an uncovered tab are not kept. */
const UNCOVERED_MIN_MS = 1000;
const IDS_KEY = "statsIds";

export function arrivalOf(transition: string | undefined, qualifiers: readonly string[] = []): Arrival {
  if (qualifiers.includes("forward_back")) return "history";
  if (qualifiers.includes("client_redirect") || qualifiers.includes("server_redirect")) return "redirect";
  if (qualifiers.includes("from_address_bar")) return "typed";
  switch (transition) {
    case "link": case "manual_subframe": case "auto_subframe": return "link";
    case "typed": case "keyword": return "typed";
    case "auto_bookmark": return "bookmark";
    case "reload": return "reload";
    case "form_submit": return "form";
    case "generated": case "keyword_generated": return "generated";
    default: return "other";
  }
}

export function createTabTracker(deps: { store: LogStore; config(): Promise<RecordingConfig>; now?(): number }): TabFacts & { install(): void; reset(at: number): void } {
  const now = deps.now ?? (() => Date.now());
  const ids = { tabs: new Map<number, string>(), windows: new Map<number, string>() };
  let clearedAt = 0;
  let restored: Promise<void> | null = null;
  const arrivals = new Map<string, Arrival>();
  const visits = new Map<number, string[]>();
  const openers = new Map<number, string | undefined>();
  const covered = new Map<number, number>();
  let front: { tab: number; window: number; since: number } | null = null;
  let queue = Promise.resolve();

  const random = (): string => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  function restore(): Promise<void> {
    restored ??= (async () => {
      try {
        const saved = (await browser.storage.session.get(IDS_KEY))[IDS_KEY] as { clearedAt?: number; regular?: boolean; tabs?: [number, string][]; windows?: [number, string][] } | undefined;
        if (!saved?.regular) return;
        const latest = Number((await browser.storage.local.get("statsClearedAt")).statsClearedAt) || 0;
        clearedAt = Math.max(clearedAt, latest);
        if ((saved.clearedAt ?? 0) !== clearedAt) return;
        for (const [k, v] of saved.tabs ?? []) ids.tabs.set(k, v);
        for (const [k, v] of saved?.windows ?? []) ids.windows.set(k, v);
      } catch { /* no session storage: ids last as long as this worker */ }
    })();
    return restored;
  }
  void restore();
  let saving: ReturnType<typeof setTimeout> | null = null;
  function save(): void {
    if (saving !== null) return;
    saving = setTimeout(() => {
      saving = null;
      void browser.storage.session?.set({ [IDS_KEY]: { regular: true, clearedAt, tabs: [...ids.tabs].slice(-2000), windows: [...ids.windows].slice(-200) } }).catch(() => undefined);
    }, 1000);
  }
  function idOf(map: Map<number, string>, n: number): string {
    let id = map.get(n);
    if (!id) { id = random(); map.set(n, id); save(); }
    return id;
  }

  function schedule(work: (config: RecordingConfig, at: number) => Promise<void>): void {
    const at = now();
    queue = queue.then(async () => {
      await restore();
      const config = await deps.config();
      if (config.on) await work(config, at);
      else front = null;
    }).catch(() => undefined);
  }
  const keepsTabs = (c: RecordingConfig, full: boolean): boolean => c.layers.rows === "event" && (full ? c.layers.tabs === "full" : c.layers.tabs !== "none");
  async function event(c: RecordingConfig, at: number, e: Omit<TabEvent, "at" | "date">): Promise<void> {
    const row = projectTab({ at, date: localDate(new Date(at)), ...e }, c.layers);
    if (row) await deps.store.tab(row, at);
  }
  async function frontChanged(next: { tab: number; window: number } | null, c: RecordingConfig, at: number): Promise<void> {
    const was = front;
    if (next && was?.tab === next.tab) return;
    front = c.layers.cover === "visit" && next ? { ...next, since: at } : null;
    if (!was || c.layers.cover !== "visit" || c.layers.rows !== "event") return;
    const ms = at - was.since;
    if (ms < UNCOVERED_MIN_MS || (covered.get(was.tab) ?? -Infinity) >= was.since - COVERED_MS) return;
    await event(c, was.since, { kind: "uncovered", ms,
      ...(c.layers.tabs !== "none" ? { tab: idOf(ids.tabs, was.tab), window: idOf(ids.windows, was.window) } : {}) });
  }

  return {
    tabId: (n) => idOf(ids.tabs, n),
    windowId: (n) => idOf(ids.windows, n),
    arrival: (tab, frame) => arrivals.get(`${tab}:${frame}`),
    topVisit: (tab) => visits.get(tab)?.at(-1),
    previousVisit(tab, visit) {
      const list = visits.get(tab) ?? [];
      const at = list.indexOf(visit);
      return at > 0 ? list[at - 1] : undefined;
    },
    openerVisit: (tab) => openers.get(tab),
    noteTopVisit(tab, visit) {
      const list = visits.get(tab) ?? [];
      if (list.at(-1) !== visit) list.push(visit);
      if (list.length > 2) list.splice(0, list.length - 2);
      visits.set(tab, list);
    },
    covered(tab) { covered.set(tab, now()); },
    reset(at) {
      clearedAt = at;
      ids.tabs.clear(); ids.windows.clear(); arrivals.clear(); visits.clear();
      openers.clear(); covered.clear(); front = null; save();
    },
    install() {
      browser.webNavigation?.onCommitted.addListener((d) => schedule(async (c) => {
        if (c.layers.nav === "none") return;
        const tab = await browser.tabs.get(d.tabId).catch(() => null);
        if (!tab || tab.incognito) return;
        arrivals.set(`${d.tabId}:${d.frameId}`, arrivalOf(d.transitionType, d.transitionQualifiers ?? []));
        if (arrivals.size > 4000) arrivals.delete(arrivals.keys().next().value!);
      }));
      browser.tabs.onCreated.addListener((tab) => {
        const id = tab.id;
        if (id === undefined || tab.incognito) return;
        schedule(async (c, at) => {
          if (c.layers.nav === "full" && tab.openerTabId !== undefined) openers.set(id, visits.get(tab.openerTabId)?.at(-1));
          if (keepsTabs(c, true)) await event(c, at, { kind: "tabOpened", tab: idOf(ids.tabs, id), window: idOf(ids.windows, tab.windowId),
            opener: tab.openerTabId !== undefined ? ids.tabs.get(tab.openerTabId) : undefined, index: tab.index });
        });
      });
      browser.tabs.onActivated.addListener(({ tabId, windowId }) => schedule(async (c, at) => {
        if (!keepsTabs(c, false) && c.layers.cover !== "visit") return;
        const w = await browser.windows.get(windowId).catch(() => null);
        if (!w || w.incognito) { if (w?.focused) await frontChanged(null, c, at); return; }
        if (keepsTabs(c, false)) await event(c, at, { kind: "tabFront", tab: idOf(ids.tabs, tabId), window: idOf(ids.windows, windowId) });
        if (w.focused) await frontChanged({ tab: tabId, window: windowId }, c, at);
      }));
      browser.tabs.onRemoved.addListener((tabId, info) => schedule(async (c, at) => {
        const tab = ids.tabs.get(tabId);
        if (tab && keepsTabs(c, true)) await event(c, at, { kind: "tabClosed", tab, window: ids.windows.get(info.windowId) });
        if (front?.tab === tabId) await frontChanged(null, c, at);
        visits.delete(tabId); openers.delete(tabId); covered.delete(tabId);
        if (ids.tabs.delete(tabId)) save();
      }));
      browser.windows.onCreated.addListener((w) => {
        if (!w.incognito && w.id !== undefined) schedule(async (c, at) => {
          if (keepsTabs(c, true)) await event(c, at, { kind: "windowOpened", window: idOf(ids.windows, w.id!), state: w.state });
        });
      });
      browser.windows.onRemoved.addListener((id) => schedule(async (c, at) => {
        const window = ids.windows.get(id);
        if (window && keepsTabs(c, true)) await event(c, at, { kind: "windowClosed", window });
        if (ids.windows.delete(id)) save();
      }));
      browser.windows.onFocusChanged.addListener((id) => schedule(async (c, at) => {
        if (!keepsTabs(c, false) && c.layers.cover !== "visit") return;
        const w = id === browser.windows.WINDOW_ID_NONE ? null : await browser.windows.get(id).catch(() => null);
        if (!w || w.incognito) {
          if (front && keepsTabs(c, false)) await event(c, at, { kind: "windowBlur", window: idOf(ids.windows, front.window) });
          await frontChanged(null, c, at);
          return;
        }
        if (keepsTabs(c, false)) await event(c, at, { kind: "windowFocus", window: idOf(ids.windows, id), ...(keepsTabs(c, true) ? { state: w.state } : {}) });
        const [tab] = await browser.tabs.query({ active: true, windowId: id });
        await frontChanged(tab?.id !== undefined && !tab.incognito ? { tab: tab.id, window: id } : null, c, at);
      }));
    },
  };
}

export { rank };
