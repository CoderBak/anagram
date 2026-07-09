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
// "sidebar-content" or other patterns that real prose commonly lives in. Where
// trafilatura discards on a bare token ("social", "related"), we require the
// COMPOUND form ("social-share", "related-articles") — a paper's
// `<section class="related-work">` is content, not chrome.

/** Landmark roles that are page chrome by definition. */
const CHROME_ROLES = new Set([
  "navigation", "banner", "contentinfo", "menu", "menubar", "toolbar",
  "tree", "directory", "tablist", "search", "searchbox", "slider",
  "scrollbar", "progressbar", "switch",
  // Landmark for asides/widgets; live-region roles are toasts and counters.
  "complementary", "alert", "status",
]);

/**
 * Class/id token patterns that mark unambiguous chrome. Each entry matches as a
 * WHOLE TOKEN (delimited by ^ $ or [-_ ]) so "subscription-article" style names
 * don't trip it. Grouped by origin:
 */
const CHROME_TOKEN_PATTERNS: string[] = [
  // consent / paywall / promo (original set)
  "cookies?", "consent", "gdpr", "paywall", "subscribe", "subscription",
  "newsletter", "advert", "advertisement", "adsense", "sponsor", "sponsored",
  "promo",
  // structural navigation (original set)
  "breadcrumbs?", "pagination", "pager", "skip[-_]?link",
  "site[-_]?(?:nav|header|footer)",
  // trafilatura: sharing chrome — compound "social-*", standalone share verbs
  "share", "sharing", "sharedaddy", "syndication",
  "social[-_]?(?:share|links?|icons?|media|buttons?|bar)",
  // trafilatura: related/recommended widgets — compound forms only
  "related[-_]?(?:articles?|posts?|stories|links?|content|news|items?)",
  "recommended[-_]?(?:articles?|posts?|stories|reads?|for[-_]?you)",
  "read[-_]?next", "also[-_]?read", "more[-_]?from",
  "trending[-_]?(?:now|topics?|posts?|articles?|stories)",
  "popular[-_]?(?:posts?|articles?|stories|topics?)",
  "most[-_]?(?:read|popular|viewed|shared)",
  // content-recommendation ad networks (vendor names — always widgets)
  "outbrain", "taboola", "mgid", "revcontent",
  // article metadata rows (bylines/dates render as text but are not prose)
  "byline", "dateline", "post[-_]?meta", "entry[-_]?meta", "article[-_]?meta",
  // site furniture. (No bare "toc": Wikipedia's <body> carries utility classes
  // like "vector-toc-pinned-clientpref-1" — a delimited "toc" token nuked the
  // whole page. TOC boxes are link lists; the link-density barrier owns them.)
  "masthead", "colophon", "copyright", "site[-_]?index",
  "skip[-_]?to", "back[-_]?to[-_]?top", "toolbar", "menubar",
  // auth / search chrome — compound so "how to register" prose sections survive
  "(?:login|log[-_]?in|signin|sign[-_]?in|signup|sign[-_]?up|register)[-_]?(?:form|box|modal|panel|prompt|banner|wall|overlay|popup)",
  "search[-_]?(?:box|form|bar|field)",
  // reply forms (the form, not the comments — WP's #respond convention)
  "comment[-_]?form", "respond",
  "rss", "print[-_]?only",
];

const CHROME_TOKEN_RE = new RegExp(
  `(?:^|[\\s_-])(?:${CHROME_TOKEN_PATTERNS.join("|")})(?:[\\s_-]|$)`,
  "i",
);

/**
 * True if this element is page chrome whose subtree should not be scored.
 * Called once per element during a walk — must stay cheap.
 */
export function isBoilerplate(el: Element): boolean {
  const tag = el.nodeName.toUpperCase(); // XHTML documents report lowercase

  // Page-level containers are NEVER chrome, whatever utility classes a skin
  // piles onto them (Wikipedia's body carries "…-toc-pinned-…" etc). Matching
  // one of these on a token would exclude the entire page.
  if (tag === "BODY" || tag === "HTML" || tag === "MAIN" || tag === "ARTICLE") return false;
  if (el.getAttribute("role") === "main") return false;

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

  // Strong class/id tokens (cookie banners, paywalls, ads, share bars, …).
  const cls = el.getAttribute("class");
  const id = (el as HTMLElement).id;
  if (cls || id) {
    const hay = `${id ?? ""} ${cls ?? ""}`.slice(0, 256);
    if (CHROME_TOKEN_RE.test(hay)) return true;
  }

  return false;
}
