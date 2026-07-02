// lib/backend/swCache.ts — SW-side content-hash → ScoreResult cache (best-effort,
// ephemeral Map). Keyed by a sync hash of normalizeText(text) plus a model-version
// dimension so swapping the active backend invalidates stale entries.
import type { ScoreResult } from "../contract";
import { normalizeText } from "../dom/text";
import { cyrb53 } from "../hash";
import { STUB_MODEL } from "./randomStub";

export interface SwCache {
  get(text: string): ScoreResult | undefined;
  set(text: string, r: ScoreResult): void;
  keyOf(text: string): string; // sync hash of normalizeText(text), incl. model-version dim
}

/** Model-version dimension folded into every cache key (reference gap). */
const MODEL_DIM = `${STUB_MODEL.id}@${STUB_MODEL.ver}`;

export function createSwCache(): SwCache {
  const map = new Map<string, ScoreResult>();
  // 53-bit key (shared cyrb53) — the 32-bit FNV-1a this used made wrong-badge
  // collisions realistic across a long browsing session.
  const keyOf = (text: string): string =>
    `${MODEL_DIM}:${cyrb53(normalizeText(text)).toString(36)}`;
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
