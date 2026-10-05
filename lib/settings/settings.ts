// Storage-backed reading preferences and per-site rules.
import { storage } from "#imports";
import type { ScoreCacheMode } from "../cachePolicy";
import { DEFAULT_FLAG_FROM, type FlagFrom } from "../render/flagLevel";
export type { ScoreCacheMode } from "../cachePolicy";

export const cacheModeStorage = storage.defineItem<ScoreCacheMode>("local:cacheMode", { fallback: "persistent" });

/** Settings that no longer exist, removed from storage on update: the minimum length and
 *  merging short paragraphs are fixed (lib/dom/text.ts MIN_WORDS) since 2026-10-05. */
export const RETIRED_SETTINGS = ["minWords", "mergeShorts"];

export const settings = {
  enabled: storage.defineItem<boolean>("local:enabled", { fallback: true }),
  siteOverrides: storage.defineItem<Record<string, "on" | "off">>("local:siteOverrides", { fallback: {} }),
  // Underlines, or none; applies to open tabs. Which paragraphs they go on is underlineScope.
  showHighlights: storage.defineItem<boolean>("local:showHighlights", { fallback: true }),
  // Underlines on the flagged paragraphs (flagFrom and up), or on every paragraph read.
  underlineScope: storage.defineItem<"flagged" | "all">("local:underlineScope", { fallback: "flagged" }),
  // Replacing the browser's PDF viewer requires opt-in; manual opening stays available.
  autoOpenPdfs: storage.defineItem<boolean>("local:autoOpenPdfs", { fallback: false }),
  // The reader's paragraphs come from Zotero's document-worker (lib/pdf/structured.ts);
  // off, the reader's own geometric reflow reads the pages instead. No setting in the UI:
  // a switch for the benchmark and for a machine where the worker misbehaves.
  pdfStructure: storage.defineItem<boolean>("local:pdfStructure", { fallback: true }),
  // The reader reads the pages it has not drawn as well, in the background, at a pace set by
  // how fast the engine is here (lib/pdf/readAhead.ts). Off, it reads the pages it draws.
  pdfReadAhead: storage.defineItem<boolean>("local:pdfReadAhead", { fallback: true }),
  // Console logging (lib/log.ts). No setting in the UI: chrome.storage.local.set({ debug: true }) in devtools.
  debug: storage.defineItem<boolean>("local:debug", { fallback: false }),
  // Filters rendering, not analysis: all units or only the flagged ones.
  displayMode: storage.defineItem<"all" | "flagged">("local:displayMode", {
    fallback: "all",
  }),
  // The word a paragraph is flagged from (lib/render/band.ts): counted, listed in the toolbar
  // menu and underlined; below it a paragraph has its chip only. Read through flagFromOf.
  flagFrom: storage.defineItem<FlagFrom>("local:flagFrom", { fallback: DEFAULT_FLAG_FROM }),
  // Personal reading statistics (lib/stats/): off until the reader chooses what to keep, and
  // kept on this computer only. Read through configOf (lib/stats/config.ts), which answers
  // anything that is not a configuration with "off".
  statsConfig: storage.defineItem<unknown>("local:statsConfig", { fallback: null }),
  // The key the log's hashes and sketches are made with (lib/stats/hash.ts): made here, never
  // exported, and made anew when the statistics are cleared.
  statsSecret: storage.defineItem<string | null>("local:statsSecret", { fallback: null }),
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
    if (stored !== undefined) return { host: stored, mode: overrides[stored]! };
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
