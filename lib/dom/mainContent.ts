// lib/dom/mainContent.ts — main-content region detection ("precision scope").
//
// trafilatura's core move is extracting the main content region and ignoring the
// rest; resiliparse and Readability score candidate containers by text mass. We
// need the LIVE element (rendering anchors into it), so this ports the idea as a
// two-step probe over the real DOM:
//
//   1. semantic candidates — <main>, [role=main], <article>: pick the one with
//      the most machine-visible text, if it holds a sane share of the page;
//   2. dominant-path descent — from <body>, repeatedly step into the child that
//      carries the clear majority of the remaining text mass. Where dominance
//      ends (content splits across siblings), that element is the content root.
//
// Text mass is textContent length minus script/style/template/noscript subtrees,
// computed in one bottom-up pass (O(page)); the walk's own style- and
// boilerplate-level filters still apply INSIDE the returned scope.
//
// Returns null when the page has no dominant region (portals, feeds, apps) —
// callers must fall back to whole-page analysis.

const SKIP_MASS_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD"]);

/** A child must hold at least this share of its parent's text to keep descending. */
const DOMINANCE = 0.56;
/** Minimum absolute text mass for a detected region to be trusted. */
const MIN_REGION_CHARS = 500;
/** Minimum share of the page's text a semantic candidate must hold. */
const MIN_SEMANTIC_SHARE = 0.2;
const MAX_DESCENT = 14;

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

/**
 * Find the page's main content container, or null when none dominates.
 * Costs one linear DOM pass — call per scan session, not per mutation.
 */
export function findMainContent(doc: Document = document): Element | null {
  const body = doc.body;
  if (!body) return null;
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

  // Body itself means "no dominant region" — analyzing "main" would equal "page",
  // so report the honest null and let the caller keep whole-page behavior.
  if (cur === body) return null;
  if ((mass.get(cur) ?? 0) < MIN_REGION_CHARS) return null;
  return cur;
}
