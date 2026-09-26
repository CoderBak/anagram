// lib/dom/mainContent.ts — main-content region detection ("precision scope").
//
// Defuddle (https://github.com/kepano/defuddle, MIT, Copyright (c) 2025 Steph Ango) decides
// WHAT the article is. We only need to know WHERE it lives in the live DOM, because
// rendering anchors into real nodes and Defuddle returns cleaned-up HTML (node identity is
// lost). So: take a handful of sentences from its extracted content, locate each one in the
// live document by descending to the deepest element that contains it, and return their
// lowest common ancestor — the live article container.
//
// Pages where Defuddle finds nothing to locate fall back to a text-mass probe: semantic
// candidates (<main>, [role=main], <article>) first, then a dominant-path descent from
// <body>. Body itself means "no dominant region" → null, and callers keep whole-page
// behaviour. The walk's own style- and boilerplate-level filters still apply INSIDE
// whatever scope is returned.
//
// Defuddle itself is NOT bundled into the content script: it is a vendor chunk loaded on
// demand (lib/lazy.ts) and handed in through useDefuddle() by the orchestrator when the
// scope setting is "main". Until then (or if the load fails) the text-mass probe answers
// alone.
import type { DefuddleModule } from "../lazy";

let _defuddle: DefuddleModule | null = null;

/** Provide Defuddle (lazy vendor chunk, or a test double). */
export function useDefuddle(mod: DefuddleModule | null): void {
  _defuddle = mod;
}

const SKIP_MASS_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD"]);

/** A child must hold at least this share of its parent's text to keep descending. */
const DOMINANCE = 0.56;
/** Minimum absolute text mass for a detected region to be trusted. */
const MIN_REGION_CHARS = 500;
/** Minimum share of the page's text a semantic candidate must hold. */
const MIN_SEMANTIC_SHARE = 0.2;
const MAX_DESCENT = 14;

/** Snippets sampled from the extracted article to locate it in the live DOM. Taken from
 *  the MIDDLE of a block: opening sentences get duplicated in teasers and link lists. */
const MAX_NEEDLES = 10;
const NEEDLE_CHARS = 48;
const MIN_NEEDLE_SOURCE_CHARS = 120;

/**
 * Find the page's main content container, or null when none dominates.
 * Costs one document clone + Defuddle pass (or one linear text-mass pass) — call per scan
 * session, not per mutation.
 */
export function findMainContent(doc: Document = document): Element | null {
  if (!doc.body) return null;
  return fromDefuddle(doc) ?? fromTextMass(doc);
}

// ---- Defuddle-guided -------------------------------------------------------------------

function fromDefuddle(doc: Document): Element | null {
  const D = _defuddle;
  if (!D) return null;
  try {
    // parse() only, the synchronous pipeline: parseAsync() is what reaches third-party
    // APIs, and it is never called. And on a CLONE: parse() edits the document it is given
    // before it copies it — it promotes <noscript> images and fills lazy <img>
    // placeholders, which on the live page would insert images and start their downloads.
    const article = new D.Defuddle(doc.cloneNode(true) as Document, { useAsync: false }).parse();
    if (!article.wordCount || !article.content) return null;
    const needles = sampleNeedles(article.content);
    if (needles.length < 2) return null;
    const hits: Element[] = [];
    for (const re of needles) {
      const el = deepestContaining(doc.body, re);
      if (el) hits.push(el);
    }
    // Most samples must be locatable, or the extraction rewrote too much to trust the map.
    if (hits.length < Math.max(2, Math.ceil(needles.length / 2))) return null;
    const lca = lowestCommonAncestor(hits);
    if (!lca || lca === doc.body || lca === doc.documentElement) return null;
    return lca;
  } catch {
    return null;
  }
}

/**
 * Up to MAX_NEEDLES evenly spaced block-level snippets of the extracted article, each
 * a whitespace-tolerant regex so it matches the live text however it is wrapped.
 */
