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
  // A PDF tab turns itself into the reading mode. OFF by default: replacing the browser's
  // own viewer on every PDF is not something to do to somebody who did not ask for it —
  // the ball's chip, the popup button and the context menu are still there for one file.
  autoOpenPdfs: storage.defineItem<boolean>("local:autoOpenPdfs", { fallback: false }),
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

// ---- per-site rules -------------------------------------------------------------------
//
// A rule is written for a SITE, not for one exact hostname: turning Anagram off on
// `www.zhihu.com` has to hold on `zhuanlan.zhihu.com` as well, and nobody thinks of
// `x.com` and `www.x.com` as two places. The STORAGE shape does not change — rules
// already saved keep working, whichever spelling they carry — only the lookup does:
// the exact host first, then each parent domain, most specific wins, with a leading
// `www.` treated as absent on both sides.

/** What a rule says: force scoring on, or force it off. */
export type SiteMode = "on" | "off";

/** Which stored rule decides a host, and what it says. */
export interface SiteRule {
  /** The hostname the rule is STORED under — the key to pass to `clearSiteOverride`. */
  host: string;
  mode: SiteMode;
}

/**
 * Two-level suffixes the climb must stop at. A rule on `news.example.co.uk` should
 * reach `example.co.uk`, but a rule stored on `co.uk` would silence every British
 * company at once, and `alice.github.io` and `bob.github.io` belong to different
 * people. This is a GUARD, not the Public Suffix List: shipping the real list (and
 * keeping it fresh) costs far more than it buys here, and a suffix missing from this
 * set only matters if the user went and wrote a rule on that bare suffix themselves.
 */
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

/**
 * The form a hostname is compared in: lowercase, no trailing root dot, no leading
 * `www.`. Rules saved under either spelling therefore mean the same site.
 */
export function normalizeRuleHost(hostname: string): string {
  const h = hostname.trim().toLowerCase().replace(/\.+$/, "");
  return h.startsWith("www.") ? h.slice(4) : h;
}

/** An address that is not a domain name: it matches exactly and never by parent —
 *  climbing `127.0.0.1` would invent `0.0.1`, and `localhost` has no parent at all. */
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
    // Never a bare public suffix: a name with no dot is a TLD, and the rest are the
    // usual two-level suffixes above.
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

/**
 * Which per-site rule applies to a host, and under which hostname it is stored — so a
 * caller can name it ("off on example.com") and clear the rule that actually decides
 * rather than one written for a subdomain that was never stored. Null = no rule, the
 * global `enabled` flag decides.
 */
export async function effectiveRule(hostname: string): Promise<SiteRule | null> {
  return matchRule(await settings.siteOverrides.getValue(), hostname);
}

/**
 * Whether scoring is enabled for a given hostname. The per-site rule that covers it
 * ("on"/"off") wins over the global `enabled` flag; otherwise the global flag decides.
 */
export async function enabledForSite(hostname: string): Promise<boolean> {
  const rule = await effectiveRule(hostname);
  if (rule) return rule.mode === "on";
  return settings.enabled.getValue();
}

/**
 * Set (or clear) a per-site override. "on" forces scoring on for the host; "off" forces
 * it off. The two are mutually exclusive (setting one replaces the other for that host).
 * The hostname is stored as given: a rule written for a subdomain stays that subdomain's
 * rule, and being more specific it wins over whatever its parent domain says.
 */
export async function setSiteOverride(hostname: string, v: SiteMode): Promise<void> {
  const overrides = { ...(await settings.siteOverrides.getValue()) };
  overrides[hostname] = v;
  await settings.siteOverrides.setValue(overrides);
}

/**
 * Clear the rule stored under exactly this hostname. A host can still be decided by a
 * parent domain's rule afterwards — `effectiveRule` says which one, so a caller can
 * clear that rather than write a no-op for a subdomain nothing was ever stored for.
 */
export async function clearSiteOverride(hostname: string): Promise<void> {
  const overrides = { ...(await settings.siteOverrides.getValue()) };
  if (hostname in overrides) {
    delete overrides[hostname];
    await settings.siteOverrides.setValue(overrides);
  }
}

