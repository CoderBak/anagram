// test/web-bench/page.ts — the content script's first collection, run inside a saved page.
//
// bench.mjs bundles this with esbuild into an IIFE (`WB`) and evaluates it in each page.
// Nothing here re-implements the reader: the scope is lib/dom/mainContent.ts'
// findMainContent() with the same extractor the orchestrator hands it (the library the
// vendor chunk is built from, imported the same way scripts/vendor.mjs imports it), and the
// units are lib/dom/walker.ts' collectUnits() under that scope with the orchestrator's
// options for a first scan — merge short paragraphs on (the shipped default), no claimed
// nodes. The 75-word floor is the walker's own. What this adds is only what a benchmark
// needs to see: which units read as comments, where each unit sits, the text of the scope,
// the truth an HTML subtree stands for, and — through the product's own diagnostics
// (lib/diagnostics/silence.ts) — why a block of prose got no unit.
import ReadabilityLib from "@mozilla/readability";
import { collectUnits, inPageOrder } from "../../lib/dom/walker";
import { findMainContent, useReadability } from "../../lib/dom/mainContent";
import { surveyPage } from "../../lib/diagnostics/silence";
import type { Unit } from "../../lib/dom/text";

export interface MeasureOptions {
  /** The setting "Scope": the whole page (the shipped default) or its main content. */
  scope: "page" | "main";
  /** Which main-content extractor findMainContent() is given under "main". */
  extractor: "readability" | "none";
  /** The truth as an HTML subtree (WebMainBench) or document (Readability's expected output). */
  truthHtml?: string | null;
  /** Report each scored text node's XPath (Webis-WebSeg-20 names nodes that way). */
  xpaths?: boolean;
  /** Run the page diagnostics' survey of prose that got no unit, and why. */
  explain?: boolean;
}

function setExtractor(name: MeasureOptions["extractor"]): void {
  useReadability(name === "readability" ? { Readability: ReadabilityLib.Readability, isProbablyReaderable: ReadabilityLib.isProbablyReaderable } : null);
}

/** Id and class tokens a comment thread or a list of reviews is built from (WordPress,
 *  Disqus, Discourse, shop reviews, …). */
const COMMENT_RE = /(?:^|[\s_-])(?:comments?|commentlist|comment[-_]?list|comment[-_]?body|replies|reply|respond|responses|discussion|disqus|reviews?|review[-_]?(?:text|body|content)|reviewText)(?:[\s_-]|$)/i;

/** A unit inside a comment thread or a customer review — text the product reads on purpose
 *  and several datasets call boilerplate. */
function inComments(el: Element | null): boolean {
  for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
    // Attributes, not properties: a form's `id` property is its field named "id".
    const hay = `${cur.getAttribute("id") ?? ""} ${cur.getAttribute("class") ?? ""}`;
    if (COMMENT_RE.test(hay)) return true;
    const itemtype = cur.getAttribute("itemtype") ?? "";
    if (/Comment/.test(itemtype) || cur.getAttribute("itemprop") === "comment") return true;
  }
  return false;
}

/** `tag#id.class` for the nearest ancestors, for grouping where a unit came from. */
function whereOf(el: Element | null, depth = 5): string {
  const parts: string[] = [];
  for (let cur = el; cur && cur !== document.documentElement && parts.length < depth; cur = cur.parentElement) {
    const cls = (cur.getAttribute("class") ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 3);
    const id = cur.getAttribute("id");
    parts.unshift(cur.tagName.toLowerCase() + (id ? `#${id.slice(0, 40)}` : "") + cls.map((c) => `.${c.slice(0, 40)}`).join(""));
  }
  return parts.join(" > ");
}

/** The landmark a unit stands in, if any: what page chrome looks like when it leaks. */
function landmarkOf(el: Element | null): string {
  for (let cur = el; cur && cur !== document.body; cur = cur.parentElement) {
    const tag = cur.tagName.toLowerCase();
    if (["main", "article", "aside", "nav", "header", "footer", "form", "dialog"].includes(tag)) return tag;
    const role = cur.getAttribute("role");
    if (role && ["main", "article", "complementary", "navigation", "banner", "contentinfo", "dialog"].includes(role)) return `role=${role}`;
  }
  return "";
}

/** XPath as Webis-WebSeg-20 writes it: `/HTML[1]/BODY[1]/DIV[2]/text()[1]`. */
function xpathOf(node: Node): string {
  const steps: string[] = [];
  for (let cur: Node | null = node; cur && cur.nodeType !== Node.DOCUMENT_NODE; cur = cur.parentNode) {
    if (cur.nodeType === Node.TEXT_NODE) {
      let i = 1;
      for (let s = cur.previousSibling; s; s = s.previousSibling) if (s.nodeType === Node.TEXT_NODE) i++;
      steps.unshift(`text()[${i}]`);
    } else if (cur.nodeType === Node.ELEMENT_NODE) {
      const name = (cur as Element).tagName.toUpperCase();
      let i = 1;
      for (let s = (cur as Element).previousElementSibling; s; s = s.previousElementSibling) if (s.tagName.toUpperCase() === name) i++;
      steps.unshift(`${name}[${i}]`);
    } else return "";
  }
  return `/${steps.join("/")}`;
}

