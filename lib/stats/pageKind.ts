// lib/stats/pageKind.ts — what sort of page the words were read on, for the statistics.
//
// Five kinds, and a rule small enough to state in a sentence each. They are told apart by
// what a page declares about itself and by the voices of what is read on it, never by a
// table of sites' class names, which would be wrong within weeks (lib/dom/scope.ts says the
// same of posts):
//
//   document — what a surface reads: the PDF reader, the Google Docs overlay, Drive's and
//              OneDrive's previews, an e-book reader (lib/surfaces/). The caller knows.
//   forum    — a question and its answers, or a thread of replies: the page declares it
//              (schema.org QAPage or DiscussionForumPosting), names forum software in its
//              generator meta, is on a forum's host (forum., community., discuss.), or its
//              address is shaped like one, query included (/questions/…, /comments/…,
//              /thread/…, /t/…, /forum/…, viewtopic.php, ?topic=, Hacker News' item?id=).
//   feed     — posts by many voices, one after another: a page of a well-known feed (the
//              short list below), a page that says it is one (role="feed"), or one where
//              the first paragraphs found stand in five or more separate posts, most of
//              them in a post and none of the posts holding two-fifths of the words.
//   article  — one author's text: the page declares it (a schema.org Article, NewsArticle,
//              BlogPosting, Report, ScholarlyArticle or TechArticle; og:type article, with a
//              body of text of 150 words), or most of what is found stands in one
//              <article>, or in <main> with a body of text, or there is such a body at all:
//              300 words one element holds. Comments under an article leave it an article; a product page is none.
//   other    — anything else: a shop, a search page, a mail client, a dashboard.
//
// Its numbers were checked on the web benchmark's pages labelled article, forum and other
// (2026-10-09): 0.62 → 0.80 of the held-out pages filed right. It has no real feeds to be
// checked on.
//
// The rule is asked again with each message, and costs a few selector queries and a look at
// the first paragraphs found. What it looked at is kept with the visit (KindSignals), so the
// rule can be checked on a labelled sample, or another tried, afterwards (kindFrom).
import type { Unit } from "../types";
import type { KindSignals, PageKind } from "./model";
import { DEFAULT_KIND_RULE, type KindRule } from "./lens";

/** Hosts whose pages are feeds whatever their markup says (with their subdomains). */
const FEED_HOSTS = [
  "x.com", "twitter.com", "facebook.com", "instagram.com", "threads.net", "threads.com", "bsky.app",
  "linkedin.com", "mastodon.social", "tumblr.com", "weibo.com", "weibo.cn", "reddit.com", "tiktok.com",
];

/** Addresses a thread lives at on the common forum and Q&A software, the query included
 *  (index.php?threads/…, viewtopic.php?t=…). */
const FORUM_ADDRESS = /[/?](?:questions?|comments|threads?|t|discussions?)\/[^/]|\b(?:viewthread|viewtopic|showthread|showtopic|printthread)\b|[?&]topic=\d|\/topic\/\d|\/t-\d+\.html|\/forums?\/[^/]/i;
/** Forum software as a page's generator meta names it. */
const FORUM_SOFTWARE = /discourse|vbulletin|phpbb|xenforo|mybb|\bsmf\b|simple machines|ubb\.threads|invision|nodebb|flarum|vanilla/i;
const FORUM_HOST = /^(?:forums?|community|discuss)\./i;
const FORUM_TYPES = /"@type"\s*:\s*\[?\s*"(?:QAPage|DiscussionForumPosting)"/;
const ARTICLE_TYPES = /"@type"\s*:\s*\[?\s*"(?:Article|NewsArticle|BlogPosting|Report|ScholarlyArticle|TechArticle)"/;

/** A post of a feed or a thread, where the markup marks one (lib/dom/scope.ts, DECLARED); the
 *  recorder files paragraphs by it too (lib/stats/recorder.ts). */
export const POST = 'article, [role="article"], [aria-posinset], [role="listitem"]:not(li)';
/** How many paragraphs are looked at: the first found, in the walk's order, are the page's own. */
export const KIND_SAMPLE = 64;
/** How much of the page's JSON-LD is looked at, at most. */
const LD_CHARS = 20_000;

function hostIn(host: string, list: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/^www\./, "");
  return list.some((d) => h === d || h.endsWith(`.${d}`));
}

function structuredData(doc: Document): string {
  let text = "";
  for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) {
    text += script.textContent ?? "";
    if (text.length >= LD_CHARS) break;
  }
  return text.slice(0, LD_CHARS);
}

