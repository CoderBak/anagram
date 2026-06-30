// lib/render/band.ts — verdict bands for the EditLens 4-bucket contract + labels.
//
// The model classifies the EXTENT of AI editing into four buckets; each bucket is a
// band with its own colour. "unknown" is not a model output — it is what a degraded
// (backend-failure) result renders as.
import type { ScoreResult } from "../contract";

export type Band = "human" | "light" | "heavy" | "ai" | "unknown" | "unsupported";

/** Bucket index → band, in model order. */
export const BUCKET_BANDS: readonly Band[] = ["human", "light", "heavy", "ai"];

/** Derive the human-facing band from the contract. */
export function band(r: ScoreResult): Band {
  if (r.degraded) return "unknown";
  if (r.unsupported) return "unsupported";
  return BUCKET_BANDS[r.bucket] ?? "unknown";
}

/** Badge text for each band — the model's own vocabulary, never "98% certain". */
export const BAND_LABEL: Record<Band, string> = {
  human: "Human",
  light: "Lightly edited",
  heavy: "Heavily edited",
  ai: "AI-generated",
  unknown: "Unavailable",
  unsupported: "Unsupported language",
};

/** Bands that carry no verdict and therefore get no mark and no distribution readout. */
export function isNoVerdict(b: Band): boolean {
  return b === "unknown" || b === "unsupported";
}

/** "Chinese (zh)" via the browser's own display-name tables; falls back to the code. */
export function languageName(code: string | undefined): string {
  if (!code) return "unknown";
  try {
    const name = new Intl.DisplayNames(["en"], { type: "language" }).of(code);
    return name && name !== code ? `${name} (${code})` : code;
  } catch {
    return code;
  }
}

/** Bands that count as "flagged" (counter, triage panel, toolbar badge, flagged-only mode). */
export function isFlaggedBand(b: Band): boolean {
  return b === "heavy" || b === "ai";
}

export function isFlagged(r: ScoreResult): boolean {
  return isFlaggedBand(band(r));
}

/** The chip number: extent of AI editing as a whole percentage. */
export function scorePct(r: ScoreResult): number {
  return Math.round(r.score * 100);
}
