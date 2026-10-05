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
//              (schema.org QAPage or DiscussionForumPosting), or its address is shaped like
//              one (/questions/…, /comments/…, /thread/…, /t/…, Hacker News' item?id=).
//   feed     — posts by many voices, one after another: a page of a well-known feed (the
//              short list below), a page that says it is one (role="feed"), or one where
//              the paragraphs read stand in five or more separate posts, most of them in one.
//   article  — one author's text: the page declares it (og:type article, a schema.org
//              Article, NewsArticle, BlogPosting, Report or ScholarlyArticle), or most of
//              what is read stands in one <article> or <main>. Comments under an article
//              leave it an article.
//   other    — anything else: a shop, a search page, a mail client, a dashboard.
//
// The rule is asked again with each message, and costs a few selector queries and a look at
// the first paragraphs read. What it looked at is kept with the visit (KindSignals), so the
// rule can be checked on a labelled sample, or another tried, afterwards (kindFrom).
import type { Unit } from "../types";
import type { KindSignals, PageKind } from "./model";
import { DEFAULT_KIND_RULE, type KindRule } from "./lens";

/** Hosts whose pages are feeds whatever their markup says (with their subdomains). */
const FEED_HOSTS = [
  "x.com", "twitter.com", "facebook.com", "instagram.com", "threads.net", "threads.com", "bsky.app",
  "linkedin.com", "mastodon.social", "tumblr.com", "weibo.com", "weibo.cn", "reddit.com", "tiktok.com",
];

/** Paths a thread lives at on the common forum and Q&A software. */
const FORUM_PATH = /\/(?:questions?|comments|threads?|t|discussions?)\/[^/]/i;
const FORUM_TYPES = /"@type"\s*:\s*\[?\s*"(?:QAPage|DiscussionForumPosting)"/;
const ARTICLE_TYPES = /"@type"\s*:\s*\[?\s*"(?:Article|NewsArticle|BlogPosting|Report|ScholarlyArticle|TechArticle)"/;

/** A post of a feed or a thread, where the markup marks one (lib/dom/scope.ts, DECLARED). */
const POST = 'article, [role="article"], [aria-posinset], [role="listitem"]:not(li)';
/** How many of the paragraphs read are looked at: the first ones are the page's. */
const SAMPLE = 64;
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
export function kindSignals(doc: Document, address: { hostname: string; pathname: string }, units: readonly Unit[]): KindSignals {
  const forumDeclared = declares(doc, FORUM_TYPES, /schema\.org\/(?:QAPage|DiscussionForumPosting)\b/);
  const og = doc.querySelector('meta[property="og:type"]')?.getAttribute("content")?.trim().toLowerCase();
  const articleDeclared = og === "article" || declares(doc, ARTICLE_TYPES, /schema\.org\/(?:Article|NewsArticle|BlogPosting|Report|ScholarlyArticle|TechArticle)\b/);
  const sample = units.slice(0, SAMPLE);
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
  return {
    feedHost: hostIn(address.hostname, FEED_HOSTS),
    feedRole: doc.querySelector('[role="feed"]') !== null,
    forumPath: FORUM_PATH.test(address.pathname) || (address.hostname === "news.ycombinator.com" && address.pathname === "/item"),
    declared: forumDeclared ? "forum" : articleDeclared ? "article" : null,
    posts: posts.size,
    inPosts,
    sample: sample.length,
    largestShare: total > 0 ? largest / total : 0,
    mainShare: total > 0 ? inMain / total : 0,
  };
}

/** The kind the signals make, by `rule`: forum, feed, article or other (a document is the
 *  caller's to say). */
export function kindFrom(s: KindSignals, rule: KindRule = DEFAULT_KIND_RULE): PageKind {
  if (s.declared === "forum" || s.forumPath) return "forum";
  if (s.feedHost || s.feedRole) return "feed";
  if (s.declared === "article") return "article";
  if (s.sample === 0) return "other";
  if (s.posts >= rule.manyVoices && s.inPosts * 2 > s.sample) return "feed";
  // One author's text: most of the words read stand in one article, or in the page's main.
  if (s.largestShare >= rule.articleShare || (s.posts <= 1 && s.mainShare >= rule.articleShare)) return "article";
  return "other";
}

export function pageKindOf(doc: Document, address: { hostname: string; pathname: string }, units: readonly Unit[]): PageKind {
  return kindFrom(kindSignals(doc, address, units));
}
