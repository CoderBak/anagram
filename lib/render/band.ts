// lib/render/band.ts — confidence band mapping (Appendix B) + human-facing label.
import type { ScoreResult } from "../contract";

export type Band = "human" | "mixed" | "ai" | "unknown";

/** Derive the human-facing band from the contract (calibrated wording; never "98% AI"). */
export function band(r: ScoreResult): Band {
  if (r.p_value >= 0.99 && r.theta_interval[1] - r.theta_interval[0] > 0.5) return "unknown";
  if (r.detected) return "ai";
  if (r.e_theta >= 0.4) return "mixed"; // possible AI-assisted
  return "human";
}

/**
 * Badge text for each band. Honor the detector's vocabulary; never surface raw
 * percentages as truth claims.
 */
export const BAND_LABEL: Record<Band, string> = {
  human: "Human",
  mixed: "AI-Assisted",
  ai: "AI",
  unknown: "Insufficient",
};

/** Convenience: label directly from a result. */
export function bandLabel(r: ScoreResult): string {
  return BAND_LABEL[band(r)];
}
