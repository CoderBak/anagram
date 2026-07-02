// lib/dom/boilerplate.ts — page-chrome / boilerplate filter.
//
// Inspired by the extraction heuristics of trafilatura / resiliparse / Mozilla
// Readability, adapted to a constraint those tools don't have: we must keep LIVE
// DOM references for in-place rendering, so we cannot run an extractor over a
// serialized copy of the page. Instead we apply their strongest, safest signals
// (landmark roles, sectioning tags, class/id tokens) as subtree skips during the
// walk. The 50-word floor and the link-density barrier do the rest.
//
// Deliberately conservative: user-generated content (comments, chat, reviews) is
// exactly what an AI detector must cover, so nothing here matches "comment",
// "sidebar-content" or other patterns that real prose commonly lives in.

/** Landmark roles that are page chrome by definition. */
const CHROME_ROLES = new Set([
  "navigation", "banner", "contentinfo", "menu", "menubar", "toolbar",
  "tree", "directory", "tablist", "search", "searchbox", "slider",
  "scrollbar", "progressbar", "switch",
]);

/**
 * Class/id tokens that mark unambiguous chrome. Matched as WHOLE tokens
 * (delimited by ^ $ or [-_ ]) so "subscription-article" style names don't trip it.
 */
const CHROME_TOKEN_RE =
  /(?:^|[\s_-])(?:cookie|cookies|consent|gdpr|paywall|subscribe|subscription|newsletter|breadcrumb|breadcrumbs|pagination|pager|advert|advertisement|adsense|sponsor|sponsored|promo|skip[-_]?link|site[-_]?(?:nav|header|footer))(?:[\s_-]|$)/i;

/**
 * True if this element is page chrome whose subtree should not be scored.
 * Called once per element during a walk — must stay cheap.
 */
export function isBoilerplate(el: Element): boolean {
  const tag = el.nodeName.toUpperCase(); // XHTML documents report lowercase

  // <nav> and chrome landmark roles: always skip.
  if (tag === "NAV") return true;
  const role = el.getAttribute("role");
  if (role && CHROME_ROLES.has(role)) return true;

  // <header>/<footer>/<aside>: skip at page level. Inside an <article>/<main>
  // scope they often hold real ledes and standfirsts, so those stay.
  if (tag === "HEADER" || tag === "FOOTER") {
    if (!el.closest("article, main, [role=main], [role=article]")) return true;
  }
  // <aside> is related-links / widgets / pull-quote duplication — skip always
  // (pull quotes duplicate body text and would double-badge the same sentence).
  if (tag === "ASIDE") return true;

  // Strong class/id tokens (cookie banners, paywalls, ads, breadcrumbs, …).
  const cls = el.getAttribute("class");
  const id = (el as HTMLElement).id;
  if (cls || id) {
    const hay = `${id ?? ""} ${cls ?? ""}`.slice(0, 256);
    if (CHROME_TOKEN_RE.test(hay)) return true;
  }

  return false;
}
