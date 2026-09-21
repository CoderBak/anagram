// Storage-backed reading preferences and per-site rules.
import { browser, storage } from "#imports";
import type { ScoreCacheMode } from "../cachePolicy";
export type { ScoreCacheMode } from "../cachePolicy";

export const cacheModeStorage = storage.defineItem<ScoreCacheMode>("local:cacheMode", { fallback: "persistent" });

/** Remove retired connection preferences without reading or honoring their values. */
export async function removeObsoleteConnectionSettings(): Promise<void> {
  await browser.storage.local.remove(["serverUrl", "backendTransport"]);
}

/** Marking styles shared with the renderer without importing it into the worker. */
export type MarkStyle = "quiet" | "always";

/** Preserve explicit legacy styles as "always"; the old default "both" becomes "quiet". */
export type StoredMarkStyle = MarkStyle | "both" | "underline" | "tint";

/** Unknown stored values use the default. */
export function normalizeMarkStyle(stored: StoredMarkStyle | undefined | null): MarkStyle {
  if (stored === "always" || stored === "underline" || stored === "tint") return "always";
  return "quiet";
}

export const settings = {
  enabled: storage.defineItem<boolean>("local:enabled", { fallback: true }),
  siteOverrides: storage.defineItem<Record<string, "on" | "off">>("local:siteOverrides", { fallback: {} }),
  // Master switch for text marks; applies to open tabs.
  showHighlights: storage.defineItem<boolean>("local:showHighlights", { fallback: true }),
  // Replacing the browser's PDF viewer requires opt-in; manual opening stays available.
  autoOpenPdfs: storage.defineItem<boolean>("local:autoOpenPdfs", { fallback: false }),
  debug: storage.defineItem<boolean>("local:debug", { fallback: false }),
  reportIncludeText: storage.defineItem<boolean>("local:reportIncludeText", { fallback: false }),
  reportIncludeUrl: storage.defineItem<boolean>("local:reportIncludeUrl", { fallback: false }),
  // Filters rendering, not analysis: all units or only heavily edited / AI-generated ones.
  displayMode: storage.defineItem<"all" | "flagged">("local:displayMode", {
    fallback: "all",
  }),
  // Group short neighbors to reach the evidence floor; otherwise skip short paragraphs.
  mergeShorts: storage.defineItem<boolean>("local:mergeShorts", { fallback: true }),
  // Read legacy values through normalizeMarkStyle(); showHighlights controls visibility.
  markStyle: storage.defineItem<StoredMarkStyle>("local:markStyle", {
    fallback: "quiet",
  }),
  // "main" restricts analysis to the Readability region, excluding outside comments/sidebars.
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

// Per-site rules inherit from parent domains; the most specific wins. Ignore leading www.

/** What a rule says: force scoring on, or force it off. */
export type SiteMode = "on" | "off";

/** Which stored rule decides a host, and what it says. */
export interface SiteRule {
  /** The hostname the rule is STORED under — the key to pass to `clearSiteOverride`. */
  host: string;
  mode: SiteMode;
}

/** Stop inheritance at common public/hosting suffixes so unrelated sites stay separate.
 *  This is a limited guard, not the complete Public Suffix List. */
const SUFFIX_GUARD = new Set([
  // country second levels
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "id.au",
  "com.cn", "net.cn", "org.cn", "gov.cn", "edu.cn", "ac.cn",
  "co.jp", "or.jp", "ne.jp", "ac.jp", "go.jp",
  "co.kr", "or.kr", "ne.kr", "go.kr",
  "com.br", "net.br", "org.br", "gov.br",
  "co.in", "net.in", "org.in", "gov.in", "ac.in",
  "co.nz", "net.nz", "org.nz", "govt.nz", "ac.nz",
  "co.za", "org.za", "net.za",
  "com.mx", "com.ar", "com.tr", "com.sg", "com.hk", "com.tw", "com.pl", "com.es", "com.ru",
  // one-site-per-subdomain hosting
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app",
  "herokuapp.com", "appspot.com", "firebaseapp.com", "web.app", "glitch.me", "repl.co",
  "blogspot.com", "wordpress.com", "substack.com", "notion.site", "translate.goog",
]);

/** Compare hostnames without case, trailing dots or a leading www. */
export function normalizeRuleHost(hostname: string): string {
  const h = hostname.trim().toLowerCase().replace(/\.+$/, "");
  return h.startsWith("www.") ? h.slice(4) : h;
}

/** Literal addresses and localhost match exactly, without parent-domain inheritance. */
function isLiteralHost(host: string): boolean {
  return host === "localhost" || host.includes(":") || host.startsWith("[") || /^\d+(?:\.\d+)*$/.test(host);
}

/** The hostnames a rule for `host` may be stored under, most specific first. */
function ruleCandidates(host: string): string[] {
  const key = normalizeRuleHost(host);
  if (key === "") return [];
  if (isLiteralHost(key)) return [key];
  const out = [key];
  for (let rest = key; ; ) {
    const cut = rest.indexOf(".");
    if (cut < 0) break;
    const parent = rest.slice(cut + 1);
    // Do not inherit rules from a TLD or guarded public suffix.
    if (!parent.includes(".") || SUFFIX_GUARD.has(parent)) break;
    out.push(parent);
    rest = parent;
  }
  return out;
}

/** Stored key per normalized hostname; the plain spelling wins over its `www.` twin. */
function indexRules(overrides: Record<string, SiteMode>): Map<string, string> {
  const byKey = new Map<string, string>();
  for (const stored of Object.keys(overrides)) {
    const key = normalizeRuleHost(stored);
    if (!byKey.has(key) || !stored.startsWith("www.")) byKey.set(key, stored);
  }
  return byKey;
}

/** The rule that decides `host` among already-loaded overrides (most specific wins). */
function matchRule(overrides: Record<string, SiteMode>, host: string): SiteRule | null {
  const byKey = indexRules(overrides);
  for (const candidate of ruleCandidates(host)) {
    const stored = byKey.get(candidate);
    if (stored !== undefined) return { host: stored, mode: overrides[stored] };
  }
  return null;
}

/** Return the applicable rule and its stored key; null defers to global enabled. */
export async function effectiveRule(hostname: string): Promise<SiteRule | null> {
  return matchRule(await settings.siteOverrides.getValue(), hostname);
}

/** A matching per-site rule overrides global enabled. */
export async function enabledForSite(hostname: string): Promise<boolean> {
  const rule = await effectiveRule(hostname);
  if (rule) return rule.mode === "on";
  return settings.enabled.getValue();
}

/** Replace this host's rule, preserving its spelling and precedence over parent rules. */
export async function setSiteOverride(hostname: string, v: SiteMode): Promise<void> {
  const overrides = { ...(await settings.siteOverrides.getValue()) };
  overrides[hostname] = v;
  await settings.siteOverrides.setValue(overrides);
}

/** Remove this exact stored key; a parent rule may still apply afterwards. */
export async function clearSiteOverride(hostname: string): Promise<void> {
  const overrides = { ...(await settings.siteOverrides.getValue()) };
  if (hostname in overrides) {
    delete overrides[hostname];
    await settings.siteOverrides.setValue(overrides);
  }
}