const BLOCK_TAGS = new Set([
  "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "BR", "DD", "DETAILS", "DIALOG", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION", "FIGURE",
  "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE", "SECTION",
  "SUMMARY", "TABLE", "TBODY", "TD", "TFOOT", "TH", "THEAD", "TR", "UL", "CAPTION",
]);

/** An HTML truth as text blocks: one block per block-level box, markup and scripts dropped,
 *  and code blocks too — a <pre> of code is main content the product never reads, and one
 *  source listing of forty thousand words would otherwise outweigh a hundred articles. */
function htmlBlocks(html: string): string[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("script, style, noscript, template, head, pre")) el.remove();
  const blocks: string[] = [];
  let cur = "";
  const flush = (): void => {
    const t = cur.replace(/\s+/g, " ").trim();
    if (t) blocks.push(t);
    cur = "";
  };
  const walk = (node: Node): void => {
    for (let c = node.firstChild; c; c = c.nextSibling) {
      if (c.nodeType === Node.TEXT_NODE) cur += c.textContent ?? "";
      else if (c.nodeType === Node.ELEMENT_NODE) {
        const block = BLOCK_TAGS.has((c as Element).tagName.toUpperCase());
        if (block) flush();
        walk(c);
        if (block) flush();
      }
    }
  };
  if (doc.body) walk(doc.body);
  flush();
  return blocks;
}

function describe(el: Element | null): string | null {
  if (!el) return null;
  return whereOf(el, 3);
}

export function measure(opts: MeasureOptions) {
  const began = performance.now();
  let root: Element | null = null;
  let textMassRoot: Element | null = null;
  let scopeMs = 0;
  let mutated = false;
  if (opts.scope === "main") {
    // The text-mass probe alone first, to tell afterwards whether the extractor answered.
    setExtractor("none");
    textMassRoot = findMainContent(document);
    setExtractor(opts.extractor);
    const snapshot = (): string => `${document.getElementsByTagName("*").length}:${document.documentElement.outerHTML.length}`;
    const before = snapshot();
    const t = performance.now();
    root = findMainContent(document);
    scopeMs = performance.now() - t;
    // The extractor must leave the live page as it found it.
    mutated = snapshot() !== before;
  }
  const base = root ?? document.body;
  const t = performance.now();
  const units: Unit[] = base ? inPageOrder(collectUnits(base, { mergeShorts: true })) : [];
  const collectMs = performance.now() - t;

  const out = {
    scope: {
      mode: opts.scope,
      extractor: opts.scope === "main" ? opts.extractor : null,
      found: !!root,
      byExtractor: !!root && root !== textMassRoot,
      mutated,
      root: describe(root),
      text: root ? (root as HTMLElement).innerText ?? root.textContent ?? "" : null,
    },
    units: units.map((u) => ({
      text: u.text,
      words: u.wordCount,
      parts: u.parts.length,
      comment: inComments(u.topElement),
      where: whereOf(u.topElement),
      landmark: landmarkOf(u.topElement),
      xpaths: opts.xpaths ? u.parts.map((p) => p.nodes.filter((n) => (n.textContent ?? "").trim()).map(xpathOf)) : undefined,
      nodeWords: opts.xpaths ? u.parts.map((p) => p.nodes.filter((n) => (n.textContent ?? "").trim()).map((n) => (n.textContent ?? "").trim().split(/\s+/).length)) : undefined,
      nodeTexts: opts.xpaths ? u.parts.map((p) => p.nodes.filter((n) => (n.textContent ?? "").trim()).map((n) => (n.textContent ?? "").replace(/\s+/g, " ").trim())) : undefined,
    })),
    truthBlocks: opts.truthHtml ? htmlBlocks(opts.truthHtml) : null,
    bodyText: document.body ? document.body.innerText ?? "" : "",
    silent: null as null | { path: string; words: number; reason: string; note: string | null; undrawn: boolean; text: string }[],
    timing: { scopeMs, collectMs, totalMs: 0 },
  };
  if (opts.explain) {
    const survey = surveyPage({ running: false, max: 60 });
    out.silent = survey.silent.map((s) => ({
      path: whereOf(s.el), words: s.words, reason: s.reason, note: s.note, undrawn: s.undrawn,
      text: ((s.el as HTMLElement).innerText ?? s.el.textContent ?? "").slice(0, 4000),
    }));
  }
  out.timing.totalMs = performance.now() - began;
  return out;
}
