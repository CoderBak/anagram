// lib/backend/engineChoice.ts — the two engines by name, for the worker (./engines.ts) and
// the pages alike; no transport in here.
import { browser } from "#imports";
import { ACTIONS } from "../messaging/protocol";

export type Engine = "native" | "inbrowser";
export const ENGINES: readonly Engine[] = ["native", "inbrowser"];

/** The permission the local engine needs, asked for when the person picks it. */
export const NATIVE_PERMISSION = { permissions: ["nativeMessaging" as const] };

/** What the worker answers ACTIONS.SET_ENGINE with. */
export interface SetEngineReply {
  ok: boolean;
  engine?: Engine | null;
  /** In-browser setup: "started", or why the download did not start by itself (lib/webengine/autoSetup.ts). */
  setup?: string;
  error?: string;
}

/** The engine in use, asked of the worker; null before one is chosen, or when it cannot say. */
export async function readEngine(): Promise<Engine | null> {
  try {
    const reply = await browser.runtime.sendMessage({ action: ACTIONS.GET_ENGINE }) as { engine?: unknown } | undefined;
    return reply?.engine === "native" || reply?.engine === "inbrowser" ? reply.engine : null;
  } catch { return null; }
}

/**
 * Make `engine` the one in use. `setup`: the in-browser engine's download starts, "now" as
 * the person asked for it, or "auto" as it does by itself on a device with no choice (not
 * after a Cancel, nor while the browser asks to save data). The local engine needs Native
 * Messaging granted first, in the click that picked it.
 */
export async function chooseEngine(engine: Engine, setup?: "now" | "auto"): Promise<SetEngineReply> {
  try {
    const reply = await browser.runtime.sendMessage({ action: ACTIONS.SET_ENGINE, engine, ...(setup ? { setup } : {}) }) as SetEngineReply | undefined;
    return reply ?? { ok: false, error: "no_reply" };
  } catch { return { ok: false, error: "no_worker" }; }
}

/**
 * Ask for Native Messaging. Call it first thing in the click that picked the local engine:
 * the browsers honour a request only inside the person's gesture.
 */
export function requestNative(): Promise<boolean> {
  try { return browser.permissions.request(NATIVE_PERMISSION).catch(() => false); } catch { return Promise.resolve(false); }
}
