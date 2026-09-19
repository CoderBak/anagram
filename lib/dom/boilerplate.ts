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

/** Landmark roles that are page chrome by definition. NOT "tablist": Bootstrap-style
 *  accordions put role="tablist" on the container that holds every panel's CONTENT
 *  (EUR-Lex wraps whole regulations that way) — only the tab labels (role="tab") are
 *  chrome. */
const CHROME_ROLES = new Set([
  "navigation", "banner", "contentinfo", "menu", "menubar", "toolbar",
  "tree", "directory", "tab", "search", "searchbox", "slider",
  "scrollbar", "progressbar", "switch",
  // Landmark for asides/widgets; live-region roles are toasts and counters.
  "complementary", "alert", "status",
]);

/** Containers a site-wide hint must never exclude (a `notranslate` <body> is a
 *  translation opt-out, not "no prose here"). */
const PAGE_LEVEL_TAGS = new Set(["BODY", "HTML", "MAIN", "ARTICLE"]);

/** Sectioning and landmark content: what an application SHELL holds and a widget does
 *  not. A brand name, a code sample or a date picker contains no <main> and no feed. */
const SECTIONING_SELECTOR =
  'main,article,section,[role="main"],[role="article"],[role="feed"],[role="region"]';

/** With no landmark anywhere on the page, a shell is still the box that holds most of
 *  it — this share of the document's elements. */
const SHELL_ELEMENT_SHARE = 0.5;

/**
 * Is this the page's own shell rather than something inside it? Mastodon's
 * web client is `<body> → <div id="mastodon" class="notranslate app-holder"> → … →
 * <main> → … → <article>`: taking that attribute at face value made every status on
 * every Mastodon instance unreachable (16 silent `<article>`s on a profile, 12 on
 * /explore, no unit anywhere). On a shell the attribute says "do not machine-translate
 * this application"; on the small things it says "this is not prose". The <form> rule
 * below asks the same question for the same reason: ASP.NET WebForms wraps a whole site in
 * one `<form runat="server">`, and a page is not a sign-up box.
 */
function isShell(el: Element): boolean {
  if (el.querySelector(SECTIONING_SELECTOR) !== null) return true;
  const body = el.ownerDocument?.body ?? null;
  if (!body || el === body || !body.contains(el)) return false;
  const total = body.getElementsByTagName("*").length;
  return total > 0 && el.getElementsByTagName("*").length >= total * SHELL_ELEMENT_SHARE;
}

/**
 * `translate="no"` / `.notranslate` honoured only below page level and only on things
 * smaller than the page: on code, brand names and widgets it means "not prose"; on
 * <body> or on an application shell it just opts out of machine translation and would
 * otherwise blank the whole site. The attribute test comes first — the shell tests
 * touch the DOM, and all but a handful of elements never carry the attribute at all.
 */
export function isNoTranslate(el: Element): boolean {
  if (el.getAttribute("translate") !== "no" && !el.classList.contains("notranslate")) return false;
  if (PAGE_LEVEL_TAGS.has(el.nodeName.toUpperCase()) || el.getAttribute("role") === "main") return false;
  return !isShell(el);
}

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
  "rss", "print[-_]?only",
];

const CHROME_TOKEN_RE = new RegExp(
  `(?:^|[\\s_-])(?:${CHROME_TOKEN_PATTERNS.join("|")})(?:[\\s_-]|$)`,
  "i",
);

/**
 * The reply FORM is chrome; the comments are not — they are exactly the user-generated text
 * a detector must read. WordPress' `#respond` convention gave these two tokens their
 * meaning, but 博客园 (cnblogs) wraps its comment LIST in boxes that carry `comment_form`
 * as well, and every comment on the page went with them. So the token alone no longer
 * decides: see `isReplyForm`.
 */
const REPLY_FORM_TOKEN_RE = /(?:^|[\s_-])(?:comment[-_]?form|respond)(?:[\s_-]|$)/i;

/** Controls a reader types into or chooses from — what makes a box a form to fill in.
 *  Hidden inputs are bookkeeping (a CSRF token sits in every kind of box). */
const FORM_CONTROL_SELECTOR = "textarea,select,input:not([type=hidden])";

/** Boxes of one kind side by side that make a LIST rather than the fields of a form. */
const LIST_ITEM_MIN = 3;
/** Under this a box is a label, a button or a field, never somebody's comment. */
const LIST_ITEM_MIN_CHARS = 20;

/**
 * Does this box hold a LIST — several sibling boxes of one tag and one class, each with text
 * in it? Every comment comes off one template, while the fields of a reply form each carry
 * their own class (`comment-form-author`, `comment-form-email`, `comment-form-url`), so this
 * never matches the form it is meant to spare. Two levels, because the list usually sits in
 * a wrapper of its own inside the box that carries the token.
 */
function holdsAList(el: Element, depth = 2): boolean {
  const kinds = new Map<string, number>();
  for (const child of el.children) {
    if ((child.textContent ?? "").trim().length >= LIST_ITEM_MIN_CHARS) {
      const kind = `${child.nodeName}.${child.getAttribute("class") ?? ""}`;
      const seen = (kinds.get(kind) ?? 0) + 1;
      if (seen >= LIST_ITEM_MIN) return true;
      kinds.set(kind, seen);
    }
    if (depth > 1 && holdsAList(child, depth - 1)) return true;
  }
  return false;
}

/** A box carrying a reply-form token is the form itself only when there is something in it
 *  to type in, and when it is not the list of comments (or the box around both). */
function isReplyForm(el: Element): boolean {
  if (el.querySelector(`${FORM_CONTROL_SELECTOR},form`) === null) return false;
  return !holdsAList(el);
}

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

  // A <form> with something to fill in is a widget, whatever prose stands between its
  // fields: a Greenhouse job application sets a paragraph of consent text among them and
  // got a unit of its own, a newsletter box sets its pitch there. Never the page's own
  // shell (ASP.NET wraps whole sites in one <form>), and the walk keeps handling
  // contenteditable and <textarea> wherever they stand.
  if (tag === "FORM" && el.querySelector(FORM_CONTROL_SELECTOR) !== null && !isShell(el)) return true;

  // Strong class/id tokens (cookie banners, paywalls, ads, share bars, …).
  const cls = el.getAttribute("class");
  const id = (el as HTMLElement).id;
  if (cls || id) {
    const hay = `${id ?? ""} ${cls ?? ""}`.slice(0, 256);
    if (CHROME_TOKEN_RE.test(hay)) return true;
    if (REPLY_FORM_TOKEN_RE.test(hay) && isReplyForm(el)) return true;
  }

  return false;
}
