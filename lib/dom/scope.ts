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
//   [role=feed]             — an item of a feed, by the position ARIA gives it in the feed:
//     [aria-posinset]         Facebook's logged-in feed marks every post only that way,
//                             `div[aria-posinset]` in `div[role=feed]` (the item
//                             browsertrix-behaviors keys its Facebook behaviour on), with
//                             no `role=article`; the paragraphs of a post were read as the
//                             bare page reads them.
//   bili-comment-renderer,  — Bilibili's comments are nested OPEN shadow roots
//   bili-comment-reply-       (`bili-comments` → `bili-comment-thread-renderer` →
//   renderer                  `bili-comment-renderer` → `bili-rich-text` → `p#contents`);
//                             avatar, name and date each sit in a shadow root of their
//                             own, where no structural test can see them, so the two
//                             elements that are one comment and one reply are named. The
//                             thread renderer is NOT named: it holds a comment AND the
//                             replies under it. This table is for shadow-DOM components
//                             only and holds tag names, never class names.
//   [itemtype$=Review],     — a customer review, where the page says so in schema.org's
//   [itemprop~=review],       vocabulary: microdata or RDFa. Each review is one person's,
//   [typeof~=Review]          however short; a shop's list of them is no conversation.
//
// A REVIEW'S TEXT can be declared as well — `itemprop="reviewBody"` (microdata),
// `property="reviewBody"` (RDFa), or the `reviewBody` of a Review in the page's JSON-LD,
// found in the page by its words. Where it is, only that text is the review: the reviewer's
// name, the stars, the date, the title and the "12 people found this helpful" row around it
// are the card's (`furniture`). A body with no Review around it in the markup — JSON-LD only,
// or microdata without the wrapper — is a review of its own in the largest box that holds no
// other review's body, when the page holds several: a list of reviews.
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
//   byline   — evidence, inside the element, of who wrote it or when, or of the rating a
//              customer gave with it (see `isEvidence`).
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
// QUOTED HISTORY — a reply and the messages it quotes are different voices. Apple Mail and
// Thunderbird quote in a `blockquote[type=cite]`, which is declared above, but most mail
// programs mark the history some other way and leave the quoted message standing BESIDE the
// reply, as its siblings: Outlook for Windows starts it with a `div` that draws a thin top
// border around a From / Sent / To / Subject block, Outlook on the web with `div#appendonsend`
// and `div#divRplyFwdMsg`, Gmail and Yahoo wrap it in `div.gmail_quote` and
// `div.yahoo_quoted`, Zimbra with `hr[data-marker=__DIVIDER__]`, and a forward anywhere with
// the From / Sent / To / Subject block alone. Read as one voice, a reply and the message it
// answers got one verdict describing neither. The markers are mailgun talon's
// (https://github.com/mailgun/talon, talon/html_quotations.py, Apache-2.0, Copyright Mailgun
// Inc.) and its JavaScript port planer's (https://github.com/lever/planer,
// src/htmlPlaner.coffee, MIT, Copyright (c) 2015 Leighton Wallace). As they do, the history
// runs from its MARKER to the end of the message: the marker and every later sibling of it.
// Its scope is named by the marker, which therefore does not CONTAIN all of what it names
// (`holds`). A history quoted inside a history is a voice of its own again, and the header
// block and the "On … wrote:" line of `div.gmail_attr` are nobody's text (`header`).
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
// page is surveyed for bylines (two querySelectorAll) and for the markers of quoted mail (one
// more) lazily, and every other answer is cached per element — for as long as the page's light
// DOM stays as it was (ScopeSurvey), which a walker keeps from one scan to the next.
import { INLINE_FALLBACK_TAGS, tagOf } from "./tags";

/** A customer review in schema.org's vocabulary: microdata (`itemtype` Review, UserReview,
 *  CriticReview …, or `itemprop="review"`) or RDFa (`typeof="Review"`). Never the page. */
const REVIEW_SCOPE_SELECTOR =
  '[itemtype$="Review"]:not(html,body,main),[itemprop~="review"]:not(html,body,main),[typeof~="Review"]:not(html,body,main),[typeof~="schema:Review"]:not(html,body,main)';

const DECLARED_SCOPE_SELECTOR =
  'article,[role="article"],blockquote,figure,[role="link"],[role="list"] [role="listitem"]:not(li),[role="feed"] [aria-posinset],bili-comment-renderer,bili-comment-reply-renderer,' +
  REVIEW_SCOPE_SELECTOR;

/** The element that holds a review's own text, where the markup says which (see REVIEW'S TEXT). */
const REVIEW_BODY_SELECTOR = '[itemprop~="reviewBody"],[property~="reviewBody"],[property~="schema:reviewBody"]';

/** Everything that could be byline evidence; `isEvidence` decides. */
const EVIDENCE_CANDIDATES = "time,relative-time,[datetime],[title],[aria-label],img,a[href],svg title";

/**
 * A RATING, as a star widget says it to a screen reader, in a tooltip or in its picture's
 * alternative text: "Rated 3 stars out of five stars" (Google Play), " 5 stars " (Google Maps),
 * "5 star rating" (Yelp), "Rating 4 out of 5" (Goodreads), "5.0 out of 5 stars" (Amazon),
 * "5.0 of 5 bubbles" (Tripadvisor), "Rated 5 out of 5 stars" (Trustpilot), "5 Stars" / "5 星"
 * (the App Store). A number with a unit of stars, or "out of" a scale, or after "rated" — "3 of
 * 5" alone is a carousel's page.
 */
