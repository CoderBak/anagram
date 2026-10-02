// lib/backend/setupFeed.ts — the in-browser engine's download, pushed to whoever shows it.
//
// The popup shows model download progress and paused pages wait for completion (EngineSetup,
// lib/backend/engineSetup.ts). Each asks the background once (GET_BACKEND_STATUS); when the
// answer is a running download, the background follows it for them: it reads the engine's
// status every FOLLOW_MS and tells each of them every new figure (ACTIONS.ENGINE_SETUP), so
// the two move with the download and show the same number. It stops at the first figure that
// is not a running download, which is told too, or when nobody is left to tell: nothing is
// read or sent while no download runs, or while nobody shows one. The popup is the exception:
// it is open for a moment, and a download started or resumed from another page meanwhile (its
// answer was "not set up", "paused" or "failed") must reach it, so it is followed through those
// waits too, at WAITING_MS, until it closes (a push it cannot take drops it).
import type { EngineSetup } from "../messaging/protocol";

/** Who is told: one paused frame of a tab, or the extension's pages (the popup). */
export type SetupListener = { tabId: number; frameId: number; documentId?: string } | "pages";

/** How often a running download is read while somebody shows it. */
export const FOLLOW_MS = 500;
/** How often the popup, showing a wait, is looked for a download that started. */
export const WAITING_MS = 1_000;

export interface SetupFeedOptions {
  /** The engine's setup now, or null when setup is not what keeps it from scoring. */
  read(): Promise<EngineSetup | null>;
  /** Tell one listener; false (or a rejection) when it no longer shows the download. */
  tell(listener: SetupListener, setup: EngineSetup | null): Promise<boolean>;
  every?: number;
  waitingEvery?: number;
}

export interface SetupFeed {
  /** A listener was just answered `setup`: follow the download for it while one runs. */
  follow(listener: SetupListener, setup: EngineSetup | null | undefined): void;
  /** A tab closed. */
  forget(tabId: number): void;
  /** How many are followed, for the suites. */
  listeners(): number;
}

const keyOf = (listener: SetupListener): string =>
  listener === "pages" ? "pages" : `${listener.tabId}:${listener.frameId}`;
const same = (a: EngineSetup | null, b: EngineSetup | null): boolean =>
  a?.state === b?.state && a?.percent === b?.percent;
/** Nothing runs yet, and something may start it: not set up, paused, stopped short. */
const waiting = (s: EngineSetup | null | undefined): boolean => s?.state === "needed" || s?.state === "paused" || s?.state === "failed";

export function createSetupFeed({ read, tell, every = FOLLOW_MS, waitingEvery = WAITING_MS }: SetupFeedOptions): SetupFeed {
  const listeners = new Map<string, SetupListener>();
  /** The figure last told, or the one the first listener was answered with. */
  let told: EngineSetup | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reading = false;

  const schedule = (): void => {
    if (timer !== null || reading || listeners.size === 0) return;
    timer = setTimeout(() => void tick(), told?.state === "downloading" ? every : waitingEvery);
  };

  async function tick(): Promise<void> {
    timer = null;
    if (listeners.size === 0) return;
    reading = true;
    try {
      const now = await read().catch(() => null);
      if (!same(now, told)) {
        told = now;
        await Promise.all([...listeners].map(async ([key, listener]) => {
          if (!(await tell(listener, now).catch(() => false))) listeners.delete(key);
        }));
      }
      // What is left to tell: the running download's watchers, and a popup that waits for one.
      for (const [key, listener] of listeners) if (now?.state !== "downloading" && !(listener === "pages" && waiting(now))) listeners.delete(key);
    } finally {
      reading = false;
    }
    schedule();
  }

  return {
    follow(listener, setup) {
      if (!setup || (setup.state !== "downloading" && !(listener === "pages" && waiting(setup)))) return;
      if (listeners.size === 0 && !reading) told = setup;
      listeners.set(keyOf(listener), listener);
      schedule();
    },
    forget(tabId) {
      for (const [key, listener] of listeners) if (listener !== "pages" && listener.tabId === tabId) listeners.delete(key);
    },
    listeners: () => listeners.size,
  };
}