function sampleNeedles(articleHtml: string): RegExp[] {
  const parsed = new DOMParser().parseFromString(articleHtml, "text/html");
  const blocks: string[] = [];
  for (const el of parsed.querySelectorAll("p, li, blockquote, td, pre, h1, h2, h3, h4, dd")) {
    const t = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    if (t.length >= MIN_NEEDLE_SOURCE_CHARS) blocks.push(t);
  }
  if (blocks.length === 0) return [];
  const step = Math.max(1, Math.floor(blocks.length / MAX_NEEDLES));
  const out: RegExp[] = [];
  for (let i = 0; i < blocks.length && out.length < MAX_NEEDLES; i += step) {
    const b = blocks[i];
    const start = Math.floor((b.length - NEEDLE_CHARS) / 2);
    const words = b.slice(start, start + NEEDLE_CHARS).split(" ");
    if (words.length > 2) {
      words.shift(); // both ends may be cut words
      words.pop();
    }
    const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    out.push(new RegExp(escaped));
  }
  return out;
}

/**
 * The deepest element under `root` whose text contains the needle. Null when the
 * needle is absent OR ambiguous (matches more than one sibling at some level — a
 * sentence echoed in a teaser or a duplicated block cannot locate the article).
 */
function deepestContaining(root: Element, re: RegExp): Element | null {
  let el: Element = root;
  if (!re.test(el.textContent ?? "")) return null;
  for (let depth = 0; depth < 64; depth++) {
    let next: Element | null = null;
    for (const c of el.children) {
      if (SKIP_MASS_TAGS.has(c.nodeName.toUpperCase())) continue;
      if (re.test(c.textContent ?? "")) {
        if (next) return null; // ambiguous
        next = c;
      }
    }
    if (!next) return el;
    el = next;
  }
  return el;
}

function lowestCommonAncestor(els: Element[]): Element | null {
  if (els.length === 0) return null;
  const chain = new Set<Element>();
  for (let n: Element | null = els[0]; n; n = n.parentElement) chain.add(n);
  let lca: Element | null = els[0];
  for (const el of els.slice(1)) {
    let n: Element | null = el;
    while (n && !chain.has(n)) n = n.parentElement;
    if (!n) return null;
    // Trim the chain to the new common prefix: everything below n is no longer shared.
    for (let m: Element | null = lca; m && m !== n; m = m.parentElement) chain.delete(m);
    lca = n;
  }
  return lca;
}

// ---- text-mass fallback ----------------------------------------------------------------

/** Text mass per element, skipping machine-text subtrees. One pass, memoized. */
function buildMassMap(root: Element): Map<Element, number> {
  const mass = new Map<Element, number>();

  function measure(el: Element): number {
    if (SKIP_MASS_TAGS.has(el.nodeName.toUpperCase())) {
      mass.set(el, 0);
      return 0;
    }
    let total = 0;
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === Node.TEXT_NODE) {
        const t = n.textContent;
        if (t) total += t.trim().length;
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        total += measure(n as Element);
      }
    }
    mass.set(el, total);
    return total;
  }

  measure(root);
  return mass;
}

function fromTextMass(doc: Document): Element | null {
  const body = doc.body;
  const mass = buildMassMap(body);
  const bodyMass = mass.get(body) ?? 0;
  if (bodyMass < MIN_REGION_CHARS) return null;

  // 1) semantic candidates, largest text mass wins.
  const candidates = [...doc.querySelectorAll("main, [role=main], article")].filter(
    (el) => body.contains(el),
  );
  let best: Element | null = null;
  let bestMass = 0;
  for (const el of candidates) {
    const m = mass.get(el) ?? 0;
    if (m > bestMass) {
      best = el;
      bestMass = m;
    }
  }
  if (best && bestMass >= MIN_REGION_CHARS && bestMass / bodyMass >= MIN_SEMANTIC_SHARE) {
    return best;
  }

  // 2) dominant-path descent from body.
  let cur: Element = body;
  for (let depth = 0; depth < MAX_DESCENT; depth++) {
    const curMass = mass.get(cur) ?? 0;
    if (curMass < MIN_REGION_CHARS) break;
    let dominant: Element | null = null;
    for (const child of cur.children) {
      const m = mass.get(child) ?? 0;
      if (m / curMass >= DOMINANCE) {
        dominant = child;
        break;
      }
    }
    if (!dominant) break;
    cur = dominant;
  }

  if (cur === body) return null;
  if ((mass.get(cur) ?? 0) < MIN_REGION_CHARS) return null;
  return cur;
}
