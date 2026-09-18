// lib/dom/scope.ts — whose text is this? The voice scope of a run.
//
// Proximity alone merged two sibling <article>s by different authors into one verdict
// describing nobody, and an author with the person they quote. Every run therefore belongs
// to a SCOPE — the nearest ancestor-or-self of its container that is one voice — and the
// assembler (lib/dom/walker.ts) merges only inside one scope; no scope: the page itself.
// A scope is either DECLARED by the markup or RECOGNISED by its structure.
//
// DECLARED — the markup says so:
//
//   article, [role=article] — one post: X and Mastodon statuses, WordPress comments
//                             (`ol.comment-list > li > article`), Discourse and
//                             XenForo posts, LinkedIn feed cards; Reddit puts
//                             role=article on each comment's <details>.
//   blockquote              — the person being quoted, not the author quoting them.
//   figure                  — a caption or a pull quote set into the text; on news
//                             sites the caption is the picture desk's, not the writer's.
//   [role=link]             — a whole card that is one link: the QUOTED post on X
//                             sits inside the quoting post's <article>, in a
//                             `div[role=link]`; Bluesky has no <article> at all, every
//                             feed item and every quote embed is such a div. (An inline
//                             `<span role=link>` never contains a run's container.)
//   [role=list]             — a feed of records built by an application, not a bullet list
//     [role=listitem]         written by an author: LinkedIn's new feed is
//     :not(li)                `div[role=list][data-testid=mainFeed]` with one
//                             `div[role=listitem]` per post and no <article> anywhere (a
//                             207-word post that fits one window stayed two units). The
//                             role is spelt out on a NON-<li> element inside a list on
//                             purpose: `<ul role="list">` is the common Safari workaround on
//                             ordinary bullet lists, whose <li> stay one author's text.
//   bili-comment-renderer,  — Bilibili's comments are nested OPEN shadow roots
//   bili-comment-reply-       (`bili-comments` → `bili-comment-thread-renderer` →
//   renderer                  `bili-comment-renderer` → `bili-rich-text` → `p#contents`);
//                             avatar, name and date each sit in a shadow root of their
//                             own, where no structural test can see them, so the two
//                             elements that are one comment and one reply are named. The
//                             thread renderer is NOT named: it holds a comment AND the
//                             replies under it. This table is for shadow-DOM components
//                             only and holds tag names, never class names.
//
// RECOGNISED — most sites declare nothing. A Zhihu answer is `div.List-item >
// div.ContentItem.AnswerItem`, a GitHub comment a `div` with hashed class names in a
// timeline row, a Hacker News comment a `tr.athing.comtr`, a Substack comment a
// `div.comment` OUTSIDE the post's <article>, a Telegram message a
// `div.tgme_widget_message_wrap`, a Steam review a `div.apphub_Card`. Selectors for those
// would be out of date within weeks, so a post is recognised by what it IS:
//
//   ONE OF SEVERAL LIKE IT, EACH WITH ITS OWN BYLINE.
//
//   byline   — evidence, inside the element, of who wrote it or when (see `isEvidence`).
//              The paragraphs of an article repeat too, and so do bullet items and the
//              rows of a prose table, but none of them carries a byline of its own: they
//              stay one author's text, which is why <li> and <td> are no scopes by
//              themselves — and why an <li> or a <tr> WITH its own byline is one (old
//              WordPress and Disqus-style `li.comment > div.comment-body`, Hacker News
//              and V2EX rows). Teaser cards on a front page do carry bylines, and
//              keeping them apart is right: they are different articles.
//   like it  — a sibling with the same leading class token that has its byline IN THE SAME
//              PLACE: the same chain of tags leads from it down to its first piece of
//              evidence. Posts rendered from one template agree on both (hashed class names
//              still repeat from sibling to sibling, and WordPress hangs its `even
//              thread-even depth-1` AFTER the leading `comment`), while the sections of ONE
//              article do not: wikiHow's `div.section.steps` holds a linked expert somewhere
//              in a step and `div.section.aboutthisarticle` an author card — same tag, same
//              leading class, two bylines found, no posts. Only a look-alike whose byline is
//              its own counts: the box of replies under a topic is shaped like the topic
//              box. (The price: V2EX's LAST reply is `div.inner` among `div.cell`s and is
//              not recognised; it is read as the bare page reads it, between two posts.)
//   nested   — a reply standing alone under its parent has no sibling to be compared
//              with; it is recognised by being shaped like a post that encloses it
//              (Substack `div.comment` in `div.comment`, Lobsters `li.comments_subtree`
//              in `li.comments_subtree`, WordPress `li.comment` in `ol.children`).
//
//   its own  — no post stands between the element and its first byline: a page of reviews,
//              a row of cards, a section of a timeline repeat as well, but the byline
//              found in them belongs to the first post they CONTAIN.
//   at an edge — a byline heads a post or signs it (Steam sets the reviewer UNDER the
//              review). Evidence with text on both sides of it is in the middle of
//              somebody's text: the figure boxes in the subsections of a PLOS paper. Text
//              means CONTENT: the menu GitHub Discussions sets before a comment's header
//              in the DOM — hidden items, a popover, buttons — is none (CONTROL_SELECTOR).
//   opening  — the post a thread answers has no sibling like it either. V2EX sets a topic
//              in a `div.box` of its own above the box of replies; of its body — paragraphs,
//              lists, three-to-seven-word label <p>s between them — only the first two
//              paragraphs were judged. A bylined element is a post when the thread FOLLOWS
//              it — a later sibling of it, or of its parent, holds several posts like one
//              another — and it holds more than a byline. Page furniture (<aside>, <nav>,
//              <header>, <footer>) is no thread: a sidebar of teaser cards beside the main
//              column must not make the column "one post". And an ARTICLE with comments
//              under it is no opening post: a text with section headings is read as the
//              page always read it (see `isSectioned`).
//
// The nearest scope wins, declared or recognised, exactly as Reddit's nested
// `[role=article]` always did. Nothing at page level (`body`, `main`) is ever a post.
//
// NOT recognised, on purpose: an element with a byline, NO sibling like it and no thread
// after it — the single comment of a permalink page. One byline that was found proves
// nothing about the ones that were not (a plain-text "alice · 2h" row carries no evidence at
// all), and an article header above a hand-rolled comment list would turn the whole column
// into "one post", in which name rows no longer keep two people apart. Such a page is read
// as the bare page always was: nobody is next to the comment to be confused with.
//
// WHAT A RECOGNISED POST CHANGES in the assembler (lib/dom/walker.ts). Like a declared one:
// nothing merges across it, and if its prose fits one model window it is one unit. Unlike a
// declared one, which is read exactly as before:
//   · it ENDS the group being read around it, as its byline row did when the page was bare
//     (`enter`) — a chat transcript whose name rows carry avatars stays apart;
//   · a label is transparent only AMONG THE TEXT (a pseudo-heading between two paragraphs);
//     as a row of the card it concludes what was read, as on the bare page (`short`);
//   · text set deeper by list or table markup stands with the paragraphs around it (`oneBody`).
//
// Everything here reads attributes and tree structure only — never styles, never layout —
// and is a pure function of the DOM, so a partial re-scan that starts inside a post finds
// the scope the full scan found: no answer depends on which element was asked first. The
// page is surveyed for bylines once per scan (two querySelectorAll), lazily; every other
// answer is cached per element for the scan.
import { tagOf } from "./tags";

