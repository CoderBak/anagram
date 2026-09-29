// lib/webengine/tier.ts — which model tier the in-browser engine runs, as the setup page decided.
//
// lib/device.ts decides from what a page can learn (memory, the adapter's features, free disk);
// the engine lives in an offscreen document or the background, which learn none of that. The
// page's answer travels with ACTIONS.SET_ENGINE and is kept in the extension's storage
// (./tierStore.ts) for the background to hand the engine when it starts (client.ts, assets.ts).
// Nothing stored means FP32, the automatic pick: an update from a release without tiers keeps it.
import type { ModelTier } from "./pin";

export interface TierChoice {
  tier: ModelTier;
  /** FP32 fits the device too (lib/device.ts Decision.fallback): what FP16 falls back to. */
  fallback: boolean;
}

export const tierOf = (choice: TierChoice | null | undefined): ModelTier => (choice?.tier === "fp16" ? "fp16" : "fp32");

/** A choice as an offscreen document's URL query, and back. */
export function tierQuery(choice: TierChoice | null | undefined): string {
  return choice?.tier === "fp16" ? `?tier=fp16${choice.fallback ? "&fallback=1" : ""}` : "";
}
export function tierFromQuery(search: string): TierChoice | null {
  const q = new URLSearchParams(search);
  return q.get("tier") === "fp16" ? { tier: "fp16", fallback: q.get("fallback") === "1" } : null;
}