const RATING_UNIT = String.raw`(?:stars?|bubbles?|étoiles?|sterne?n?|estrellas?|stelle|estrelas?|звезд\p{L}*|(?:颗|顆)?星)`;
const RATING_NUMBER = String.raw`\d{1,2}(?:[.,]\d{1,2})?`;
const RATING_RE = new RegExp(
  String.raw`^(?:(?:rated|rating|note|bewertung|calificación|valutazione|评分|評分)\b\D{0,12}${RATING_NUMBER}` +
    String.raw`|${RATING_NUMBER}\s*(?:out\s+of\s+(?:${RATING_NUMBER}|five|ten)\b|(?:of|\/|von|sur|de|su|из)\s*(?:${RATING_NUMBER}|five|ten)\s*${RATING_UNIT}|-?\s*${RATING_UNIT}(?!\p{L})))`,
  "iu",
);
const MAX_RATING_CHARS = 60;

function saysRating(label: string | null): boolean {
  const s = label?.trim() ?? "";
  return s !== "" && s.length <= MAX_RATING_CHARS && RATING_RE.test(s);
}

/** A `title` that spells out a moment: Hacker News' `span.age[title="2026-09-18T07:00:00 …"]`,
 *  V2EX's `span.ago[title]`, Substack's `a[title="Sep 12, 2026, 3:04 PM"]` around "2h" — an
 *  ISO date, or a clock time next to a year. Wikipedia's `title="Special:BookSources/978-…"`
 *  is digits and dashes too, and a chapter-and-verse "3:16" is no moment. */
const ISO_DATE_RE = /(?<![\d-])(?:19|20)\d{2}-\d{1,2}-\d{1,2}(?![\d-])/;
const CLOCK_RE = /(?<![\d:])\d{1,2}:\d{2}(?![\d])/;
const MOMENT_YEAR_RE = /(?<!\d)(?:19|20)\d{2}(?!\d)/;
const MAX_MOMENT_TITLE_CHARS = 40;

function spellsOutMoment(title: string): boolean {
  if (title.length > MAX_MOMENT_TITLE_CHARS || !/\d[:-]\d/.test(title)) return false;
  return ISO_DATE_RE.test(title) || (CLOCK_RE.test(title) && MOMENT_YEAR_RE.test(title));
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
const IN_SENTENCE_CHARS = 24;
/** Wrappers looked through for that: `<b><a>@alice</a></b>` in the middle of a sentence. */
const SENTENCE_WRAPPER_HOPS = 3;
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
  /** The voice `outer` names takes in `inner`: `outer` contains it, or `outer` is the marker
   *  of a quoted history and `inner` stands in that history, after the marker. */
  holds(outer: Element, inner: Element): boolean;
  /** A header block or an attribution line of a quoted mail message: never scored. */
  header(el: Element): boolean;
  /** An element or a text of a review card that declares its text, standing outside that text:
   *  the reviewer's name, the stars, the date, "Helpful" — never scored (REVIEW'S TEXT). */
  furniture(node: Node): boolean;
}

function isText(node: Node | null): node is Text {
  return !!node && node.nodeType === Node.TEXT_NODE;
}

function besideRunningText(node: Node | null): boolean {
  return isText(node) && (node.textContent ?? "").trim().length > IN_SENTENCE_CHARS;
}

/**
 * The element stands in the middle of a sentence. "Fixed in 4.2 by <a href="/u/bob">@bob</a>,
 * thanks" in a changelog and "On <time>3 March</time> the council voted …" in a news story
 * are one author's running text, not a byline; "Posted by <a>alice</a> » <time>…</time>"
 * (phpBB) and "alice commented <relative-time>" (GitHub) have only a connective beside them.
 */
