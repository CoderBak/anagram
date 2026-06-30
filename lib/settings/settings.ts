// lib/settings/settings.ts
// The `twpConfig` replacement, thin over WXT `storage`. Provides get/set/watch/onReady
// + per-site helpers with always/never mutual exclusion. (spec §4.10)
import { storage } from "#imports";

export const DEFAULT_SERVER_URL = "http://127.0.0.1:8765";

/**
 * Only a loopback daemon may score page text — "nothing leaves this computer" is
 * enforced here and in the service-worker client, not merely promised.
 */
export function isLoopbackUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return h === "localhost" || h === "::1" || /^127\.\d+\.\d+\.\d+$/.test(h);
  } catch {
    return false;
  }
}

/** Trim + strip trailing slashes; null when not a loopback http(s) URL. */
export function normalizeServerUrl(raw: string): string | null {
  const url = raw.trim().replace(/\/+$/, "");
  return url && isLoopbackUrl(url) ? url : null;
}

export const settings = {
  // The local anagramd daemon that scores paragraphs (loopback only). There is no
  // other backend: when it does not answer, paragraphs are "Unavailable".
  serverUrl: storage.defineItem<string>("local:serverUrl", { fallback: DEFAULT_SERVER_URL }),
  enabled: storage.defineItem<boolean>("local:enabled", { fallback: true }),
  siteOverrides: storage.defineItem<Record<string, "on" | "off">>("local:siteOverrides", { fallback: {} }),
  // The paragraph underline is part of the core product; on by default (orchestrator
  // respects live changes to this setting).
  showHighlights: storage.defineItem<boolean>("local:showHighlights", { fallback: true }),
  debug: storage.defineItem<boolean>("local:debug", { fallback: false }),
  // What to paint: every analyzed unit, or only flagged (heavily edited / AI-generated) ones.
  // Everything is still ANALYZED either way — this filters rendering only.
  displayMode: storage.defineItem<"all" | "flagged">("local:displayMode", {
    fallback: "all",
  }),
  // Group sub-floor paragraphs with neighbors to reach the evidence floor (the
  // chip shows ×N). Off = strict per-paragraph mode; short paragraphs are skipped.
  mergeShorts: storage.defineItem<boolean>("local:mergeShorts", { fallback: true }),
  // How analyzed text is marked in place. "both" = underline + light tint
  // (default), or each alone. showHighlights remains the master on/off.
  markStyle: storage.defineItem<"both" | "underline" | "tint">("local:markStyle", {
    fallback: "both",
  }),
  // What part of the page to analyze. "page" = everything except recognized
  // chrome (default); "main" = only the detected main-content region
  // (Readability-guided precision mode — comments/sidebars outside it are skipped).
  analysisScope: storage.defineItem<"page" | "main">("local:analysisScope", {
    fallback: "page",
  }),
  // FAB position per host: bottom offset + snapped side. Legacy entries carry
  // only {r,b} (pre-snap free positions) — side is derived from r on restore.
  fabPos: storage.defineItem<
    Record<string, { r: number; b: number; side?: "left" | "right" }>
  >("local:fabPos", {
    fallback: {},
  }),
};

/**
 * Whether scoring is enabled for a given hostname. A per-site override ("on"/"off")
 * wins over the global `enabled` flag; otherwise the global flag decides.
 */
export async function enabledForSite(hostname: string): Promise<boolean> {
  const overrides = await settings.siteOverrides.getValue();
  const override = overrides[hostname];
  if (override === "on") return true;
  if (override === "off") return false;
  return settings.enabled.getValue();
}

/**
 * Set (or clear) a per-site override. "on" forces scoring on for the host; "off" forces
 * it off. The two are mutually exclusive (setting one replaces the other for that host).
 */
export async function setSiteOverride(hostname: string, v: "on" | "off"): Promise<void> {
  const overrides = { ...(await settings.siteOverrides.getValue()) };
  overrides[hostname] = v;
  await settings.siteOverrides.setValue(overrides);
}

/**
 * Clear any per-site override for a host (fall back to the global `enabled` flag).
 */
export async function clearSiteOverride(hostname: string): Promise<void> {
  const overrides = { ...(await settings.siteOverrides.getValue()) };
  if (hostname in overrides) {
    delete overrides[hostname];
    await settings.siteOverrides.setValue(overrides);
  }
}

