// lib/render/band.ts — verdict bands for the EditLens 4-bucket contract + labels.
//
// The model classifies the EXTENT of AI editing into four buckets; each bucket is a
// band with its own colour. "unknown" is not a model output — it is what a degraded
// (backend-failure) result renders as.
import type { ScoreResult } from "../contract";
import { messageLocale, t, type MessageKey } from "../i18n";

export type Band = "human" | "light" | "heavy" | "ai" | "unknown" | "unsupported";

/** Bucket index → band, in model order. */
export const BUCKET_BANDS: readonly Band[] = ["human", "light", "heavy", "ai"];

/** Derive the human-facing band from the contract. */
export function band(r: ScoreResult): Band {
  if (r.degraded) return "unknown";
  if (r.unsupported) return "unsupported";
  return BUCKET_BANDS[r.bucket] ?? "unknown";
}

const BAND_KEY: Record<Band, MessageKey> = {
  human: "bandHuman",
  light: "bandLight",
  heavy: "bandHeavy",
  ai: "bandAi",
  unknown: "bandUnavailable",
  unsupported: "bandUnsupported",
};

/** Badge text for each band — the model's own vocabulary, never "98% certain". A
 *  function, not a table: the language is the browser's and is read at paint time. */
export function bandLabel(b: Band): string {
  return t(BAND_KEY[b]);
}

/** Bands that carry no verdict and therefore get no mark and no distribution readout. */
export function isNoVerdict(b: Band): boolean {
  return b === "unknown" || b === "unsupported";
}

/** "Chinese (zh)" via the browser's own display-name tables, in the UI's own language;
 *  falls back to the code. */
export function languageName(code: string | undefined): string {
  if (!code) return t("langUnknown");
  try {
    const name = new Intl.DisplayNames([messageLocale()], { type: "language" }).of(code);
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
