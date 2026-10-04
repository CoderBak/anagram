// lib/capture/backendWatch.ts — whether the engine answers, as a page sees it.
//
// In-flight batches render "Unavailable" (degraded results, never cached). Nothing else is
// dispatched until the worker's probe finds the engine up, idle or loading again; then every
// Unavailable unit is re-observed so it re-dispatches by visibility, and the queue resumes.
// Loading is the in-browser engine's, which holds what it is sent until its model is in (the
// local engine says "not ready" while it loads: down). The orchestrator says what follows a
// change (lib/capture/orchestrator.ts); this keeps the state, the polling and the probe.
import type { ModelInfo } from "../contract";
import type { BackendStatus } from "../messaging/protocol";

export interface BackendWatch {
  /** The engine stopped answering: dispatch is paused until a probe finds it again. */
  readonly down: boolean;
  /** What a reply said of the engine ("down", "up", or nothing about it). */
  heard(backend: string | undefined): void;
  /** Ask the worker now. `force`: somebody's Retry, which may start an engine it gave up on. */
  check(force: boolean): Promise<void>;
  /** The page froze: no more polling, and what was heard stays. */
  halt(): void;
  /** The run is over: no more polling, and up for the next run. */
  reset(): void;
}

export function createBackendWatch(o: {
  /** While down, how often the worker is asked again. */
  pollMs: number;
  /** Ask the worker where the engine stands. */
  probe(force: boolean): Promise<BackendStatus | undefined>;
  /** The extension's context is still alive; when it is not, the page freezes. */
  alive(): boolean;
  freeze(): void;
  /** The engine went down (true) or came back (false). */
  changed(down: boolean): void;
  /** What a probe heard, whatever it was (the device the engine runs on). */
  learned(status: BackendStatus | undefined): void;
  /** A probe found the engine up, with this model: it may have come back as another. */
  adopt(model: ModelInfo | null): void;
  /** The capture's generation: a probe answered after the run moved on counts for nothing. */
  generation(): number;
}): BackendWatch {
  let down = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const stopPolling = (): void => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
  const watch: BackendWatch = {
    get down() { return down; },
    heard(backend) {
      if (backend === "down" && !down) {
        down = true;
        o.changed(true);
        timer ??= setInterval(() => void watch.check(false), o.pollMs);
        // The engine may be down for want of setup, which the popup says at once.
        void watch.check(false);
      } else if (backend === "up" && down) {
        down = false;
        stopPolling();
        o.changed(false);
      }
    },
    async check(force) {
      const generation = o.generation();
      if (!o.alive()) {
        o.freeze();
        return;
      }
      try {
        const status = await o.probe(force);
        if (generation !== o.generation()) return;
        o.learned(status);
        if (status?.active === "server" || status?.active === "idle" || status?.active === "loading") {
          watch.heard("up");
          // A page whose paragraphs are all cache hits sends no request at all, so the probe
          // is the only place such a tab can notice the engine came back as another model.
          o.adopt(status.model);
        }
      } catch {
        /* worker restarting — next tick */
      }
    },
    halt: stopPolling,
    reset() {
      stopPolling();
      down = false;
    },
  };
  return watch;
}
