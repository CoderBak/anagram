// lib/contract.ts
// The versioned surface↔backend contract carried by Native Messaging.
// Model inference runs in the local component or the in-browser engine; transport adapters
// and test fixtures exchange the same scoring payloads.
//
// EditLens: the detector is a 4-way classifier over the EXTENT of AI editing (Thai et al.,
// ICLR 2026 — pangram/editlens_roberta-large). A result carries the full bucket
// distribution plus its probability-weighted score; the chip's word comes from the score
// (lib/render/scale.ts levelOf), which it shows as a 0–1 number (".93").

import CONTRACT from "../anagramd/contract.json";

/** What both engines answer by, held in one file the local engine reads too
 *  (anagramd/contract.json, anagramd/engine.py): its version, the model's calibration, its four
 *  buckets, the languages it reads, and the most one request may carry. */
export const CONTRACT_VERSION = CONTRACT.version as "3.0";
export const CALIBRATION = CONTRACT.calibration;
export const BUCKET_LABELS: readonly string[] = CONTRACT.buckets;
export const SUPPORTED_LANGUAGES: readonly string[] = CONTRACT.languages;
export const CONTRACT_LIMITS = CONTRACT.limits;

/** A text's tokens counted word by word, in order: each word `alone`, as a pass starts
 *  on it, and `following` a space, as it reads inside a pass (the `tokens` operation). */
export interface TokenCounts {
  alone: number[];
  following: number[];
}

/** Bucket count the UI is built for: 0 human · 1 lightly edited · 2 heavily edited · 3 AI-generated. */
export const BUCKET_COUNT = 4;

/** What of one page the worker scores at once (lib/backend/router.ts answers Unavailable past
 *  it), and the batches a page keeps in flight inside it (lib/capture/orchestrator.ts): each
 *  batch is sent as requests of at most an equal part of the share (lib/capture/windows.ts). */
export const DOCUMENT_SHARE = Object.freeze({ blocks: 256, chars: 250_000 });
export const PAGE_IN_FLIGHT = 4;

/**
 * One scoreable text as sent to the backend: a whole unit, or ONE WINDOW of a unit longer
 * than the model reads in one pass (lib/capture/windows.ts). The backend cannot tell the
 * two apart and does not need to.
 */
export interface ScoreBlock {
  /** Stable per-scan id ("u_3f" for a whole unit, "u_3f:1259-2567" for a window of it);
   *  results are matched by this, NOT by array index. */
  id: string;
  /** The model form (modelText) of the unit's text, or of one window of it. */
  text: string;
}

/** Per-block detection result. EXACTLY the detector's IO contract. */
export interface ScoreResult {
  id: string;
  /** Predicted editing bucket (argmax): 0 = fully human … BUCKET_COUNT-1 = fully AI-generated. */
  bucket: number;
  /** Softmax probability per bucket, length BUCKET_COUNT, sums to 1. */
  probs: number[];
  /** Extent of AI editing in [0,1]: Σ probs[i]·i / (BUCKET_COUNT−1). Shown as ".93". */
  score: number;
  /** Tokens the model actually saw (after truncation to its window). */
  tokens?: number;
  /** True when the text exceeded the model window and was cut (roberta: 512 tokens). The
   *  extension sizes its blocks so that this is rare, and re-reads a block that comes back
   *  cut as two halves. */
  truncated?: boolean;
  /** Detected language (fastText lid.176 label, e.g. "en") — set by the local engine, and
   *  absent when it could not tell. */
  lang?: string;
  /** Confidence of `lang`, in [0,1]. */
  lang_prob?: number;
  /**
   * True when the block was NOT scored because its language is outside the model's
   * training languages (EditLens: English only). bucket/probs/score are placeholders;
   * render as "Unsupported language". A real, cacheable result (deterministic).
   */
  unsupported?: boolean;
  /**
   * True when this result is a transport/backend-failure FALLBACK, not a model
   * output. Degraded results render ("Unavailable") but must never enter any
   * cache — a transient outage must not pin permanent wrong verdicts. Additive
   * optional field; absent means a real result.
   */
  degraded?: boolean;
  /** True when the service worker answered from its cache and the engine read nothing: the
   *  PDF reader's pace (lib/pdf/readAhead.ts) learns only from what the engine read. */
  cached?: boolean;
}

/** Identity of the backend that produced a batch — folded into every cache key. */
export interface ModelInfo {
  id: string;
  ver: string;
  calibration: string;
}

/** A model's whole identity as one key: JSON avoids delimiter collisions and includes
 *  calibration, not just model/version. Here, beside ModelInfo, rather than with the worker's
 *  router: a page that compares two models has no use for the router's cache, and the content
 *  script carried it, IndexedDB wrapper and all, for this one line. */
export function modelDim(m: ModelInfo): string { return JSON.stringify([m.id, m.ver, m.calibration]); }

export type ScanPriority = "viewport" | "near" | "background";

/** Batch request: content script → service worker → ScoreClient. */
export interface ScoreBatchRequest {
  v: typeof CONTRACT_VERSION;
  /** Per-tab scan session id. */
  session: string;
  priority: ScanPriority;
  blocks: ScoreBlock[];
}

/** Batch response: ScoreClient → service worker → content script. */
export interface ScoreBatchResponse {
  v: typeof CONTRACT_VERSION;
  /** Identifies the backend that produced these results. */
  model: ModelInfo;
  results: ScoreResult[];
}

/** One scored batch plus the identity of the backend that ACTUALLY produced it — the
 *  router caches under this, never under whatever the client reports afterwards. */
export interface ScoredBatch {
  results: ScoreResult[];
  model: ModelInfo;
}

/**
 * The backend seam: batches go to the engine in use, the local component or the in-browser
 * one (lib/backend/). Failed batches become degraded results.
 */
export interface ScoreClient {
  /** Score a batch of blocks. Returns one ScoreResult per input block (by id). */
  scoreBatch(blocks: ScoreBlock[], signal?: AbortSignal): Promise<ScoredBatch>;
  /** Best-known identity of the backend that will answer the next scoreBatch (sync). */
  model(): ModelInfo;
  /** Runtime/disconnect generation, including changes that retain the same model label. */
  revision?(): number;
  /** Optional: settle backend discovery before model() is consulted for cache keys. */
  ready?(): Promise<void>;
}
