// lib/log.ts — tiny namespaced debug logger, gated by settings.debug.
import { settings } from "./settings/settings";

let _enabled = false;
let _subscribed = false;

function ensureSubscribed(): void {
  if (_subscribed) return;
  _subscribed = true;
  void settings.debug.getValue().then((v) => {
    _enabled = v;
  });
  // Keep the gate live as the setting changes.
  settings.debug.watch((v) => {
    _enabled = v;
  });
}

export interface Logger {
  log(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

/** Create a namespaced logger. Output is suppressed unless `settings.debug` is true. */
export function createLogger(namespace: string): Logger {
  ensureSubscribed();
  const tag = `[pangram:${namespace}]`;
  return {
    log(...args: unknown[]) {
      if (_enabled) console.log(tag, ...args);
    },
    warn(...args: unknown[]) {
      if (_enabled) console.warn(tag, ...args);
    },
    error(...args: unknown[]) {
      // Errors always surface, namespaced.
      console.error(tag, ...args);
    },
  };
}
