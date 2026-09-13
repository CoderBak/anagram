// lib/backend/swCache.ts — SW-side content-hash → ScoreResult cache (best-effort,
// ephemeral Map). Keyed by a sync hash of normalizeText(text) plus a model-version
// dimension so swapping the active backend invalidates stale entries.
import type { ScoreResult } from "../contract";
import { normalizeText } from "../dom/text";
import { cyrb53 } from "../hash";

export interface SwCache {
  get(text: string): ScoreResult | undefined;
  set(text: string, r: ScoreResult): void;
  keyOf(text: string): string; // sync hash of normalizeText(text), incl. model-version dim
}

/**
 * @param modelDim current backend identity ("id@ver") — evaluated per call, because
 *   the active backend can change mid-session (daemon started/stopped, mode switched).
 */
export function createSwCache(modelDim: () => string): SwCache {
  const map = new Map<string, ScoreResult>();
  // 53-bit key (shared cyrb53) — the 32-bit FNV-1a this used made wrong-badge
  // collisions realistic across a long browsing session.
  const keyOf = (text: string): string =>
    `${modelDim()}:${cyrb53(normalizeText(text)).toString(36)}`;
  return {
    keyOf,
    get(text) {
      return map.get(keyOf(text));
    },
    set(text, r) {
      map.set(keyOf(text), r);
    },
  };
}
