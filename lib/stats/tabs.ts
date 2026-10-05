// lib/stats/tabs.ts — what the worker knows of windows and tabs, for the reading log: ids of
// its own for them, how each page was arrived at, which visit came before which, and how long
// a tab Anagram cannot read was in front of a focused window.
//
// Ids are random and last a browser session (storage.session): Chrome's own numbers are never
// kept. Nothing about a tab Anagram cannot read is kept but that it was in front, and for how
// long (COVER): not its address, not its title. The listeners are added when the worker
// starts, as an MV3 worker must, and do nothing while the configuration does not ask for them.
import { browser } from "#imports";
import { rank, type RecordingConfig } from "./config";
import { localDate, type Arrival, type TabEvent } from "./model";
import type { LogStore } from "./store";
import type { TabFacts } from "./worker";

/** A tab whose recorder was heard from this recently is covered: a recorder speaks every
 *  minute at least while its page is shown. */
const COVERED_MS = 70_000;
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

export function createTabTracker(deps: { store: LogStore; config(): Promise<RecordingConfig>; now?(): number }): TabFacts & { install(): void } {
  const now = deps.now ?? (() => Date.now());
  const ids = { tabs: new Map<number, string>(), windows: new Map<number, string>() };
  let restored: Promise<void> | null = null;
  const arrivals = new Map<string, Arrival>();
  const visits = new Map<number, string[]>();
  const openers = new Map<number, string | undefined>();
  const covered = new Map<number, number>();
  let front: { tab: number; window: number; since: number } | null = null;
  let config: RecordingConfig | null = null;

  const random = (): string => Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");
  function restore(): Promise<void> {
    restored ??= (async () => {
      try {
        const saved = (await browser.storage.session.get(IDS_KEY))[IDS_KEY] as { tabs?: [number, string][]; windows?: [number, string][] } | undefined;
        for (const [k, v] of saved?.tabs ?? []) ids.tabs.set(k, v);
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
      void browser.storage.session?.set({ [IDS_KEY]: { tabs: [...ids.tabs].slice(-2000), windows: [...ids.windows].slice(-200) } }).catch(() => undefined);
    }, 1000);
  }
  function idOf(map: Map<number, string>, n: number): string {
    let id = map.get(n);
    if (!id) { id = random(); map.set(n, id); save(); }
    return id;
  }

  async function current(): Promise<RecordingConfig | null> {
    config = await deps.config().catch(() => null);
    return config?.on ? config : null;
  }
  const keepsTabs = (c: RecordingConfig, full: boolean): boolean => c.layers.rows === "event" && (full ? c.layers.tabs === "full" : c.layers.tabs !== "none");
  async function event(e: Omit<TabEvent, "at" | "date">, full: boolean): Promise<void> {
    const c = await current();
    if (!c || !keepsTabs(c, full)) return;
    const at = now();
    await deps.store.tab({ at, date: localDate(new Date(at)), ...e }).catch(() => undefined);
  }

  /** The tab in front of a focused window changed: the one before it, if uncovered, is kept. */
  async function frontChanged(next: { tab: number; window: number } | null): Promise<void> {
    const at = now();
    const was = front;
    front = next ? { ...next, since: at } : null;
    if (!was) return;
    const ms = at - was.since;
    if (ms < UNCOVERED_MIN_MS) return;
    const heard = covered.get(was.tab);
    if (heard !== undefined && heard >= was.since - COVERED_MS) return;
    const c = await current();
    if (!c || c.layers.cover !== "visit") return;
    await deps.store.tab({ at: was.since, date: localDate(new Date(was.since)), kind: "uncovered", ms,
      ...(c.layers.tabs !== "none" ? { tab: idOf(ids.tabs, was.tab), window: idOf(ids.windows, was.window) } : {}) }).catch(() => undefined);
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
    install() {
      browser.webNavigation?.onCommitted.addListener((d) => {
        arrivals.set(`${d.tabId}:${d.frameId}`, arrivalOf(d.transitionType, d.transitionQualifiers ?? []));
        if (arrivals.size > 4000) arrivals.delete(arrivals.keys().next().value!);
      });
      browser.tabs.onCreated.addListener((tab) => {
        if (tab.id === undefined) return;
        openers.set(tab.id, tab.openerTabId !== undefined ? visits.get(tab.openerTabId)?.at(-1) : undefined);
        void restore().then(() => event({ kind: "tabOpened", tab: idOf(ids.tabs, tab.id!), window: idOf(ids.windows, tab.windowId),
          opener: tab.openerTabId !== undefined ? idOf(ids.tabs, tab.openerTabId) : undefined, index: tab.index }, true));
      });
      browser.tabs.onActivated.addListener(({ tabId, windowId }) => {
        void restore().then(() => event({ kind: "tabFront", tab: idOf(ids.tabs, tabId), window: idOf(ids.windows, windowId) }, false));
        if (!front || front.window === windowId) void frontChanged({ tab: tabId, window: windowId });
      });
      browser.tabs.onRemoved.addListener((tabId, info) => {
        void restore().then(() => event({ kind: "tabClosed", tab: idOf(ids.tabs, tabId), window: idOf(ids.windows, info.windowId) }, true));
        visits.delete(tabId); openers.delete(tabId); covered.delete(tabId);
        if (front?.tab === tabId) void frontChanged(null);
      });
      browser.windows.onCreated.addListener((w) => {
        if (w.id !== undefined) void restore().then(() => event({ kind: "windowOpened", window: idOf(ids.windows, w.id!), state: w.state }, true));
      });
      browser.windows.onRemoved.addListener((id) => void restore().then(() => event({ kind: "windowClosed", window: idOf(ids.windows, id) }, true)));
      browser.windows.onFocusChanged.addListener((windowId) => {
        void (async () => {
          await restore();
          if (windowId === browser.windows.WINDOW_ID_NONE) {
            if (front) await event({ kind: "windowBlur", window: idOf(ids.windows, front.window) }, false);
            await frontChanged(null);
            return;
          }
          const w = await browser.windows.get(windowId).catch(() => null);
          await event({ kind: "windowFocus", window: idOf(ids.windows, windowId), ...(config && keepsTabs(config, true) && w ? { state: w.state } : {}) }, false);
          const [tab] = await browser.tabs.query({ active: true, windowId }).catch(() => []);
          await frontChanged(tab?.id !== undefined ? { tab: tab.id, window: windowId } : null);
        })();
      });
    },
  };
}

export { rank };