const DECLARED_SCOPE_SELECTOR =
  'article,[role="article"],blockquote,figure,[role="link"],[role="list"] [role="listitem"]:not(li),bili-comment-renderer,bili-comment-reply-renderer';

/** Everything that could be byline evidence; `isEvidence` decides. */
const EVIDENCE_CANDIDATES = "time,relative-time,[datetime],[title],img,a[href]";

/** A `title` that spells out a moment: Hacker News' `span.age[title="2026-09-18T07:00:00 …"]`,
 *  V2EX's `span.ago[title]`, Substack's `a[title="Sep 12, 2026, 3:04 PM"]` around "2h" — an
 *  ISO date, or a clock time next to a year. Wikipedia's `title="Special:BookSources/978-…"`
 *  is digits and dashes too, and a chapter-and-verse "3:16" is no moment. */
const ISO_DATE_RE = /(?<![\d-])(?:19|20)\d{2}-\d{1,2}-\d{1,2}(?![\d-])/;
const CLOCK_RE = /(?<![\d:])\d{1,2}:\d{2}(?![\d])/;
const YEAR_RE = /(?<!\d)(?:19|20)\d{2}(?!\d)/;
const MAX_MOMENT_TITLE_CHARS = 40;

function spellsOutMoment(title: string): boolean {
  if (title.length > MAX_MOMENT_TITLE_CHARS || !/\d[:-]\d/.test(title)) return false;
  return ISO_DATE_RE.test(title) || (CLOCK_RE.test(title) && YEAR_RE.test(title));
}

