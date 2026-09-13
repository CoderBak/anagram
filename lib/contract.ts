// lib/contract.ts
// The versioned surface↔backend contract. Identical shape for the random stub and the
// eventual real anagram daemon — nothing above the socket changes when the backend swaps.

export const CONTRACT_VERSION = "1.0";

/** One scoreable paragraph as sent to the backend. */
export interface ScoreBlock {
  /** Stable per-scan id (e.g. "b_3f9a"); rendering keys off this, NOT array index. */
  id: string;
  /** The exact paragraph text (join of the unit's text nodes). */
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
  /** True if the block is judged AI-generated. */
  detected: boolean;
  /** Calibrated AI-probability credible interval [lo, hi], both in [0,1], lo <= hi. */
  theta_interval: [number, number];
  /** Point estimate of AI-probability (theta), in [0,1]. */
  e_theta: number;
  /** p-value of the human-null hypothesis (small ⇒ strong AI evidence), in [0,1]. */
  p_value: number;
  /** Optional per-sentence AI flags, aligned to sentence split of `text`. */
  sentence_flags?: boolean[];
  /**
   * True when this result is a transport/backend-failure FALLBACK, not a model
   * output. Degraded results render ("Insufficient") but must never enter any
   * cache — a transient outage must not pin permanent wrong verdicts. Additive
   * optional field; absent means a real result.
   */
  degraded?: boolean;
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
  model: { id: string; ver: string; calibration: string };
  /** True if more results for this request are still coming (reserved for streaming). */
  partial: boolean;
  results: ScoreResult[];
}

/**
 * The swappable backend seam. M1 implementation = RandomStubScoreClient (in-extension).
 * Future: HttpScoreClient / NativeScoreClient (connectNative → anagramd) drop in here
 * with zero content-script changes.
 */
export interface ScoreClient {
  /** Score a batch of blocks. Returns one ScoreResult per input block (by id). */
  scoreBatch(blocks: ScoreBlock[]): Promise<ScoreResult[]>;
}