function declares(doc: Document, types: RegExp, itemtypes: RegExp): boolean {
  for (const el of doc.querySelectorAll("[itemtype]")) if (itemtypes.test(el.getAttribute("itemtype") ?? "")) return true;
  return types.test(structuredData(doc));
}

/** What a page says about itself and how its first paragraphs read stand, for the rule. */
export function kindSignals(doc: Document, address: { hostname: string; pathname: string; search?: string }, units: readonly Unit[]): KindSignals {
  const forumDeclared = declares(doc, FORUM_TYPES, /schema\.org\/(?:QAPage|DiscussionForumPosting)\b/);
  const og = doc.querySelector('meta[property="og:type"]')?.getAttribute("content")?.trim().toLowerCase();
  const articleTyped = declares(doc, ARTICLE_TYPES, /schema\.org\/(?:Article|NewsArticle|BlogPosting|Report|ScholarlyArticle|TechArticle)\b/);
  const articleDeclared = og === "article" || articleTyped;
  const generator = doc.querySelector('meta[name="generator" i]')?.getAttribute("content") ?? "";
  const sample = units.slice(0, KIND_SAMPLE);
  const posts = new Map<Element, number>();
  let inPosts = 0;
  for (const unit of sample) {
    const post = unit.topElement.closest(POST);
    if (!post) continue;
    inPosts++;
    posts.set(post, (posts.get(post) ?? 0) + unit.wordCount);
  }
  const total = sample.reduce((n, u) => n + u.wordCount, 0);
  const largest = Math.max(0, ...posts.values());
  const main = doc.querySelector("main, [role=main]");
  const inMain = main ? sample.filter((u) => main.contains(u.topElement)).reduce((n, u) => n + u.wordCount, 0) : 0;
  // A body of text: the paragraphs one element holds as its own children.
  const byParent = new Map<Element, number>();
  for (const unit of sample) {
    const parent = unit.topElement.parentElement;
    if (parent) byParent.set(parent, (byParent.get(parent) ?? 0) + unit.wordCount);
  }
  return {
    feedHost: hostIn(address.hostname, FEED_HOSTS),
    feedRole: doc.querySelector('[role="feed"]') !== null,
    forumPath: FORUM_ADDRESS.test(address.pathname + (address.search ?? "")) || (address.hostname === "news.ycombinator.com" && address.pathname === "/item"),
    declared: forumDeclared ? "forum" : articleDeclared ? "article" : null,
    posts: posts.size,
    inPosts,
    sample: sample.length,
    largestShare: total > 0 ? largest / total : 0,
    mainShare: total > 0 ? inMain / total : 0,
    forumSoftware: FORUM_SOFTWARE.test(generator),
    forumHost: FORUM_HOST.test(address.hostname),
    ogOnly: og === "article" && !articleTyped,
    ogProduct: og?.startsWith("product") === true,
    body: Math.max(0, ...byParent.values()),
  };
}

/** The kind the signals make, by `rule`: forum, feed, article or other (a document is the
 *  caller's to say). */
export function kindFrom(s: KindSignals, rule: KindRule = DEFAULT_KIND_RULE): PageKind {
  if (s.declared === "forum" || s.forumPath || s.forumSoftware || s.forumHost) return "forum";
  if (s.feedHost || s.feedRole) return "feed";
  // A visit kept before the body was measured is filed as it was then.
  const body = s.body ?? Infinity;
  // Declared in og:type alone, an article has a body of text, where anything was read.
  if (s.declared === "article" && (!s.ogOnly || s.sample === 0 || body >= rule.ogBody)) return "article";
  if (s.sample === 0) return "other";
  if (s.posts >= rule.manyVoices && s.inPosts * 2 > s.sample && s.largestShare < rule.onePost) return "feed";
  // A product page declares no article (an og:type product with no Article type).
  if (s.ogProduct && s.declared !== "article") return "other";
  // One author's text: most of the words read stand in one article, or in the page's main
  // with a body of text, or there is such a body.
  if (s.largestShare >= rule.articleShare) return "article";
  if (s.posts <= 1 && s.mainShare >= rule.articleShare && body >= rule.textBody) return "article";
  if (s.body !== undefined && s.body >= rule.textBody) return "article";
  return "other";
}

export function pageKindOf(doc: Document, address: { hostname: string; pathname: string; search?: string }, units: readonly Unit[]): PageKind {
  return kindFrom(kindSignals(doc, address, units));
}
