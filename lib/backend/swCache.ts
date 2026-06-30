// lib/backend/swCache.ts — SW-side content-hash → ScoreResult cache (best-effort,
// ephemeral Map). Keyed by a sync hash of normalizeText(text) plus a model-version
// dimension so swapping the active backend invalidates stale entries.
import type { ScoreResult } from "../contract";
import { normalizeText } from "../dom/text";
import { STUB_MODEL } from "./randomStub";

export interface SwCache {
  get(text: string): ScoreResult | undefined;
  set(text: string, r: ScoreResult): void;
  keyOf(text: string): string; // sync hash of normalizeText(text), incl. model-version dim
}

/** Model-version dimension folded into every cache key (reference gap). */
const MODEL_DIM = `${STUB_MODEL.id}@${STUB_MODEL.ver}`;

/** Small synchronous string hash (FNV-1a) — adequate for a per-tab cache key. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

export function createSwCache(): SwCache {
  const map = new Map<string, ScoreResult>();
  const keyOf = (text: string): string =>
    `${MODEL_DIM}:${fnv1a(normalizeText(text))}`;
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
