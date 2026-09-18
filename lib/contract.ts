// lib/contract.ts
// The versioned surface↔backend contract: the shapes the extension and the local
// anagramd daemon (anagramd/serve.py) exchange, and the seam everything above the
// socket codes against. Scoring only ever happens in that daemon; the test suites
// stand in for it with test/fake-daemon.mjs, which speaks the same contract.
//
// v2.0 (EditLens): the detector is a 4-way classifier over the EXTENT of AI editing
// (Thai et al., ICLR 2026 — pangram/editlens_roberta-large). A result carries the
// full bucket distribution plus its probability-weighted score; the UI derives
// verdict bands from the bucket and shows the score as "% AI".

export const CONTRACT_VERSION = "2.1";

/** Bucket count the UI is built for: 0 human · 1 lightly edited · 2 heavily edited · 3 AI-generated. */
export const BUCKET_COUNT = 4;

/**
 * One scoreable text as sent to the backend: a whole unit, or ONE WINDOW of a unit longer
 * than the model reads in one pass (lib/capture/windows.ts). The backend cannot tell the
 * two apart and does not need to.
 */
export interface ScoreBlock {
  /** Stable per-scan id ("u_3f" for a whole unit, "u_3f:1259-2567" for a window of it);
   *  results are matched by this, NOT by array index. */
  id: string;
  /** The canonical form (canonicalForScoring) of the unit's text, or of one window of it. */
  text: string;
  /** Optional neighbor context (tail of previous block) — reserved; may be "" in M1. */
  ctx_before?: string;
  /** Optional neighbor context (head of next block) — reserved; may be "" in M1. */
  ctx_after?: string;
  /** Sequence-length bucket hint (64/128/256/512). Optional in M1. */
  bucket?: number;
  /** Document order index, for stable sorting/streaming. */
  order: number;
}

/** Per-block detection result. EXACTLY the detector's IO contract. */
export interface ScoreResult {
  id: string;
  /** Predicted editing bucket (argmax): 0 = fully human … BUCKET_COUNT-1 = fully AI-generated. */
  bucket: number;
  /** Softmax probability per bucket, length BUCKET_COUNT, sums to 1. */
  probs: number[];
  /** Extent of AI editing in [0,1]: Σ probs[i]·i / (BUCKET_COUNT−1). Shown as "% AI". */
  score: number;
  /** Tokens the model actually saw (after truncation to its window). */
  tokens?: number;
  /** True when the text exceeded the model window and was cut (roberta: 512 tokens). The
   *  extension sizes its blocks so that this is rare, and re-reads a block that comes back
   *  cut as two halves. */
  truncated?: boolean;
  /** Detected language (fastText lid.176 label, e.g. "en") — set by the daemon, and
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
}

/** Identity of the backend that produced a batch — folded into every cache key. */
export interface ModelInfo {
  id: string;
  ver: string;
  calibration: string;
}

export type ScanPriority = "viewport" | "near" | "background";

/** Batch request: content script → service worker → ScoreClient. */
export interface ScoreBatchRequest {
  v: typeof CONTRACT_VERSION;
  /** Per-tab scan session id. */
  session: string;
  /** Origin surface tag. */
  surface: "chrome-ext" | "firefox-ext" | "safari-ext";
  priority: ScanPriority;
  /** Page language hint (best-effort; "und" if unknown). */
  lang: string;
  /** eTLD+1 domain hint only — never a full URL / PII. */
  domain: string;
  blocks: ScoreBlock[];
}

/** Batch response: ScoreClient → service worker → content script. Streamable. */
export interface ScoreBatchResponse {
  v: typeof CONTRACT_VERSION;
  session: string;
  /** Identifies the backend that produced these results. */
  model: ModelInfo;
  /** True if more results for this request are still coming (reserved for streaming). */
  partial: boolean;
  results: ScoreResult[];
}

/** One scored batch plus the identity of the backend that ACTUALLY produced it — the
 *  router caches under this, never under whatever the client reports afterwards. */
export interface ScoredBatch {
  results: ScoreResult[];
  model: ModelInfo;
}

/**
 * The backend seam. One implementation: HttpScoreClient, one POST per batch to the
 * local anagramd daemon (lib/backend/httpClient.ts), wrapped by the DaemonClient that
 * probes its health and owns its status — see lib/backend/getScoreClient.ts. There is
 * no in-extension scoring fallback: when the daemon is down, batches fail and the
 * router hands back degraded results.
 */
export interface ScoreClient {
  /** Score a batch of blocks. Returns one ScoreResult per input block (by id). */
  scoreBatch(blocks: ScoreBlock[]): Promise<ScoredBatch>;
  /** Best-known identity of the backend that will answer the next scoreBatch (sync). */
  model(): ModelInfo;
  /** Optional: settle backend discovery before model() is consulted for cache keys. */
  ready?(): Promise<void>;
}
