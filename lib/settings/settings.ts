// lib/settings/settings.ts
// The `twpConfig` replacement, thin over WXT `storage`. Provides get/set/watch/onReady
// + per-site helpers with always/never mutual exclusion. (spec §4.10)
import { storage } from "#imports";

export const settings = {
  enabled: storage.defineItem<boolean>("local:enabled", { fallback: true }),
  siteOverrides: storage.defineItem<Record<string, "on" | "off">>("local:siteOverrides", { fallback: {} }),
  showHighlights: storage.defineItem<boolean>("local:showHighlights", { fallback: false }),
  debug: storage.defineItem<boolean>("local:debug", { fallback: false }),
  scorePre: storage.defineItem<boolean>("local:scorePre", { fallback: false }),
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

let _ready: Promise<void> | null = null;
function hydrate(): Promise<void> {
  if (!_ready) {
    // Touch every item once so storage is read at least once; resolves after first hydrate.
    _ready = Promise.all([
      settings.enabled.getValue(),
      settings.siteOverrides.getValue(),
      settings.showHighlights.getValue(),
      settings.debug.getValue(),
      settings.scorePre.getValue(),
    ]).then(() => undefined);
  }
  return _ready;
}

/** Resolves the callback after the first storage hydrate. */
export function onReady(cb: () => void): void {
  void hydrate().then(cb);
}
