// lib/backend/warmup.ts — the in-browser engine warmed where it will be needed.
//
// The in-browser engine lets its model go after five idle minutes, and the page that asks next
// waits about two seconds for it to load again. So when the tab in front starts navigating to a
// page Anagram reads (its site granted and switched on, where the content script runs), the
// background asks an engine that is set up but idle to start loading (the engine's `warm`), in
// parallel with the page. Nothing else warms it: not a tab switch, not a tab in the background,
// not a site Anagram does not read, not the local engine. The engine treats a model loaded this
// way like any other, and lets it go again after the idle time if nothing asks for it.
import type { BackendStatus } from "../messaging/protocol";

export interface Navigation {
  tabId: number;
  frameId: number;
  url: string;
  /** Chrome's; a prerendered page is not the tab in front. */
  documentLifecycle?: string;
}

export interface WarmupOptions {
  /** The engine in use (lib/backend/engines.ts). */
  engine(): Promise<"native" | "inbrowser" | null>;
  /** Whether Anagram reads this page: its site granted and switched on. */
  reads(url: string): Promise<boolean>;
  /** Whether the tab is the one in front of its window. */
  inFront(tabId: number): Promise<boolean>;
  /** The engine's state as the background last knew it (a health read never loads it). */
  state(): Promise<BackendStatus["active"]>;
  /** Ask the engine to start loading. */
  warm(): Promise<unknown>;
}

/** The navigation listener: whether it asked the engine to warm up. Never rejects. */
export function createWarmup(options: WarmupOptions): (navigation: Navigation) => Promise<boolean> {
  return async ({ tabId, frameId, url, documentLifecycle }) => {
    try {
      if (frameId !== 0 || tabId < 0 || documentLifecycle === "prerender" || !/^https?:/.test(url)) return false;
      if ((await options.engine()) !== "inbrowser") return false;
      if (!(await options.reads(url)) || !(await options.inFront(tabId))) return false;
      // Idle, or thought loaded: the engine may have let the model go since, and a warm-up of a
      // loaded engine changes nothing. Not set up, loading or failing: nothing to warm.
      const state = await options.state();
      if (state !== "idle" && state !== "server") return false;
      await options.warm();
      return true;
    } catch {
      return false;
    }
  };
}
