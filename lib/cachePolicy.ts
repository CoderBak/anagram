/** Retention starts at production time; reading a verdict never extends it. */
export const SCORE_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export type ScoreCacheMode = "persistent" | "session";
