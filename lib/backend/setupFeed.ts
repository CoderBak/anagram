// lib/backend/setupFeed.ts — the in-browser engine's download, pushed to whoever shows it.
//
// The popup and the in-page panel say how far the model's download has got (EngineSetup,
// lib/backend/engineSetup.ts). Each asks the background once (GET_BACKEND_STATUS); when the
// answer is a running download, the background follows it for them: it reads the engine's
// status every FOLLOW_MS and tells each of them every new figure (ACTIONS.ENGINE_SETUP), so
// the two move with the download and show the same number. It stops at the first figure that
// is not a running download, which is told too, or when nobody is left to tell: nothing is
// read or sent while no download runs, or while nobody shows one.
import type { EngineSetup } from "../messaging/protocol";

/** Who is told: one frame of a tab (the panel), or the extension's pages (the popup). */
export type SetupListener = { tabId: number; frameId: number; documentId?: string } | "pages";

/** How often a running download is read while somebody shows it. */
export const FOLLOW_MS = 500;

export interface SetupFeedOptions {
  /** The engine's setup now, or null when setup is not what keeps it from scoring. */
  read(): Promise<EngineSetup | null>;
  /** Tell one listener; false (or a rejection) when it no longer shows the download. */
  tell(listener: SetupListener, setup: EngineSetup | null): Promise<boolean>;
  every?: number;
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

export function createSetupFeed({ read, tell, every = FOLLOW_MS }: SetupFeedOptions): SetupFeed {
  const listeners = new Map<string, SetupListener>();
  /** The figure last told, or the one the first listener was answered with. */
  let told: EngineSetup | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let reading = false;

  const schedule = (): void => {
    if (timer !== null || reading || listeners.size === 0) return;
    timer = setTimeout(() => void tick(), every);
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
      if (now?.state !== "downloading") listeners.clear();
    } finally {
      reading = false;
    }
    schedule();
  }

  return {
    follow(listener, setup) {
      if (setup?.state !== "downloading") return;
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