/**
 * A link to a PERSON, by the words sites use in their URLs — far more stable than their
 * class names. Measured on live pages: `user?id=` (Hacker News), `/profile/` (Substack),
 * `/~name` (Lobsters), `/@name` (YouTube), `/profiles/` (Steam; its `/id/…` vanity links are
 * caught as a picture and a name instead) and `memberlist.php?mode=viewprofile&u=` (phpBB,
 * whose posts carry no <time> and on many boards no avatar: that link is all the evidence
 * there is). Not measured here: `/people/` and `/member/`, as Zhihu and V2EX are known to
 * link their users, and the common conventions for the same thing — `/u/`, `/users/`,
 * `/members/`, `/author/`, `?uid=`.
 */
const PERSON_HREF_RE =
  /(?:^|\/)(?:users?|u|members?|memberlist|people|profiles?|authors?)(?:[/?]|\.php|$)|\/[@~][^/?#]+\/?(?:[?#]|$)|[?&](?:u|uid|user|userid|user_id|author_id)=/i;
const MAX_NAME_CHARS = 40;
/** The text link of a picture-and-name pair may say more than a name: LinkedIn wraps name,
 *  headline and age of the post in ONE link, a teaser card its whole headline. */
const MAX_CAPTION_CHARS = 200;

/** Text this long right beside a link or a date means it stands IN a sentence. */
const RUNNING_TEXT_CHARS = 24;
/** Wrappers looked through for that: `<b><a>@alice</a></b>` in the middle of a sentence. */
const MAX_WRAPPER_HOPS = 3;
/** How far above a lone reply a post of its shape is looked for. */
const MAX_NEST_HOPS = 8;
/** Text of at most this length may stand between a byline and the edge of its post: the
 *  title line over a forum post or a teaser card, the vote count before a Lobsters name. */
const EDGE_CHARS = 120;
/** How deep inside a neighbour the posts of a thread are looked for: one level in V2EX's
 *  box of replies (`div.box > div.cell`), two in a table of rows (Hacker News'
 *  `table.comment-tree > tbody > tr.athing`); three leaves room for one wrapper more. */
const THREAD_LEVELS = 3;

/** What sets a paragraph deeper than its neighbours without taking it out of their text. */
const TEXT_MARKUP = new Set(["UL", "OL", "LI", "DL", "DT", "DD", "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TD", "TH"]);

export interface Scopes {
  /** The voice a run standing in `el` belongs to: the nearest declared or recognised scope
   *  at or above it, shadow hosts climbed through; null = the page itself. */
  of(el: Element): Element | null;
  /** `scope` came from structure, not from the markup. */
  recognised(scope: Element | null): boolean;
  /**
   * `a` and `b`, both inside the recognised post `scope`, stand in ONE TEXT BODY although
   * they are no neighbours: one of them is deeper only because of TEXT MARKUP — a list, a
   * table — and nothing but this person's text is between them. A Zhihu answer sets a short
   * paragraph between a <figure> and an `ol > li > p` two levels further down; by proximity
   * alone it had no neighbour and went unjudged. Two conditions keep everything else out:
   * the smallest box holding both lies strictly inside the post and holds no byline (the name
   * row, the badge line, a reply whose byline was found), and between each of them and that
   * box there is list or table markup only — never a layout box. Steam sets "Was this review
   * helpful?" in a `div` of its own under the review, with no byline between the two: a
   * sentence of the site's, which "no byline between" alone let into every review.
   */
  oneBody(a: Element, b: Element, scope: Element): boolean;
}

function isText(node: Node | null): node is Text {
  return !!node && node.nodeType === Node.TEXT_NODE;
}

function besideRunningText(node: Node | null): boolean {
  return isText(node) && (node.textContent ?? "").trim().length > RUNNING_TEXT_CHARS;
}

/**
 * The element stands in the middle of a sentence. "Fixed in 4.2 by <a href="/u/bob">@bob</a>,
 * thanks" in a changelog and "On <time>3 March</time> the council voted …" in a news story
 * are one author's running text, not a byline; "Posted by <a>alice</a> » <time>…</time>"
 * (phpBB) and "alice commented <relative-time>" (GitHub) have only a connective beside them.
 */
function inRunningText(el: Element): boolean {
  let cur = el;
  for (let hops = 0; hops <= MAX_WRAPPER_HOPS; hops++) {
    if (besideRunningText(cur.previousSibling) || besideRunningText(cur.nextSibling)) return true;
    const parent = cur.parentElement;
    if (!parent || parent.childElementCount !== 1) return false;
    for (const n of parent.childNodes) if (isText(n) && (n.textContent ?? "").trim()) return false;
    cur = parent; // the wrapper holds nothing else: look around the wrapper
  }
  return false;
}

/**
 * WHO: an avatar the site calls one — `img.Avatar` (Zhihu), `img.avatar` (V2EX, Lobsters,
 * WordPress, Discourse), avatars.githubusercontent.com, avatars.*.steamstatic.com (Steam's
 * review cards carry no date element at all), gravatar.com. Size is no evidence: the 27-px
 * project icons of Wikipedia's "sister projects" list and the 30-px bullets of a features
 * list are avatar-sized, and one author's bullets must stay one author's.
 */
function isAvatar(img: Element): boolean {
  return /avatar/i.test(img.getAttribute("class") ?? "") || /avatar/i.test(img.getAttribute("src") ?? "");
}

/** The registrable part of a host name, near enough: its last two labels. */
function siteOf(host: string): string {
  return host.split(".").slice(-2).join(".");
}

/**
 * WHO: a short link to a person ON THIS SITE that is not part of a sentence. The entries of
 * a Wikipedia bibliography link to web.archive.org copies of `…/author/…` and `…/people/…`
 * pages of other sites; those are sources, not the people writing here. (Zhihu's columns on
 * zhuanlan.zhihu.com link to www.zhihu.com/people/…, hence the site and not the host.)
 */
function isPersonLink(a: Element): boolean {
  const href = a.getAttribute("href") ?? "";
  if (!PERSON_HREF_RE.test(href)) return false;
  const host = /^(?:https?:)?\/\/([^/?#:]+)/i.exec(href);
  if (host && siteOf(host[1].toLowerCase()) !== siteOf(location.hostname)) return false;
  return (a.textContent ?? "").trim().length <= MAX_NAME_CHARS;
}

/** Where a link goes, tracking parameters and fragments aside (LinkedIn's avatar and name
 *  links differ in `?trk=` only); null for links that go nowhere else. */
function placeOf(a: Element): string | null {
  const place = (a.getAttribute("href") ?? "").replace(/[?#].*$/, "");
  return place.length > 1 && !/^javascript:/i.test(place) ? place : null;
}

/**
 * WHO, without any vocabulary: the PICTURE of somebody and their NAME, two links to the same
 * place — `a > img` with no text, and beside it a text link with the same href, which is the
 * evidence. That is how nearly every site sets an author: GitHub (`/alice` twice), Telegram
 * (`/telegram`), Steam (`/id/…` or `/profiles/…`), YouTube (`/@name`), Lobsters (`/~name`),
 * Substack (`/profile/…`), LinkedIn (`/in/…`, `/company/…`), X. A teaser card sets its story
 * the same way, thumbnail and headline, and a card is a voice of its own too. Collected from
 * the images that stand in links — a few dozen on a page of six thousand links.
 */
function picturedPlaces(doc: Document): Set<string> {
  const pictured = new Set<string>();
  for (const img of doc.querySelectorAll("a[href] img")) {
    const a = img.closest("a");
    const place = a && placeOf(a);
    if (a && place && (a.textContent ?? "").trim() === "") pictured.add(place);
  }
  return pictured;
}

/**
 * Byline evidence: WHEN — <time>, GitHub's <relative-time>, anything with `datetime`, a
 * `title` that spells out a moment — or WHO — an avatar, a link to a person, a picture and
 * a name that go to the same place. Every post container measured on a live page has at
 * least one: Zhihu (avatar, /people/ link), GitHub (relative-time, avatar), Substack
 * comments (dated title; no <time>), Hacker News (dated title, user?id= link; no image at
 * all), Lobsters and Telegram (<time>), Steam reviews (avatar host, /id/ pair; no date
 * element), phpBB (memberlist.php link only). None of it counts in the middle of a
 * sentence.
 */
function isEvidence(el: Element, pictured: Set<string>): boolean {
  const tag = tagOf(el);
  if (tag === "IMG") return isAvatar(el);
  // What it is comes first and is cheap; where it stands is asked of the few that qualify —
  // a Wikipedia article has some six thousand links with a `title`, none of them a moment.
  return isByKind(el, tag, pictured) && !inRunningText(el);
}

function isByKind(el: Element, tag: string, pictured: Set<string>): boolean {
  if (tag === "TIME" || tag === "RELATIVE-TIME" || el.hasAttribute("datetime")) return true;
  const title = el.getAttribute("title");
  if (title && spellsOutMoment(title)) return true;
  if (tag !== "A") return false;
  if (isPersonLink(el)) return true;
  if (pictured.size === 0) return false;
  const place = placeOf(el);
  if (place === null || !pictured.has(place)) return false;
  const text = (el.textContent ?? "").trim();
  return text !== "" && text.length <= MAX_CAPTION_CHARS;
}

/**
 * CONTROLS, not content: text a reader is not given to read, told by markup alone. A GitHub
 * Discussions comment sets its "…" menu BEFORE its header in the DOM — `div[hidden]` with the
 * menu's items (126 characters, measured logged-out; some 300 logged-in), a `tool-tip[popover]`,
 * buttons — so its byline had "text on both sides", stood "in the middle of somebody's text",
 * and every top-level comment stayed bare: a 206-word comment that fits one window was cut
 * in two, two comments of 76 and 54 words got nothing. Classic GitHub menus are closed
 * <details>; an OPEN one shows what it holds, and that counts (Reddit sets a whole comment
 * in `<details open>`).
 */
const CONTROL_SELECTOR =
  'button,select,textarea,input,option,template,script,style,[hidden],[popover],[role="menu"],[role="menuitem"],details:not([open])';

/** The text under `node` that is content, counted no further than `limit` matters. */
function contentChars(node: Node, limit: number): number {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").trim().length;
  if (node.nodeType !== Node.ELEMENT_NODE) return 0;
  const el = node as Element;
  if (el.matches(CONTROL_SELECTOR)) return 0;
  if (!el.querySelector(CONTROL_SELECTOR)) return (el.textContent ?? "").trim().length;
  let chars = 0;
  for (let child = el.firstChild; child && chars <= limit; child = child.nextSibling) chars += contentChars(child, limit - chars);
  return chars;
}

/** The content inside `within` that stands before (or after) `byline`, counted no further
 *  than it matters. */
function textBeside(byline: Element, within: Element, side: "previousSibling" | "nextSibling"): number {
  let chars = 0;
  for (let cur: Node | null = byline; cur && cur !== within && chars <= EDGE_CHARS; cur = cur.parentNode) {
    for (let sib = cur[side]; sib && chars <= EDGE_CHARS; sib = sib[side]) chars += contentChars(sib, EDGE_CHARS - chars);
  }
  return chars;
}

/**
 * An ARTICLE with comments under it is no opening post. A Hugging Face paper page sets an
 * "AI-generated summary" and the authors' abstract under headings of their own, in one
 * column, above the comment thread: as "one post" — in which a heading is no boundary — the
 * 24-word summary was read together with the abstract, two voices under one chip. A forum's
 * opening post carries its title at most (V2EX's `div.header > h1`); a text with a title AND
 * section headings is an article, and is read as the page always read it.
 */
function isSectioned(el: Element): boolean {
  return el.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]').length > 1;
}

/** Page furniture: what stands around the content, whatever is listed inside it. */
function isFurniture(el: Element): boolean {
  const tag = tagOf(el);
  if (tag === "ASIDE" || tag === "NAV" || tag === "HEADER" || tag === "FOOTER") return true;
  const role = el.getAttribute("role");
  return role === "complementary" || role === "navigation" || role === "banner" || role === "contentinfo";
}

/** Never a post: the page, and what the page declares to be its one main column. */
function isPageLevel(el: Element): boolean {
  const tag = tagOf(el);
  return tag === "HTML" || tag === "BODY" || tag === "MAIN" || el.getAttribute("role") === "main";
}

function composedParent(el: Element): Element | null {
  if (el.parentElement) return el.parentElement;
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root.host : null;
}

/** The scopes of one scan of `doc`. Cheap to create: the page is surveyed on first use. */
export function createScopes(doc: Document = document): Scopes {
  /** Every element with byline evidence below it (light DOM) → the FIRST such evidence. */
  let bylines: Map<Element, Element> | null = null;
  const shapes = new Map<Element, string>();
  /** Per parent: how many of its children have each shape. */
  const census = new Map<Element, Map<string, number>>();
  const own = new Map<Element, boolean>();
  let holders: Set<Element> | null = null;
  /** Per parent: its children that have a thread-holding sibling after them. */
  const followed = new Map<Element, Set<Element>>();
  const several = new Map<Element, boolean>();
  const posts = new Map<Element, boolean>();
  const nearest = new Map<Element, Element | null>();

  /** Document order, so the first evidence to reach an ancestor is the first inside it. */
  function survey(): Map<Element, Element> {
    const found = new Map<Element, Element>();
    const pictured = picturedPlaces(doc);
    for (const el of doc.querySelectorAll(EVIDENCE_CANDIDATES)) {
      if (!isEvidence(el, pictured)) continue;
      for (let cur: Element | null = el; cur && !found.has(cur); cur = cur.parentElement) found.set(cur, el);
    }
    return found;
  }

  /** What "like it" compares: the leading class token, and the chain of tags that leads
   *  from the element down to its byline. */
  function shapeOf(el: Element, byline: Element): string {
    let shape = shapes.get(el);
    if (shape === undefined) {
      shape = byline.localName;
      for (let cur = byline; cur !== el && cur.parentElement; cur = cur.parentElement) shape = `${cur.parentElement.localName}>${shape}`;
      shape = `${(el.getAttribute("class") ?? "").trim().split(/\s+/, 1)[0]}|${shape}`;
      shapes.set(el, shape);
    }
    return shape;
  }

  /**
   * The byline is the element's OWN: no element between the two is one of several like it.
   * Steam loads reviews in pages (`div#page1`, `div#page2`, …) of rows of cards, GitHub groups
   * timeline items in <section>s: containers that repeat, each "with a byline" — the one of
   * the first post inside it.
   */
  function ownByline(el: Element, byline: Element, all: Map<Element, Element>): boolean {
    let known = own.get(el);
    if (known === undefined) {
      known = true;
      // (A piece of evidence is its own first byline: nothing lies between it and itself.)
      for (let cur = byline === el ? null : byline.parentElement; known && cur && cur !== el; cur = cur.parentElement) known = !severalAlike(cur, all);
      own.set(el, known);
    }
    return known;
  }

  /** How many children of `parent` have this shape — bylined ones whose byline is their own:
   *  the box of replies under a topic is shaped like the topic box, and is no post. */
  function alike(shape: string, parent: Element, all: Map<Element, Element>): number {
    let counts = census.get(parent);
    if (!counts) {
      counts = new Map();
      for (const child of parent.children) {
        const byline = all.get(child);
        if (!byline || !ownByline(child, byline, all)) continue;
        const theirs = shapeOf(child, byline);
        counts.set(theirs, (counts.get(theirs) ?? 0) + 1);
      }
      census.set(parent, counts);
    }
    return counts.get(shape) ?? 0;
  }

  /**
   * The elements that HOLD A THREAD: some element up to THREAD_LEVELS below them is one of
   * several like it. Threads are rare — one on most pages — so they are found once, from the
   * posts upwards; looking three levels down from every child of every parent that was asked
   * cost more than everything else together (10 ms on a Hacker News page of 142 comments).
   */
  function threadHolders(all: Map<Element, Element>): Set<Element> {
    if (!holders) {
      holders = new Set();
      for (const el of all.keys()) {
        if (!severalAlike(el, all)) continue;
        let above = el.parentElement;
        for (let level = 0; above && level < THREAD_LEVELS && !isFurniture(above); level++, above = above.parentElement) holders.add(above);
      }
    }
    return holders;
  }

  /** A thread FOLLOWS `el` among its siblings. Asked by every wrapper inside every comment of
   *  a long thread, so it is answered once per parent, from the last child backwards. */
  function threadFollows(el: Element, all: Map<Element, Element>): boolean {
    const parent = el.parentElement;
    if (!parent) return false;
    let before = followed.get(parent);
    if (!before) {
      before = new Set();
      const holding = threadHolders(all);
      let seen = false;
      for (let child = parent.lastElementChild; child; child = child.previousElementSibling) {
        if (seen) before.add(child);
        else seen = holding.has(child);
      }
      followed.set(parent, before);
    }
    return before.has(el);
  }

  /**
   * ONE OF SEVERAL LIKE IT: a bylined element below page level, the byline its own, with
   * text beside that byline (a row of participants' avatars, `a > img` again and again, is
   * several alike and no text), and a sibling of its shape of which the same is true. The
   * question only ever leads DOWN the tree — to the elements between a byline and its
   * candidates — never to what an ancestor or a neighbour "turned out to be": the answer
   * for an element does not depend on which run asked first, and a partial re-scan finds
   * what the full scan found.
   */
  function severalAlike(el: Element, all: Map<Element, Element>): boolean {
    let known = several.get(el);
    if (known === undefined) {
      const byline = all.get(el);
      const parent = el.parentElement;
      known =
        !!byline &&
        !!parent &&
        !isPageLevel(el) &&
        ownByline(el, byline, all) &&
        alike(shapeOf(el, byline), parent, all) >= 2 &&
        textBeside(byline, el, "previousSibling") + textBeside(byline, el, "nextSibling") > 0;
      several.set(el, known);
    }
    return known;
  }

  function isPost(el: Element): boolean {
    let known = posts.get(el);
    if (known === undefined) {
      known = decide(el);
      posts.set(el, known);
    }
    return known;
  }

  function decide(el: Element): boolean {
    const all = (bylines ??= survey());
    const byline = all.get(el);
    const parent = el.parentElement;
    if (!byline || !parent || isPageLevel(el) || !ownByline(el, byline, all)) return false;
    // Structure first: it is a few look-ups, and it rules out nearly everything — each of the
    // eight wrappers between a Hacker News row and its text "has a byline". What the text
    // around the byline looks like is read for the few elements that could be posts.
    let opening = false;
    if (!severalAlike(el, all) && !likeAPostAround(el, byline, all)) {
      // The opening post, by the company it keeps: the thread that answers it follows it.
      opening = threadFollows(el, all) || (!isPageLevel(parent) && threadFollows(parent, all));
      if (!opening) return false;
    }
    // A byline heads a post or signs it (Steam sets the reviewer UNDER the review). The
    // subsections of a PLOS paper each hold a figure box whose image and download links go to
    // the same place — evidence, in the middle of the text, of nobody's authorship.
    const before = textBeside(byline, el, "previousSibling");
    const after = textBeside(byline, el, "nextSibling");
    if (before > EDGE_CHARS && after > EDGE_CHARS) return false;
    // An opening post holds more than a byline — the header row of a comment stands before
    // the replies too (GitHub discussions: `div.timeline-comment-header`, the body, then the
    // replies) — and it is no article with comments under it.
    return !opening || (before + after > EDGE_CHARS && !isSectioned(el));
  }

  /** A lone reply: shaped like an element around it that is one of several like it. */
  function likeAPostAround(el: Element, byline: Element, all: Map<Element, Element>): boolean {
    const shape = shapeOf(el, byline);
    let above = el.parentElement;
    for (let hops = 0; above && hops < MAX_NEST_HOPS && !isPageLevel(above); hops++, above = above.parentElement) {
      if (above.localName !== el.localName) continue; // the tag leads every shape: a <td> is never shaped like a <tr>
      const theirs = all.get(above);
      if (theirs && shapeOf(above, theirs) === shape && severalAlike(above, all)) return true;
    }
    return false;
  }

  return {
    of(el: Element): Element | null {
      const path: Element[] = [];
      let scope: Element | null = null;
      for (let cur: Element | null = el; cur; cur = composedParent(cur)) {
        const known = nearest.get(cur);
        if (known !== undefined) {
          scope = known;
          break;
        }
        path.push(cur);
        if (cur.matches(DECLARED_SCOPE_SELECTOR) || isPost(cur)) {
          scope = cur;
          break;
        }
      }
      for (const seen of path) nearest.set(seen, scope);
      return scope;
    },

    recognised(scope: Element | null): boolean {
      return scope !== null && !scope.matches(DECLARED_SCOPE_SELECTOR);
    },

    oneBody(a: Element, b: Element, scope: Element): boolean {
      const above = new Set<Element>();
      for (let cur: Element | null = a; cur && cur !== scope; cur = composedParent(cur)) above.add(cur);
      let body: Element | null = composedParent(b);
      while (body && body !== scope && !above.has(body)) {
        if (!TEXT_MARKUP.has(tagOf(body))) return false;
        body = composedParent(body);
      }
      if (!body || body === scope) return false; // they meet at the post itself, where its byline is
      for (let cur = composedParent(a); cur && cur !== body; cur = composedParent(cur)) if (!TEXT_MARKUP.has(tagOf(cur))) return false;
      return !(bylines ??= survey()).has(body);
    },
  };
}
