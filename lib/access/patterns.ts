// lib/access/patterns.ts — the match patterns Anagram asks for, and what they cover.
//
// Anagram installs with access to NO site. The two patterns below that it does require are
// the local daemon's, because scoring is a fetch to loopback and nothing else may be
// reached at all; every page the extension reads is granted by the user afterwards, all
// sites at once or one at a time. Everything here is pure string work so that the rules —
// which origin a tab belongs to, which of them a content script may be registered on —
// are provable without a browser (test/node/accessPatterns.test.ts).
//
// Match patterns carry no port: `http://localhost/*` is every port on that host, which is
// exactly what the daemon needs (it is configurable) and what a dev server on
// `localhost:3000` gets from an all-sites grant.

/** Required. The loopback daemon, and nothing else the extension may reach. */
export const DAEMON_ORIGINS = ["http://127.0.0.1/*", "http://localhost/*"];

/** Optional, and what "all sites" means: every http(s) page, granted in one click. */
export const ALL_SITES = ["https://*/*", "http://*/*"];

/**
 * Hosts no extension may run on, so asking for them would open a prompt that buys the
 * user nothing. The browsers' own pages are excluded by their scheme already; these are
 * ordinary https pages that the browser guards all the same.
 */
const OFF_LIMITS = new Set([
  "chromewebstore.google.com",
  "chrome.google.com", // where the store used to live
  "addons.mozilla.org",
]);

/**
 * The origin pattern that covers a tab's page, or null when this is not a page access can
 * be asked for: an extension page, a `file:` URL (a separate switch in the browser's own
 * UI that a prompt cannot grant), a browser page, or an IPv6 literal — match patterns
 * cannot spell one. The hostname comes out of `URL`, so an internationalised domain is
 * already in the punycode form the browser compares against.
 */
export function sitePattern(url: string | undefined | null): string | null {
  if (!url) return null;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (host === "" || host.startsWith("[") || OFF_LIMITS.has(host)) return null;
  return `${u.protocol}//${host}/*`;
}

/** Is this one of the patterns that stand for "all sites"? */
export function isAllSitesPattern(pattern: string): boolean {
  return pattern === "<all_urls>" || ALL_SITES.includes(pattern);
}

/**
 * The origins a content script may be registered on: everything the user has granted,
 * without the daemon's own. The daemon's hosts are required, so leaving them in would put
 * a content script on every page served from `localhost` — including a local dev server
 * the user never granted anything for, and every page the test suites serve.
 */
export function browsingOrigins(origins: readonly string[] | undefined): string[] {
  return [...new Set(origins ?? [])].filter((o) => !DAEMON_ORIGINS.includes(o));
}

/** Granted access, as the popup, options and onboarding pages talk about it. */
export interface AccessSummary {
  /** Every http(s) site — the one-click grant. */
  all: boolean;
  /** The individually granted origin patterns (empty when `all`, which covers them). */
  sites: string[];
}

export function summarize(origins: readonly string[] | undefined): AccessSummary {
  const granted = browsingOrigins(origins);
  return {
    all: granted.some(isAllSitesPattern),
    sites: granted.filter((o) => !isAllSitesPattern(o)),
  };
}

/** A match pattern as a regular expression over the whole URL. */
function toRegExp(pattern: string): RegExp | null {
  if (pattern === "<all_urls>") return /^(?:https?|file|ftp):\/\//;
  const split = pattern.indexOf("://");
  if (split < 0) return null;
  const scheme = pattern.slice(0, split);
  const rest = pattern.slice(split + 3);
  const slash = rest.indexOf("/");
  if (slash < 0) return null;
  const host = rest.slice(0, slash);
  const path = rest.slice(slash);
  const quote = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const schemeRe = scheme === "*" ? "https?" : quote(scheme);
  const hostRe =
    host === "*"
      ? "[^/]+"
      : host.startsWith("*.")
        ? `(?:[^/]+\\.)?${quote(host.slice(2))}`
        : quote(host);
  const pathRe = quote(path).replace(/\\\*/g, ".*");
  return new RegExp(`^${schemeRe}://${hostRe}(?::\\d+)?${pathRe}$`, "i");
}

/** Does any of these patterns cover this URL? Unparsable patterns simply never match. */
export function matchesAny(patterns: readonly string[], url: string | undefined): boolean {
  if (!url) return false;
  return patterns.some((pattern) => toRegExp(pattern)?.test(url) === true);
}
