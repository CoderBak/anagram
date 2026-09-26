// lib/dom/boilerplate.ts — page-chrome / boilerplate filter.
//
// Inspired by the extraction heuristics of trafilatura / resiliparse / Mozilla
// Readability, adapted to a constraint those tools don't have: we must keep LIVE
// DOM references for in-place rendering, so we cannot run an extractor over a
// serialized copy of the page. Instead we apply their strongest, safest signals
// (landmark roles, sectioning tags, class/id tokens) as subtree skips during the
// walk. The 75-word floor and the link-density barrier do the rest.
//
// Deliberately conservative: user-generated content (comments, chat, reviews) is
// exactly what an AI detector must cover, so nothing here matches "comment",
// "sidebar-content" or other patterns that real prose commonly lives in. Where
// trafilatura discards on a bare token ("social", "related"), we require the
// COMPOUND form ("social-share", "related-articles") — a paper's
// `<section class="related-work">` is content, not chrome.
import { CONSENT_BANNER_SELECTORS } from "./consentBanners";
import { INLINE_FALLBACK_TAGS } from "./tags";

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

/**
 * A tab is the LABEL of a panel, and a label holds no panel, heading or paragraph. Bootstrap
 * and Drupal accordions put role="tab" on the ITEM — its header and its panel together
 * (PSE&G's rebate pages) — and carousels on each whole slide; read as tab labels, every panel
 * went unread with them.
 */
const NOT_A_TAB_LABEL = '[role="tabpanel"],p,li,blockquote,h1,h2,h3,h4,h5,h6';

/**
 * The components an AMP page draws around its article, by their tag names: the consent
 * prompt, notification bars, the sidebar, the app and push banners, and the ad, embed and
 * share slots (amp.dev's component catalogue, "Ads & analytics", "Presentation" and "Dynamic
 * content"). The runtime gives amp-sidebar `role="menu"` and amp-user-notification
 * `role="alert"`, which were skipped already; it gives amp-consent's prompt no role at all,
 * and the prompt holds a paragraph of consent text.
 */
