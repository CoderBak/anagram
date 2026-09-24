// lib/render/band.ts — the four words a verdict can read as, plus the two non-verdicts.
//
// The model classifies the EXTENT of AI editing into four buckets. The word is the
// bucket whose slice of the scale contains the score (lib/render/scale.ts), not the most
// likely bucket, so the word and the number never disagree. "unknown" is not a model
// output — it is what a degraded (backend-failure) result renders as.
import type { ScoreResult } from "../contract";
import { messageLocale, t, type MessageKey } from "../i18n";
import { levelOf } from "./scale";

export type Band = "human" | "light" | "heavy" | "ai" | "unknown" | "unsupported";

/** Bucket index → band, in model order. */
export const BUCKET_BANDS: readonly Band[] = ["human", "light", "heavy", "ai"];

/** Derive the human-facing band from the contract: from the score, not the bucket. */
export function band(r: ScoreResult): Band {
  if (r.degraded) return "unknown";
  if (r.unsupported) return "unsupported";
  return BUCKET_BANDS[levelOf(r.score)];
}

const BAND_KEY: Record<Band, MessageKey> = {
  human: "bandHuman",
  light: "bandLight",
  heavy: "bandHeavy",
  ai: "bandAi",
  unknown: "bandUnavailable",
  unsupported: "bandUnsupported",
};

/** Badge text for each band — the model's own vocabulary, never "98 % certain". A
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
