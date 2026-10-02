// lib/backend/engines.ts — which engine scores: the local engine over Native Messaging, or
// the same model inside the browser. One extension carries both; the person's choice (the
// setup page, lib/device.ts; or Settings) decides at run time.
//
// Never import this in a page: it holds the background worker's transports. Pages ask the
// worker (ACTIONS.GET_ENGINE, SET_ENGINE).
import { browser, storage } from "#imports";
import { nativeTransport } from "./nativeTransport";
import { closeWebEngine, webEngineTransport } from "../webengine/client";
import { NativeTransportError, type EngineTransport } from "./transport";
import { ENGINES, NATIVE_PERMISSION, type Engine } from "./engineChoice";
import type { NativeOperation, NativePayload, NativeReply } from "./nativeProtocol";
import { IS_SAFARI } from "../surface";

export { ENGINES, NATIVE_PERMISSION, type Engine } from "./engineChoice";

/** What the person chose; unset until they did. */
export const engineChoice = storage.defineItem<Engine | null>("local:engine", { fallback: null });

/** Whether Native Messaging is granted: optional, asked for when the local engine is picked. */
export async function nativeGranted(): Promise<boolean> {
  try { return await browser.permissions.contains(NATIVE_PERMISSION); } catch { return false; }
}

/**
 * The engine that scores: the one chosen; else the local engine where Native Messaging is
 * granted (an update from a release that required it keeps it, and its engine); else none
 * yet, and the setup page decides.
 */
export async function activeEngine(): Promise<Engine | null> {
  const chosen = await engineChoice.getValue().catch(() => null);
  if (chosen && ENGINES.includes(chosen)) return chosen;
  // Safari declares nativeMessaging for the containing-app bridge, even when the
  // browser engine is chosen. A permission is not an engine choice there.
  return !IS_SAFARI && (await nativeGranted()) ? "native" : null;
}

/** Each engine's own transport, whichever is in use. */
export function transportOf(engine: Engine): EngineTransport {
  return engine === "native" ? nativeTransport() : webEngineTransport();
}

/**
 * The transport of the engine in use, which follows the choice: switching closes the other
 * engine (the in-browser one lets its model go) and tells the listeners, so health is read
 * again. With no engine chosen yet, every request is refused as unavailable.
 */
class ActiveEngineTransport implements EngineTransport {
  private engine: Engine | null | undefined;
  private reading: Promise<Engine | null> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor() {
    for (const engine of ENGINES) transportOf(engine).onDisconnect(() => { if (this.engine === engine) this.notify(); });
    engineChoice.watch(() => void this.refresh());
    // A grant or its withdrawal moves an engine nobody chose between none and the local one.
    for (const event of [browser.permissions?.onAdded, browser.permissions?.onRemoved]) {
      try { event?.addListener(() => void this.refresh()); } catch { /* no such event here */ }
    }
  }

  /** The engine in use, read once and then followed. */
  current(): Promise<Engine | null> {
    if (this.engine !== undefined) return Promise.resolve(this.engine);
    return this.reading ??= activeEngine().then((engine) => {
      this.reading = null;
      if (this.engine === undefined) this.engine = engine;
      return this.engine;
    });
  }

  /** Read the choice again, and move to it. */
  async refresh(): Promise<Engine | null> {
    this.use(await activeEngine());
    return this.engine ?? null;
  }

  private use(engine: Engine | null): void {
    const before = this.engine;
    this.engine = engine;
    if (before === engine || before === undefined) return;
    if (before === "inbrowser") void closeWebEngine();
    else if (before) transportOf(before).close("native_unavailable", "The engine was switched");
    this.notify();
  }

  async request(op: NativeOperation, payload?: NativePayload, signal?: AbortSignal, timeout?: number): Promise<NativeReply> {
    const engine = await this.current();
    if (!engine) throw new NativeTransportError("native_unavailable", "No engine is set up yet");
    return transportOf(engine).request(op, payload, signal, timeout);
  }

  onDisconnect(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(code?: string, message?: string): void {
    if (this.engine) transportOf(this.engine).close(code, message);
    else this.notify();
  }

  retry(): void {
    if (this.engine) transportOf(this.engine).retry?.();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

let instance: ActiveEngineTransport | undefined;
/** The engine in use, as one transport (lib/backend/transport.ts). */
export function engineTransport(): ActiveEngineTransport {
  return instance ??= new ActiveEngineTransport();
}