const AMP_CHROME_TAGS = new Set([
  "AMP-CONSENT", "AMP-USER-NOTIFICATION", "AMP-SIDEBAR", "AMP-APP-BANNER",
  "AMP-WEB-PUSH-WIDGET", "AMP-STICKY-AD", "AMP-AD", "AMP-EMBED", "AMP-AUTO-ADS",
  "AMP-SOCIAL-SHARE", "AMP-SUBSCRIPTIONS-DIALOG",
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
 * `translate="no"` / `.notranslate` honoured only below page level, only on things
 * smaller than the page, and only on boxes of their own: on a code block or a widget it
 * means "not prose"; on <body> or on an application shell it just opts out of machine
 * translation and would otherwise blank the whole site. In the middle of a line it marks a
 * WORD of the sentence — a brand name, the code literal Sphinx sets in the sentences of
 * Python's, Django's and Flask's docs (`code.docutils.literal.notranslate`) — which is not
 * for translating but is read: left out, it holed the sentence the model reads, and a
 * 76-word paragraph counted 73 and fell under the floor. The attribute test comes first —
 * the other tests touch the DOM and the layout, and all but a handful of elements never
 * carry the attribute at all.
 */
export function isNoTranslate(el: Element): boolean {
  if (el.getAttribute("translate") !== "no" && !el.classList.contains("notranslate")) return false;
  const tag = el.nodeName.toUpperCase();
  if (PAGE_LEVEL_TAGS.has(tag) || el.getAttribute("role") === "main") return false;
  const display = el.ownerDocument.defaultView?.getComputedStyle(el).display ?? "";
  if (display === "" ? INLINE_FALLBACK_TAGS.has(tag) : display.startsWith("inline")) return false;
  return !isShell(el);
}

/**
 * Class/id token patterns that mark unambiguous chrome. Each entry matches as a
 * WHOLE TOKEN (delimited by ^ $ or [-_ ]) so "subscription-article" style names
 * don't trip it. Grouped by origin:
 */
export const CHROME_TOKEN_PATTERNS: string[] = [
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
 * A name that says where a skip link LANDS, not that it is one. Gemini wraps every
 * conversation in `<div id="xap-skip-link-target" class="main-content">`; the `skip-link`
 * token read that id as the "Skip to content" link itself and the whole app was taken for
 * chrome — not a chip on any conversation. Such a name is dropped before the tokens are
 * looked for, so whatever else the element is called still counts.
 */
export const SKIP_DESTINATION_RE = /\S*skip[-_]?(?:link|to|nav)\S*[-_](?:target|destination|anchor)\S*/gi;

/**
 * An id that says WHERE an element stands, not WHAT it is. PostgreSQL names its section on
 * the locking clause `SQL-FOR-UPDATE-SHARE` and links to it from the text above; Sphinx names
 * a section after its heading and points the heading's own ¶ link at it (`section#cookies` in
 * Flask's docs); Consumer Reports continues an article in
 * `div#more-on-car-repair-maintenance-related-articles-text`. Taken for component names, the
 * `share`, `cookies` and `related-articles` in them made each a share bar, a cookie banner or
 * a box of links, and the section went unread. An id some link on the page points at is an
 * anchor, and one of more than four parts is a slug — of a heading, or of the path through a
 * template: neither is looked in for chrome words. Class names are the component vocabulary
 * and always count, and so does a short id nothing links to (`share-buttons`).
 */
const MAX_ID_PARTS = 4;

function namesAPlace(el: Element, id: string): boolean {
  if (id.split(/[-_]+/).filter(Boolean).length > MAX_ID_PARTS) return true;
  return el.ownerDocument.querySelector(`a[href$="#${CSS.escape(id)}"]`) !== null;
}

/**
 * The names isBoilerplate looks in for chrome words: the classes, and the id where it is a
 * name at all. Exported so the page diagnostics blame the name the filter really read.
 */
export function chromeNames(el: Element): string {
  const cls = el.getAttribute("class") ?? "";
  let id = el.getAttribute("id") ?? "";
  // The page-wide question is asked only of an id that would count against the element.
  if (id && (CHROME_TOKEN_RE.test(id) || REPLY_FORM_TOKEN_RE.test(id)) && namesAPlace(el, id)) id = "";
  return `${id} ${cls}`.slice(0, 256);
}

/**
 * A term the post is filed under, written on the post's own wrapper. WordPress' post_class()
 * gives a post `category-<slug>` and `tag-<slug>` for every category and tag it has, beside
 * `type-`, `status-` and `format-` for its kind (wp-includes/post-template.php), and Ghost's
 * post_class writes `tag-<slug>` the same way. So a blog that files its issues under
 * "Newsletter", marks paid posts "Sponsored" or tags a recipe "cookies" had those posts taken
 * for a newsletter box, an advert or a cookie banner, whole. A term says what the post is
 * about, never what the box is: these names are dropped before the tokens are looked for.
 */
const TAXONOMY_TERM_RE = /(^|\s)(?:category|tag|type|status|format)-\S*/gi;

/**
 * An element that holds more than this share of the page's text is the page, whatever it is
 * called — except on a page too short for shares to mean anything. Adapted from Unclutter
 * (https://github.com/lindylearn/unclutter, AGPL-3.0, © the Unclutter authors), whose
 * `mainContentFractionThreshold` and `mainContentMinLength` (textContainer.ts) guard its
 * own class-name filter the same way. It catches what no prefix can: WordPress names the
 * terms of any other taxonomy `<taxonomy>-<slug>`, so an issue in a "Newsletter" series is
 * `series-newsletter`.
 */
const PAGE_TEXT_SHARE = 0.4;
const PAGE_TEXT_MIN_CHARS = 500;

/** The page's text size in characters, measured the first time a walk needs it. */
export type PageTextSize = () => number;

export function pageTextSize(doc: Document = document): PageTextSize {
  let chars: number | null = null;
  return () => (chars ??= doc.body ? textChars(doc.body) : 0);
}

/** Characters that are not spaces, script, style or markup kept as text. */
function textChars(el: Element): number {
  let n = nonSpaceChars(el.textContent ?? "");
  for (const machine of el.querySelectorAll("script,style,noscript")) n -= nonSpaceChars(machine.textContent ?? "");
  return n;
}

function nonSpaceChars(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c > 32 && c !== 160) n++;
  }
  return n;
}

function holdsMostOfPage(el: Element, page: PageTextSize): boolean {
  const body = el.ownerDocument.body;
  if (!body || !body.contains(el)) return false;
  const mine = textChars(el);
  // Under this it is under the share of every page long enough to be asked.
  if (mine <= PAGE_TEXT_MIN_CHARS * PAGE_TEXT_SHARE) return false;
  const total = page();
  return total >= PAGE_TEXT_MIN_CHARS && mine > total * PAGE_TEXT_SHARE;
}

/** Where a page declares its main text. */
const MAIN_TEXT_SELECTOR = 'main,article,[role="main"],[role="article"]';

/**
 * A form that holds most of the page's text, with no main text declared anywhere else, is
 * the page: osCommerce and Zen Cart set the whole product page — name, price, description —
 * in the add-to-cart form (`form[name=cart_quantity]`), whose one field is the quantity, and
 * the description went unread as the text of a widget. A sign-up box or a job application
 * holds its own fields and some consent text, never the page the reader came for.
 */
function holdsThePage(el: Element, page: PageTextSize): boolean {
  if (!holdsMostOfPage(el, page)) return false;
  for (const main of el.ownerDocument.querySelectorAll(MAIN_TEXT_SELECTOR)) if (!el.contains(main) && !main.contains(el)) return false;
  return true;
}

/**
 * The element calls ITSELF the page's main content — as a whole class token or as its id,
 * never as part of a longer name ("main-content-share" is a share bar). That is a <main>
 * written as a <div>, and like <main> it is never chrome on the strength of a token.
 */
export const MAIN_CONTENT_NAME_RE = /^(?:main[-_]?content|content[-_]?main|primary[-_]?content|page[-_]?content)$/i;

/**
 * The reply FORM is chrome; the comments are not — they are exactly the user-generated text
 * a detector must read. WordPress' `#respond` convention gave these two tokens their
 * meaning, but 博客园 (cnblogs) wraps its comment LIST in boxes that carry `comment_form`
 * as well, and every comment on the page went with them. So the token alone no longer
 * decides: see `isReplyForm`.
 */
export const REPLY_FORM_TOKEN_RE = /(?:^|[\s_-])(?:comment[-_]?form|respond)(?:[\s_-]|$)/i;

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
 * Cookie banners whose platform names them after itself: Cookiebot's #CybotCookiebotDialog,
 * Didomi's #didomi-host, iubenda's #iubenda-cs-banner say nothing a class token could catch,
 * and every one of them holds a paragraph of consent text long enough to be scored.
 * (lib/dom/consentBanners.ts has the list.) Found ONCE per walk rather than asked of every
 * element: the ids are looked up directly, and the rest go into one querySelectorAll. On a
 * 140,000-element page that is 15 ms beside a 540 ms walk; the whole list as one selector
 * took 40, most of it matching every element against thirty ids.
 */
const CONSENT_SELECTOR = CONSENT_BANNER_SELECTORS.join(",");
const CONSENT_IDS = CONSENT_BANNER_SELECTORS.filter((s) => /^#[\w-]+$/.test(s)).map((s) => s.slice(1));
const CONSENT_OTHERS = CONSENT_BANNER_SELECTORS.filter((s) => !/^#[\w-]+$/.test(s)).join(",");

/** The consent banners in or around `root`, for a walk to skip. */
export function findConsentBanners(root: Element): Set<Element> {
  const found = new Set<Element>(root.querySelectorAll(CONSENT_OTHERS));
  for (const id of CONSENT_IDS) {
    const el = root.ownerDocument.getElementById(id);
    if (el) found.add(el);
  }
  return found;
}

/** Is this one element a consent banner? For single questions — a re-scan root's ancestors,
 *  the page diagnostics — where a lookup over the whole page would be the wrong price. */
export function isConsentBanner(el: Element): boolean {
  return el.matches(CONSENT_SELECTOR);
}

/** A line of text this long beside a box is the text the box stands in. */
const RUNNING_TEXT_CHARS = 40;

/** The words of a text, lower case, one space between them: what a pull quote repeats. */
function wordsOf(text: string): string {
  return ` ${text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
}

/** A sibling of a box that is running text: a line of it, a paragraph, a line break, or a
 *  phrase element — the tags a browser lays out inline, and custom elements, which are
 *  inline until a stylesheet says otherwise. */
function runningText(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").trim().length >= RUNNING_TEXT_CHARS;
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const tag = node.nodeName.toUpperCase();
  if (tag === "BR") return true;
  if (tag !== "P" && !INLINE_FALLBACK_TAGS.has(tag) && !tag.includes("-")) return false;
  return (node.textContent ?? "").trim().length >= RUNNING_TEXT_CHARS;
}

/** Prose of its own: a paragraph, a quotation, a caption or an item with this much text
 *  outside links. A teaser's excerpt runs to a line and a "Read more". */
const ASIDE_PROSE_CHARS = 120;
const ASIDE_PROSE_BLOCKS = "p,blockquote,figcaption,li,dd";
/** What holds the page itself: its title, its main region. */
const PAGE_BODY_SELECTOR = 'h1,main,[role="main"]';

function holdsProse(el: Element): boolean {
  let seen = 0;
  for (const block of el.querySelectorAll(ASIDE_PROSE_BLOCKS)) {
    if (++seen > 40) break;
    let chars = (block.textContent ?? "").trim().length;
    for (const a of block.querySelectorAll("a")) chars -= (a.textContent ?? "").trim().length;
    if (chars >= ASIDE_PROSE_CHARS) return true;
  }
  return false;
}

/** The aside stands IN the text rather than beside it (see asideApart). */
function inTheText(el: Element): boolean {
  const cs = el.ownerDocument.defaultView?.getComputedStyle(el) ?? null;
  if (cs && ((cs.cssFloat !== "none" && cs.cssFloat !== "") || cs.position === "absolute" || cs.position === "fixed" || cs.position === "sticky")) return false;
  // Teaser cards of other articles, however they stand, are no note on this one.
  if (el.querySelector("article") !== null || !holdsProse(el)) return false;
  let box = el;
  while (box.parentElement && box.parentElement.nodeName.toUpperCase() === "DIV" && holdsOnly(box.parentElement, box)) box = box.parentElement;
  const around = box.parentElement;
  let beside = false;
  for (let n = around?.firstChild ?? null; n && !beside; n = n.nextSibling) if (n !== box) beside = runningText(n);
  if (!beside || !around) return false;
  // A pull quote says again what the text around it says.
  const own = wordsOf(el.textContent ?? "");
  const text = wordsOf(around.textContent ?? "");
  return text.indexOf(own) === text.lastIndexOf(own);
}

/**
 * An <aside> is a sidebar, a pull quote, a signature under a forum post, a box of related
 * articles: set APART from the text, and never read (a pull quote repeats a sentence of the
 * article, and would put a second chip on it). But the element is also what writers and
 * forum software reach for inside the text: garnix sets a callout — a heading and three
 * paragraphs of the article — between two paragraphs in an <aside>, XenForo sets the post a
 * reply quotes in `div.bbCodeQuote > aside` in the middle of the reply. So an aside is read
 * where it stands IN the text — running text beside it (through wrappers that hold nothing
 * but it), not floated or positioned beside it — and holds prose of its own, not the words
 * around it again, nor teasers of other articles. And one that holds most of the page, its
 * title or main region with it, is the page: fermyon.com never closes the <aside> of its
 * announcement banner, and the article after it went unread with it.
 */
export function asideApart(el: Element, page: PageTextSize = pageTextSize(el.ownerDocument)): boolean {
  if (inTheText(el)) return false;
  return !(el.querySelector(PAGE_BODY_SELECTOR) !== null && holdsMostOfPage(el, page));
}

/** `parent` holds `child` and nothing else: no other element, no text. */
function holdsOnly(parent: Element, child: Element): boolean {
  if (parent.childElementCount !== 1) return false;
  for (let n = parent.firstChild; n; n = n.nextSibling) if (n !== child && n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "") return false;
  return true;
}

/**
 * True if this element is page chrome whose subtree should not be scored.
 * Called once per element during a walk — must stay cheap. A walk passes one `page` for all
 * its questions, so the page is measured at most once.
 */
export function isBoilerplate(el: Element, page: PageTextSize = pageTextSize(el.ownerDocument)): boolean {
  const tag = el.nodeName.toUpperCase(); // XHTML documents report lowercase

  // Page-level containers are NEVER chrome, whatever utility classes a skin
  // piles onto them (Wikipedia's body carries "…-toc-pinned-…" etc). Matching
  // one of these on a token would exclude the entire page.
  if (tag === "BODY" || tag === "HTML" || tag === "MAIN" || tag === "ARTICLE") return false;
  if (el.getAttribute("role") === "main") return false;

  // <nav> and chrome landmark roles: always skip.
  if (tag === "NAV") return true;
  const role = el.getAttribute("role");
  if (role && CHROME_ROLES.has(role) && !(role === "tab" && el.querySelector(NOT_A_TAB_LABEL) !== null)) return true;

  // <header>/<footer>/<aside>: skip at page level. Inside an <article>/<main>
  // scope they often hold real ledes and standfirsts, so those stay.
  if (tag === "HEADER" || tag === "FOOTER") {
    if (!el.closest("article, main, [role=main], [role=article]")) return true;
  }
  if (tag === "ASIDE" && asideApart(el, page)) return true;
  if (AMP_CHROME_TAGS.has(tag)) return true;

  // A <form> with something to fill in is a widget, whatever prose stands between its
  // fields: a Greenhouse job application sets a paragraph of consent text among them and
  // got a unit of its own, a newsletter box sets its pitch there. Never the page's own
  // shell (ASP.NET wraps whole sites in one <form>), nor the form a shop wraps the whole
  // product page in (holdsThePage), and the walk keeps handling contenteditable and
  // <textarea> wherever they stand.
  if (tag === "FORM" && el.querySelector(FORM_CONTROL_SELECTOR) !== null && !isShell(el) && !holdsThePage(el, page)) return true;

  // Strong class/id tokens (cookie banners, paywalls, ads, share bars, …).
  const cls = el.getAttribute("class");
  const id = el.getAttribute("id");
  if (cls || id) {
    const names = `${id ?? ""} ${cls ?? ""}`.slice(0, 256);
    if (names.split(/\s+/).some((name) => MAIN_CONTENT_NAME_RE.test(name))) return false;
    const hay = chromeNames(el).replace(SKIP_DESTINATION_RE, " ").replace(TAXONOMY_TERM_RE, "$1");
    if (CHROME_TOKEN_RE.test(hay) && !holdsMostOfPage(el, page)) return true;
    if (REPLY_FORM_TOKEN_RE.test(hay) && isReplyForm(el)) return true;
    if (cls && mediaWikiFurniture(el) !== null) return true;
  }
  if (referenceList(el) !== null) return true;

  return false;
}

/**
 * The reference list of a paper served as a web page, by the names its publishing platforms
 * give it: LaTeXML's `ltx_bibliography` (arXiv's HTML papers), JATS' `ref-list` (PubMed
 * Central, and HighWire's bioRxiv and medRxiv), Springer Nature's `c-article-references`,
 * Atypon's `article-section__references` (Wiley), Elsevier's `bibliography` section on
 * ScienceDirect, and the `csl-bib-body` of every CSL processor (Pandoc, Quarto, Zotero's
 * exports); and the DPUB-ARIA role, `doc-bibliography`, where a page declares it. One
 * punctuated citation after another reads to the walk as a list of sentences, and PubMed
 * Central's and Wiley's lists merged into units of their own. Whole class tokens only.
 */
export const REFERENCE_LIST_RE =
  /(?:^|\s)(ltx_bibliography|ref-list|c-article-references|article-section__references|bibliography|csl-bib-body)(?:\s|$)/;

/** The name that makes this element a reference list, or null (see above). */
export function referenceList(el: Element): string | null {
  if (el.getAttribute("role") === "doc-bibliography") return 'role="doc-bibliography"';
  const cls = el.getAttribute("class");
  return cls ? (REFERENCE_LIST_RE.exec(cls)?.[1] ?? null) : null;
}

/**
 * What MediaWiki writes around an article's prose that is not the article: the hatnotes
 * ("For other uses, see …"), the Notes and References lists, a bibliography set in
 * `{{refbegin}}`, and the citations its CS1/CS2 templates write into Further reading lists.
 * Class names of the read view (en.wikipedia.org serves Parsoid HTML; older wikis and
 * Fandom the legacy parser's), and the choice of what to skip follows Wikimedia's own
 * plain-text extractor, mwparserfromhtml (https://gitlab.wikimedia.org/repos/research/html-dumps,
 * MIT, © Wikimedia Foundation), which leaves out notes, references and citations. A hatnote
 * that ends in a full stop was read as the first line of the section under it, and a list of
 * references or sources merged into units of its own. Only inside a wiki's content box: a
 * `references` class means something else on other pages. Infoboxes, message boxes and
 * sidebars are not listed — the walk already reads none of them: their short cells never
 * merge with anything.
 */
export const MEDIAWIKI_FURNITURE_RE = /(?:^|\s)(hatnote|references|mw-references-wrap|refbegin)(?:\s|$)/;
const CITATION_RE = /(?:^|\s)citation(?:\s|$)/;
const CS_CITATION_RE = /(?:^|\s)cs[12](?:\s|$)/;

/** The MediaWiki class that makes this element furniture, or null (see above). */
export function mediaWikiFurniture(el: Element): string | null {
  const cls = el.getAttribute("class");
  if (!cls) return null;
  const hit =
    MEDIAWIKI_FURNITURE_RE.exec(cls)?.[1] ??
    (el.nodeName.toUpperCase() === "CITE" && CITATION_RE.test(cls) && CS_CITATION_RE.test(cls) ? "citation" : null);
  return hit !== null && el.closest(".mw-parser-output") !== null ? hit : null;
}