function inRunningText(el: Element): boolean {
  let cur = el;
  for (let hops = 0; hops <= SENTENCE_WRAPPER_HOPS; hops++) {
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
  if (host && siteOf(host[1]!.toLowerCase()) !== siteOf(location.hostname)) return false;
  return (a.textContent ?? "").trim().length <= MAX_NAME_CHARS;
}

/** Where a link goes, tracking parameters and fragments aside (LinkedIn's avatar and name
 *  links differ in `?trk=` only); null for links that go nowhere else. */
function placeOf(a: Element): string | null {
  const href = a.getAttribute("href") ?? "";
  const cut = href.search(/[?#]/);
  const place = cut < 0 ? href : href.slice(0, cut);
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
  if (tag === "IMG") return isAvatar(el) || saysRating(el.getAttribute("alt"));
  // What it is comes first and is cheap; where it stands is asked of the few that qualify —
  // a Wikipedia article has some six thousand links with a `title`, none of them a moment.
  return isByKind(el, tag, pictured) && !inRunningText(el);
}

/** Controls say what they do, not what a reviewer thought: "Rate 5 stars" is a button. */
const RATING_CONTROL_SELECTOR = 'button,input,select,option,[role="button"],[role="radio"],[role="slider"],[role="option"],[role="tab"]';

function isByKind(el: Element, tag: string, pictured: Set<string>): boolean {
  if (tag === "TIME" || tag === "RELATIVE-TIME" || el.hasAttribute("datetime")) return true;
  const title = el.getAttribute("title");
  if (title && spellsOutMoment(title)) return true;
  // WHAT THEY THOUGHT: the stars a review was given (RATING_RE), in a label, a tooltip or the
  // <title> of the drawing — never a control that asks for a rating.
  if ((tag === "TITLE" ? saysRating(el.textContent) : saysRating(el.getAttribute("aria-label")) || saysRating(title)) && !el.closest(RATING_CONTROL_SELECTOR)) return true;
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

/** The text under `node` that is content, counted no further than `limit` matters. In
 *  document order, from a list of the nodes still to count rather than a call per level: a
 *  page can nest elements deeper than the stack goes. */
function contentChars(node: Node, limit: number): number {
  let chars = 0;
  for (const stack = [node]; stack.length > 0 && chars <= limit; ) {
    const at = stack.pop()!;
    if (at.nodeType === Node.TEXT_NODE) {
      chars += (at.textContent ?? "").trim().length;
      continue;
    }
    if (at.nodeType !== Node.ELEMENT_NODE) continue;
    const el = at as Element;
    if (el.matches(CONTROL_SELECTOR)) continue;
    if (!el.querySelector(CONTROL_SELECTOR)) {
      chars += (el.textContent ?? "").trim().length;
      continue;
    }
    for (let child = el.lastChild; child; child = child.previousSibling) stack.push(child);
  }
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

// ---- quoted history in a mail message ------------------------------------------------------

/** A mail program's class or id as a webmail shows it: Outlook on the web gives every class
 *  and id of a received message an `x_` prefix, Gmail an `m_` and a number. */
const MAIL_PREFIX = String.raw`(?:x_|m_-?\d+_?)?`;
/** A box that holds the whole quoted history (talon: `cut_gmail_quote`, `cut_yahoo_quote`). */
const QUOTE_BOX_RE = new RegExp(`^${MAIL_PREFIX}(?:gmail_quote|yahoo_quoted)$`);
/** The line above a quotation that says who wrote it and when. */
const ATTRIBUTION_CLASS_RE = new RegExp(`^${MAIL_PREFIX}(?:gmail_attr|moz-cite-prefix)$`);
/** Outlook on the web's reply markers and the section Outlook for Mac wraps a quotation in
 *  (talon: QUOTE_IDS; planer: OUTLOOK_SPLITTER_QUOTE_IDS). */
const QUOTE_ID_RE = new RegExp(`^${MAIL_PREFIX}(?:divRplyFwdMsg|appendonsend|OLK_SRC_BODY_SECTION)$`);
/** Outlook's splitter, the box around the header block: a one-point top border in #E1E1E1
 *  (Outlook 2013 and later) or #B5C4DF (2007, 2010, Outlook for Mac), or Windows Mail's
 *  five-pixel padding over a rgb(229, 229, 229) border — talon's `cut_microsoft_quote`,
 *  spacing and case aside. A border set in points is Word's, not a web page's. */
const SPLITTER_STYLE_RE =
  /border-top\s*:\s*(?:solid\s+#(?:e1e1e1|b5c4df)\s+1(?:\.0)?pt|#b5c4df\s+1(?:\.0)?pt\s+solid)|padding-top\s*:\s*5px;\s*border-top-color\s*:\s*rgb\(229,\s*229,\s*229\)/i;
const MAIL_MARKER_SELECTOR = [
  'div[class*="gmail_quote"]',
  'div[class*="yahoo_quoted"]',
  '[class*="gmail_attr"]',
  '[class*="moz-cite-prefix"]',
  '[id*="divRplyFwdMsg"]',
  '[id*="appendonsend"]',
  '[id*="OLK_SRC_BODY_SECTION"]',
  'hr[data-marker="__DIVIDER__"]',
  'div[style*="border-top" i]',
  "b",
  "strong",
].join(",");
/** The labels of a header block that starts a forwarded or quoted message (talon's
 *  `cut_from_block` and RE_FROM_COLON_OR_DATE_COLON), set in bold by Outlook. */
const HEADER_LABEL_RE = /^(From|Sent|Date|To|Cc|Subject)\s?:$/;
/** A From line and at least two of the others make a header block. */
const MIN_HEADER_LABELS = 3;
/** How many sibling blocks after the From line may carry the rest of the block (Apple Mail
 *  sets each line in a <div> of its own). */
const MAX_HEADER_LINES = 6;
/** Longer than this, the block holding a bold "From:" is somebody's text, not a header. */
const MAX_HEADER_CHARS = 1000;

interface MailHistory {
  /** Every marker a quoted history starts at … */
  starts: Set<Element>;
  /** … per parent, in document order. */
  byParent: Map<Element, Element[]>;
  /** The header blocks and attribution lines: the mail program's words, never scored. */
  headers: Set<Element>;
}

/** Short enough to be a header block and nothing more. */
function isShort(el: Element): boolean {
  return (el.textContent ?? "").length <= MAX_HEADER_CHARS;
}

/** Up through wrappers that hold nothing but this (Outlook: `<div><div style="border-top:…">`,
 *  the splitter alone in a div). Never into a scope: a message that is nothing but a forward
 *  does not make the thread around it a history. */
function wholeWrapper(el: Element): Element {
  let at = el;
  for (let hops = 0; hops < 2; hops++) {
    const parent = at.parentElement;
    if (!parent || parent.childElementCount !== 1 || isPageLevel(parent) || parent.matches(DECLARED_SCOPE_SELECTOR)) break;
    let alone = true;
    for (const n of parent.childNodes) if (isText(n) && (n.textContent ?? "").trim()) alone = false;
    if (!alone) break;
    at = parent;
  }
  return at;
}

/** The header lines that begin at the block holding a bold "From:" — the block itself and
 *  the sibling blocks after it that open with a bold label — or null when they do not add up
 *  to a header (an article that sets "From:" in bold in a sentence of its own). */
function headerBlock(from: Element): Element[] | null {
  let block: Element | null = from.parentElement;
  while (block && INLINE_FALLBACK_TAGS.has(tagOf(block))) block = block.parentElement;
  if (!block || isPageLevel(block) || !isShort(block)) return null;
  const labels = new Set<string>();
  const labelsIn = (el: Element): void => {
    for (const b of el.querySelectorAll("b,strong")) {
      const m = HEADER_LABEL_RE.exec((b.textContent ?? "").trim());
      if (m) labels.add(m[1]!);
    }
  };
  labelsIn(block);
  const lines = [block];
  for (let next = block.nextElementSibling; next && lines.length <= MAX_HEADER_LINES; next = next.nextElementSibling) {
    const first = next.querySelector("b,strong");
    const label = first && HEADER_LABEL_RE.exec((first.textContent ?? "").trim());
    if (!label || !(next.textContent ?? "").trim().startsWith((first.textContent ?? "").trim())) break;
    labels.add(label[1]!);
    lines.push(next);
  }
  return labels.has("From") && labels.size >= MIN_HEADER_LABELS ? lines : null;
}

function surveyMail(doc: Document): MailHistory {
  const starts = new Set<Element>();
  const headers = new Set<Element>();
  const tokens = (el: Element): string[] => (el.getAttribute("class") ?? "").split(/\s+/);
  for (const el of doc.querySelectorAll(MAIL_MARKER_SELECTOR)) {
    const tag = tagOf(el);
    if (tag === "B" || tag === "STRONG") {
      if (!/^From\s?:$/.test((el.textContent ?? "").trim())) continue;
      const lines = headerBlock(el);
      if (!lines) continue;
      for (const line of lines) headers.add(line);
      starts.add(wholeWrapper(lines[0]!));
    } else if (tag === "HR") {
      starts.add(el);
    } else if (QUOTE_ID_RE.test(el.id)) {
      starts.add(el);
      if (/divRplyFwdMsg$/.test(el.id) && isShort(el)) headers.add(el);
    } else if (tokens(el).some((t) => ATTRIBUTION_CLASS_RE.test(t))) {
      headers.add(el);
    } else if (tag === "DIV" && tokens(el).some((t) => QUOTE_BOX_RE.test(t))) {
      starts.add(el);
    } else if (tag === "DIV" && SPLITTER_STYLE_RE.test(el.getAttribute("style") ?? "")) {
      if (isShort(el)) headers.add(el);
      starts.add(wholeWrapper(el));
    }
  }
  const byParent = new Map<Element, Element[]>();
  for (const start of starts) {
    const parent = start.parentElement;
    if (!parent) continue;
    const list = byParent.get(parent);
    if (list) list.push(start);
    else byParent.set(parent, [start]);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  return { starts, byParent, headers };
}

// ---- declared reviews and their text -------------------------------------------------------

interface Reviews {
  /** Review cards known only by their body (JSON-LD, or a reviewBody with no Review around it). */
  cards: Set<Element>;
  /** The elements from each card down to its body, the body left out: whatever else stands in
   *  one of them is the card's, not the review's. */
  path: Set<Element>;
  /** The bodies themselves. */
  bodies: Set<Element>;
}

const NO_REVIEWS: Reviews = { cards: new Set(), path: new Set(), bodies: new Set() };

/** Words of a text for finding it again: letters and digits, one space between them. */
function wordsOnly(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** A review body must be this long to be looked for by its words, and is looked for by this
 *  many characters at each end. */
const MIN_FOUND_CHARS = 24;
const PROBE_CHARS = 32;
/** How deep JSON-LD is searched for Review objects, and how many texts are looked for. */
const MAX_LD_DEPTH = 12;
const MAX_LD_REVIEWS = 200;

/** The text of every Review in the page's JSON-LD: its `reviewBody`, else its `description`
 *  (Yelp's LocalBusiness lists its reviews that way). */
function jsonLdReviewTexts(doc: Document): string[] {
  const out: string[] = [];
  const visit = (x: unknown, depth: number): void => {
    if (depth > MAX_LD_DEPTH || out.length >= MAX_LD_REVIEWS || x === null || typeof x !== "object") return;
    if (Array.isArray(x)) {
      for (const item of x) visit(item, depth + 1);
      return;
    }
    const o = x as Record<string, unknown>;
    const type = o["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((t) => typeof t === "string" && /Review$/.test(t))) {
      const text = typeof o.reviewBody === "string" ? o.reviewBody : typeof o.description === "string" ? o.description : null;
      if (text) out.push(text);
    }
    for (const value of Object.values(o)) visit(value, depth + 1);
  };
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    const source = script.textContent ?? "";
    const known = ldTexts.get(script);
    if (known && known.source === source) {
      out.push(...known.texts);
      continue;
    }
    const before = out.length;
    try {
      visit(JSON.parse(source), 0);
    } catch {
      // A page's broken JSON-LD says nothing.
    }
    ldTexts.set(script, { source, texts: out.slice(before) });
  }
  return out;
}

/** Each JSON-LD script's review texts, parsed once for as long as it says the same: every
 *  scan asks, and a product page re-scans as its parts load. */
const ldTexts = new WeakMap<Element, { source: string; texts: string[] }>();

/** Where each review text was found last, by its opening and closing words: looked for again
 *  only when that element has left the page or no longer holds it. Weak, so a feed that
 *  virtualizes its reviews keeps nothing it dropped. */
const locatedTexts = new Map<string, WeakRef<Element>>();
const MAX_LOCATED = 2000;

/** The elements that hold each of `texts` in the page: the text node its opening words stand
 *  in, widened until it holds its closing words too. */
function locateTexts(doc: Document, texts: string[]): Element[] {
  const wanted = texts
    .map(wordsOnly)
    .filter((t) => t.length >= MIN_FOUND_CHARS)
    .map((t) => ({ head: t.slice(0, PROBE_CHARS), tail: t.slice(-PROBE_CHARS), length: t.length }));
  if (wanted.length === 0 || !doc.body) return [];
  const found: Element[] = [];
  const keyOf = (w: { head: string; tail: string }): string => `${w.head}\u0000${w.tail}`;
  for (let i = wanted.length - 1; i >= 0; i--) {
    const w = wanted[i]!;
    const el = locatedTexts.get(keyOf(w))?.deref();
    if (!el || !el.isConnected || el.ownerDocument !== doc) continue;
    const text = wordsOnly(el.textContent ?? "");
    if (!text.includes(w.head) || !text.includes(w.tail)) continue;
    found.push(el);
    wanted.splice(i, 1);
  }
  if (locatedTexts.size > MAX_LOCATED) locatedTexts.clear();
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && wanted.length > 0; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest("script,style,noscript,template")) continue;
    const words = wordsOnly(node.textContent ?? "");
    if (words.length < MIN_FOUND_CHARS / 2) continue;
    const at = wanted.findIndex((w) => words.includes(w.head.slice(0, Math.min(w.head.length, words.length))) || w.head.startsWith(words));
    if (at < 0) continue;
    const w = wanted[at]!;
    for (let el: Element | null = parent; el && el !== doc.body; el = el.parentElement) {
      const text = wordsOnly(el.textContent ?? "");
      if (text.length > 2 * w.length + 400) break; // past the review: the list it stands in
      if (text.includes(w.tail)) {
        found.push(el);
        locatedTexts.set(keyOf(w), new WeakRef(el));
        wanted.splice(at, 1);
        break;
      }
    }
  }
  return found;
}

/** Most words a card known by its body alone holds beside the body: the reviewer's name, a
 *  location, a count of reviews, the date, a title, "Date of experience", Useful and Share. */
const CARD_EXTRA_WORDS = 60;

function wordCount(s: string): number {
  return s.match(/\S+/g)?.length ?? 0;
}

/** The reviews whose text the page declares, and what of their cards is not that text. */
function surveyReviews(doc: Document): Reviews {
  const bodies = new Set<Element>(doc.querySelectorAll(REVIEW_BODY_SELECTOR));
  if (doc.querySelector('script[type="application/ld+json"]')) for (const el of locateTexts(doc, jsonLdReviewTexts(doc))) bodies.add(el);
  if (bodies.size === 0) return NO_REVIEWS;
  const reviews: Reviews = { cards: new Set(), path: new Set(), bodies: new Set() };
  const holdsAnother = (box: Element, own: Element): boolean => {
    for (const other of bodies) if (other !== own && box.contains(other)) return true;
    return false;
  };
  for (const body of bodies) {
    // A body inside another one (a quotation with its own markup) is that review's text.
    if ([...bodies].some((other) => other !== body && other.contains(body))) continue;
    let card: Element | null = body.parentElement?.closest(REVIEW_SCOPE_SELECTOR) ?? null;
    if (card && holdsAnother(card, body)) continue; // one card, two texts: say nothing
    if (!card) {
      // Known by its body alone: the largest box that holds no other review's text, and no
      // more beside it than a card's name, stars, date and buttons. On a page with ONE such
      // body nothing says where its review ends, and the page is no card. movebuddha.com's
      // JSON-LD gives each mover's summary as a Review, in a section that also holds the
      // editor's description of the mover: that is no card's furniture.
      if (bodies.size < 2) continue;
      const own = wordCount(body.textContent ?? "");
      let box = body;
      while (
        box.parentElement &&
        !isPageLevel(box.parentElement) &&
        !holdsAnother(box.parentElement, body) &&
        wordCount(box.parentElement.textContent ?? "") - own <= CARD_EXTRA_WORDS
      ) box = box.parentElement;
      if (box === body || isPageLevel(box)) continue;
      card = box;
      reviews.cards.add(card);
    }
    reviews.bodies.add(body);
    for (let at = body.parentElement; at; at = at.parentElement) {
      reviews.path.add(at);
      if (at === card) break;
    }
  }
  return reviews;
}

// ---- the list's own words ----------------------------------------------------------------

/** A text is the list's when at least this many of its cards repeat it, and half of them. */
const SHARED_MIN = 3;
/** Shorter than this a text is a label or an aside, which no rule reads anyway. */
const SHARED_MIN_CHARS = 16;
/** How far above a post the box of cards is looked for, and how much of a card is read. */
const LIST_LEVELS = 3;
const MAX_CARD_BLOCKS = 400;
/** Cards of one list that are read for it: the template repeats itself long before a feed of
 *  six thousand posts ends. */
const MAX_LIST_CARDS = 60;
/** What another voice says in a card: a reply that quotes a post repeats it word for word, and
 *  a post that three replies quote is still its author's. */
const QUOTATION = "blockquote,q";

/** An element with text of its own, beside its children. */
function ownText(el: Element): boolean {
  for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? "").trim() !== "") return true;
  return false;
}

/** A card's shape: its tag and leading class token, as `shapeOf` compares posts. */
function cardShape(el: Element): string {
  return `${el.localName}.${(el.getAttribute("class") ?? "").trim().split(/\s+/, 1)[0]}`;
}

/** The box that holds `post` among several cards OF ITS OWN SHAPE, and the card it stands in,
 *  or null. A column beside two sidebars is three children and no list of cards. */
function listOf(post: Element): { list: Element; card: Element } | null {
  let card = post;
  for (let up = 0; up < LIST_LEVELS; up++) {
    const parent = card.parentElement;
    if (!parent || isPageLevel(parent)) return null;
    if (parent.childElementCount >= SHARED_MIN) {
      const shape = cardShape(card);
      let alike = 0;
      for (const child of parent.children) if (cardShape(child) === shape && ++alike >= SHARED_MIN) return { list: parent, card };
    }
    card = parent;
  }
  return null;
}

/** A list's shared texts across scans, while its cards are the same ones: a feed is re-scanned
 *  on every mutation, and the template it repeats does not change between two of them. */
const listTexts = new WeakMap<Element, Map<string, { count: number; first: Element | null; last: Element | null; texts: Set<string> }>>();

/** The texts at least SHARED_MIN of `list`'s cards of `shape`, and half of them, hold word for
 *  word. */
function textsSharedIn(list: Element, shape: string): Set<string> {
  let byShape = listTexts.get(list);
  if (!byShape) listTexts.set(list, (byShape = new Map()));
  const known = byShape.get(shape);
  if (known && known.count === list.childElementCount && known.first === list.firstElementChild && known.last === list.lastElementChild) return known.texts;
  const texts = countSharedIn(list, shape);
  byShape.set(shape, { count: list.childElementCount, first: list.firstElementChild, last: list.lastElementChild, texts });
  return texts;
}

function countSharedIn(list: Element, shape: string): Set<string> {
  const counts = new Map<string, number>();
  let cards = 0;
  for (const card of [...list.children].filter((c) => cardShape(c) === shape).slice(0, MAX_LIST_CARDS)) {
    const seen = new Set<string>();
    let blocks = 0;
    for (const el of card.querySelectorAll("*")) {
      if (++blocks > MAX_CARD_BLOCKS) break;
      if (!ownText(el) || el.closest(QUOTATION)) continue;
      const text = wordsOnly(el.textContent ?? "");
      if (text.length >= SHARED_MIN_CHARS) seen.add(text);
    }
    if (seen.size === 0) continue;
    cards++;
    for (const text of seen) counts.set(text, (counts.get(text) ?? 0) + 1);
  }
  const shared = new Set<string>();
  for (const [text, n] of counts) if (n >= SHARED_MIN && 2 * n >= cards) shared.add(text);
  return shared;
}

/**
 * What the scopes know of a page that its LIGHT DOM alone decides: the bylines, the posts and
 * threads recognised, the quoted mail, the reviews. None of it reaches into a shadow root (an
 * element in a shadow tree has no byline here), so it holds for as long as the document's
 * light DOM does not change. Every answer is worked out on first use, element by element.
 *
 * KEPT ACROSS CHANGES (liveScopeSurvey). A feed changes between any two of its drains — a
 * class on the post entering view, a counter, a "3 min. ago" — and a survey made again at each
 * one recognised every post of the page again: on a feed of 650 posts, a third of what the
 * extension's code cost. Told what changed (`changed`), a survey forgets the answers those
 * changes can reach and keeps the rest, which are the answers a new survey would give:
 *   - an answer about an element reads the element's own subtree, its ancestors' tags and
 *     attributes (a rating control around a label), the text beside it and beside the wrappers
 *     that hold it alone (inRunningText), and, for "one of several like it", its parent's
 *     children; so a change forgets everything inside an element whose attributes changed or
 *     whose neighbours did, the answers of every element above a change, and "one of several"
 *     for the children of those;
 *   - which posts are recognised is asked anew each time, from what is kept: a post is told
 *     by what is around and above it as far as eight levels up (likeAPostAround);
 *   - the places a picture links to are the page's (picturedPlaces): where they change, and
 *     where the document element itself changes, nothing is kept;
 *   - the quoted mail and the reviews are surveyed again after any change.
 * test/unit.mjs holds the kept survey to a new one on every fixture after random changes.
 */
export interface ScopeSurvey {
  /** `el` is a post recognised by its structure (see RECOGNISED). */
  isPost(el: Element): boolean;
  /** The quoted history `el` stands in at its own level, or null. */
  historyAt(el: Element): Element | null;
  /** `el`, or something below it, is byline evidence. */
  hasByline(el: Element): boolean;
  mail(): MailHistory;
  reviews(): Reviews;
}

interface KeptSurvey extends ScopeSurvey {
  /** The page changed as `records` say; false when nothing could be kept. */
  changed(records: MutationRecord[]): boolean;
}

export function surveyScopes(doc: Document = document): ScopeSurvey {
  return createSurvey(doc);
}

/** At most this many changes are told to a kept survey between two scans: past it, a survey
 *  made anew costs less than the forgetting would. */
const MAX_KEPT_RECORDS = 2000;

/** A survey of the document kept from one scan to the next, and told what changed in
 *  between. Nothing is looked at, nor any observer made, before the first scan asks. */
export function liveScopeSurvey(docOf: () => Document = () => document): () => ScopeSurvey {
  let survey: KeptSurvey | null = null;
  let pending: MutationRecord[] = [];
  let flooded = false;
  let watch: MutationObserver | null = null;
  // Records come in through the callback between tasks, and through takeRecords() when a scan
  // follows changes made in the same task (a walk's own cuts); the limit holds for both.
  const note = (records: MutationRecord[]): void => {
    if (flooded) return;
    for (const r of records) pending.push(r);
    if (pending.length > MAX_KEPT_RECORDS) {
      flooded = true;
      pending = [];
      watch!.disconnect();
    }
  };
  return () => {
    const doc = docOf();
    watch ??= new MutationObserver(note);
    note(watch.takeRecords());
    if (survey && !flooded && (pending.length === 0 || survey.changed(pending))) {
      pending = [];
      return survey;
    }
    pending = [];
    flooded = false;
    watch.disconnect();
    survey = createSurvey(doc);
    watch.observe(doc, { subtree: true, childList: true, characterData: true, attributes: true });
    return survey;
  };
}

function createSurvey(doc: Document): KeptSurvey {
  /** An element's FIRST byline evidence in document order, itself included, or null. */
  let firstEvidence = new WeakMap<Element, Element | null>();
  let shapes = new WeakMap<Element, string>();
  /** Per parent: how many of its children have each shape. */
  let census = new WeakMap<Element, Map<string, number>>();
  let own = new WeakMap<Element, boolean>();
  let several = new WeakMap<Element, boolean>();
  /** An element holds a thread (THREAD_LEVELS). */
  let holds = new WeakMap<Element, boolean>();
  /** Per parent: its children that have a thread-holding sibling after them. */
  let followed = new WeakMap<Element, Set<Element>>();
  let posts = new WeakMap<Element, boolean>();
  let pictured: Set<string> | null = null;
  let mail: MailHistory | null = null;
  let reviews: Reviews | null = null;

  function forgetAll(): void {
    firstEvidence = new WeakMap();
    shapes = new WeakMap();
    census = new WeakMap();
    own = new WeakMap();
    several = new WeakMap();
    holds = new WeakMap();
    followed = new WeakMap();
    posts = new WeakMap();
    pictured = null;
    mail = null;
    reviews = null;
  }

  function forget(el: Element): void {
    firstEvidence.delete(el);
    shapes.delete(el);
    census.delete(el);
    own.delete(el);
    several.delete(el);
    holds.delete(el);
    followed.delete(el);
  }

  const picturedNow = (): Set<string> => (pictured ??= picturedPlaces(doc));

  function isCandidate(el: Element): boolean {
    return el.matches(EVIDENCE_CANDIDATES) && isEvidence(el, picturedNow());
  }

  /** The first evidence at or below `el`, in document order; null where there is none, and for
   *  an element outside the document's light tree. Found by walking down from `el` a node at a
   *  time, the subtrees already known passed over, and kept for every element it finished. */
  function bylineOf(el: Element): Element | null {
    const known = firstEvidence.get(el);
    if (known !== undefined) return known;
    if (el.getRootNode() !== doc) {
      firstEvidence.set(el, null);
      return null;
    }
    const open: Element[] = [];
    let node: Element = el;
    let found: Element | null = null;
    search: for (;;) {
      const kept = node === el ? undefined : firstEvidence.get(node);
      if (kept) { found = kept; break; }
      if (kept === undefined) {
        if (isCandidate(node)) {
          firstEvidence.set(node, node);
          found = node;
          break;
        }
        open.push(node);
        const child = node.firstElementChild;
        if (child) { node = child; continue; }
      }
      // Nothing at or below `node`: on to the next element after it, closing what is done.
      for (;;) {
        if (open[open.length - 1] === node) {
          open.pop();
          firstEvidence.set(node, null);
        }
        if (node === el) break search;
        const next = node.nextElementSibling;
        if (next) { node = next; continue search; }
        node = node.parentElement!;
      }
    }
    for (const at of open) firstEvidence.set(at, found);
    return found;
  }

  /** The quoted history `el` stands in at its own level: the last marker among its siblings
   *  at or before it. */
  function historyAt(el: Element): Element | null {
    const parent = el.parentElement;
    const starts = parent && (mail ??= surveyMail(doc)).byParent.get(parent);
    if (!starts) return null;
    let found: Element | null = null;
    for (const start of starts) {
      if (start !== el && !(start.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
      found = start;
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
  function ownByline(el: Element, byline: Element): boolean {
    let known = own.get(el);
    if (known === undefined) {
      known = true;
      // (A piece of evidence is its own first byline: nothing lies between it and itself.)
      for (let cur = byline === el ? null : byline.parentElement; known && cur && cur !== el; cur = cur.parentElement) known = !severalAlike(cur);
      own.set(el, known);
    }
    return known;
  }

  /** How many children of `parent` have this shape — bylined ones whose byline is their own:
   *  the box of replies under a topic is shaped like the topic box, and is no post. */
  function alike(shape: string, parent: Element): number {
    let counts = census.get(parent);
    if (!counts) {
      counts = new Map();
      for (const child of parent.children) {
        const byline = bylineOf(child);
        if (!byline || !ownByline(child, byline)) continue;
        const theirs = shapeOf(child, byline);
        counts.set(theirs, (counts.get(theirs) ?? 0) + 1);
      }
      census.set(parent, counts);
    }
    return counts.get(shape) ?? 0;
  }

  /**
   * An element HOLDS A THREAD when some element up to THREAD_LEVELS below it, with no
   * furniture between, is one of several like it. Asked of an element's siblings only, and
   * kept: threads are rare — one on most pages — and a long thread asks it of every wrapper
   * inside every comment.
   */
  function holdsThread(el: Element): boolean {
    let known = holds.get(el);
    if (known === undefined) {
      known = !isFurniture(el) && severalBelow(el, THREAD_LEVELS);
      holds.set(el, known);
    }
    return known;
  }

  function severalBelow(el: Element, levels: number): boolean {
    for (const child of el.children) {
      if (severalAlike(child)) return true;
      if (levels > 1 && !isFurniture(child) && severalBelow(child, levels - 1)) return true;
    }
    return false;
  }

  /** A thread FOLLOWS `el` among its siblings. Asked by every wrapper inside every comment of
   *  a long thread, so it is answered once per parent, from the last child backwards. */
  function threadFollows(el: Element): boolean {
    const parent = el.parentElement;
    if (!parent) return false;
    let before = followed.get(parent);
    if (!before) {
      before = new Set();
      let seen = false;
      for (let child = parent.lastElementChild; child; child = child.previousElementSibling) {
        if (seen) before.add(child);
        else seen = holdsThread(child);
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
  function severalAlike(el: Element): boolean {
    let known = several.get(el);
    if (known === undefined) {
      const parent = el.parentElement;
      // The page itself first: it is never one of several, and its byline is a search of the whole page.
      const byline = parent && !isPageLevel(el) ? bylineOf(el) : null;
      known =
        !!byline &&
        ownByline(el, byline) &&
        alike(shapeOf(el, byline), parent!) >= 2 &&
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
    const parent = el.parentElement;
    if (!parent || isPageLevel(el)) return false;
    const byline = bylineOf(el);
    if (!byline || !ownByline(el, byline)) return false;
    // Structure first: it is a few look-ups, and it rules out nearly everything — each of the
    // eight wrappers between a Hacker News row and its text "has a byline". What the text
    // around the byline looks like is read for the few elements that could be posts.
    let opening = false;
    if (!severalAlike(el) && !likeAPostAround(el, byline)) {
      // The opening post, by the company it keeps: the thread that answers it follows it.
      opening = threadFollows(el) || (!isPageLevel(parent) && threadFollows(parent));
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
  function likeAPostAround(el: Element, byline: Element): boolean {
    const shape = shapeOf(el, byline);
    let above = el.parentElement;
    for (let hops = 0; above && hops < MAX_NEST_HOPS && !isPageLevel(above); hops++, above = above.parentElement) {
      if (above.localName !== el.localName) continue; // the tag leads every shape: a <td> is never shaped like a <tr>
      const theirs = bylineOf(above);
      if (theirs && shapeOf(above, theirs) === shape && severalAlike(above)) return true;
    }
    return false;
  }

  /** Forget what `records` can have changed (KEPT ACROSS CHANGES). */
  function changed(records: MutationRecord[]): boolean {
    /** Elements everything at or below which is forgotten. */
    const whole = new Set<Element>();
    /** Elements a change happened in: they and everything above them are forgotten. */
    const within = new Set<Element>();
    const neighbour = (n: Node | null): void => {
      if (n && n.nodeType === Node.ELEMENT_NODE) whole.add(n as Element);
    };
    // childElementCount walks every child: asked once per parent, not once per record, or the
    // pieces of one long text cut apart cost their number squared.
    const counts = new Map<Element, number>();
    const elementsIn = (el: Element): number => {
      let n = counts.get(el);
      if (n === undefined) counts.set(el, (n = el.childElementCount));
      return n;
    };
    for (const r of records) {
      const target = r.target;
      if (r.type === "attributes") {
        whole.add(target as Element);
      } else if (r.type === "characterData") {
        const parent = target.parentElement;
        if (!parent) continue;
        within.add(parent);
        neighbour(target.previousSibling);
        neighbour(target.nextSibling);
        // The text beside a wrapper that holds one element alone is read (inRunningText).
        if (elementsIn(parent) === 1) whole.add(parent);
      } else {
        if (target.nodeType !== Node.ELEMENT_NODE) return false; // the document's own children
        const parent = target as Element;
        within.add(parent);
        neighbour(r.previousSibling);
        neighbour(r.nextSibling);
        let added = 0;
        let removed = 0;
        for (const n of r.addedNodes) if (n.nodeType === Node.ELEMENT_NODE) { added++; whole.add(n as Element); }
        for (const n of r.removedNodes) if (n.nodeType === Node.ELEMENT_NODE) removed++;
        const after = elementsIn(parent);
        if (after === 1 || after - added + removed === 1) whole.add(parent);
      }
    }
    // A picture's place makes evidence of every link to it, anywhere on the page.
    if (pictured) {
      const now = picturedPlaces(doc);
      if (now.size !== pictured.size || [...now].some((p) => !pictured!.has(p))) {
        forgetAll();
        return true;
      }
    }
    for (const el of whole) {
      within.add(el);
      forget(el);
      for (const below of el.querySelectorAll("*")) forget(below);
    }
    const done = new Set<Element>();
    for (const el of within) {
      for (let at: Element | null = el; at && !done.has(at); at = at.parentElement) {
        done.add(at);
        forget(at);
        // Its census may have changed, and with it which of its children are one of several.
        for (const child of at.children) several.delete(child);
      }
    }
    posts = new WeakMap();
    mail = null;
    reviews = null;
    return true;
  }

  return {
    isPost,
    historyAt,
    hasByline: (el) => bylineOf(el) !== null,
    mail: () => (mail ??= surveyMail(doc)),
    reviews: () => (reviews ??= surveyReviews(doc)),
    changed,
  };
}

/** The scopes of one scan of `doc`. Cheap to create: the page is surveyed on first use, unless
 *  the scan is given a survey of the page kept from an earlier one (ScopeSurvey). Which voice
 *  an element stands in is answered once per scan: the way up to it can cross shadow roots. */
export function createScopes(doc: Document = document, page: ScopeSurvey = surveyScopes(doc)): Scopes {
  const nearest = new Map<Element, Element | null>();

  /**
   * THE LIST'S OWN WORDS. A sentence every card of a list repeats is the site's, not the
   * writer's: Tripadvisor ends each review with the same 38 words — "This review is the
   * subjective opinion of a Tripadvisor member and not of Tripadvisor LLC. …" — and a
   * punctuated paragraph of that length is prose to every other rule, a unit of its own at a
   * 25-word minimum. So a block with text of its own, inside a post, whose text stands word for
   * word in at least SHARED_MIN of the cards of its list, and in half of them, is left out
   * like a name row — never a heading, which is a boundary and would take the boundary with
   * it, and never a quotation, nor counted from one (QUOTATION). The list is the nearest box
   * above the post, a few levels up at most, that holds several cards of the post's own shape;
   * its texts are counted once while its cards stay.
   */
  function sharedByTheList(el: Element): boolean {
    if (!ownText(el) || /^H[1-6]$/.test(tagOf(el)) || el.getAttribute("role") === "heading" || el.closest(QUOTATION)) return false;
    const scope = api.of(el);
    if (!scope || scope === el) return false;
    const found = listOf(scope);
    if (!found) return false;
    const texts = textsSharedIn(found.list, cardShape(found.card));
    return texts.size > 0 && texts.has(wordsOnly(el.textContent ?? ""));
  }

  const api: Scopes = {
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
        if (cur.matches(DECLARED_SCOPE_SELECTOR) || page.reviews().cards.has(cur) || page.isPost(cur)) {
          scope = cur;
          break;
        }
        const history = page.historyAt(cur);
        if (history) {
          scope = history;
          break;
        }
      }
      for (const seen of path) nearest.set(seen, scope);
      return scope;
    },

    recognised(scope: Element | null): boolean {
      return scope !== null && !scope.matches(DECLARED_SCOPE_SELECTOR) && !page.reviews().cards.has(scope) && !page.mail().starts.has(scope);
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
      return !page.hasByline(body);
    },

    holds(outer: Element, inner: Element): boolean {
      if (outer.contains(inner)) return true;
      if (!page.mail().starts.has(outer)) return false;
      for (let cur: Element | null = inner; cur; cur = cur.parentElement) {
        if (cur.parentElement === outer.parentElement) return (outer.compareDocumentPosition(cur) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
      }
      return false;
    },

    header(el: Element): boolean {
      return page.mail().headers.has(el);
    },

    furniture(node: Node): boolean {
      const r = page.reviews();
      const parent = node.parentElement;
      // A text standing directly in a box between the card and its body is outside the body;
      // so is an element, unless it is the body or leads down to it.
      if (parent && r.path.has(parent)) return node.nodeType === Node.TEXT_NODE || (!r.path.has(node as Element) && !r.bodies.has(node as Element));
      return node.nodeType === Node.ELEMENT_NODE && sharedByTheList(node as Element);
    },
  };
  return api;
}
