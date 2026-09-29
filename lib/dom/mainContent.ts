// lib/dom/mainContent.ts — where a page's main content lives, for the diagnostics report.
//
// A text-mass probe: semantic candidates (<main>, [role=main], <article>) first, then a
// dominant-path descent from <body>. Body itself means "no dominant region" → null.

const SKIP_MASS_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD"]);

/** A child must hold at least this share of its parent's text to keep descending. */
const DOMINANCE = 0.56;
/** Minimum absolute text mass for a detected region to be trusted. */
const MIN_REGION_CHARS = 500;
/** Minimum share of the page's text a semantic candidate must hold. */
const MIN_SEMANTIC_SHARE = 0.2;
const MAX_DESCENT = 14;

/** Find the page's main content container, or null when none dominates: one linear text-mass pass. */
export function findMainContent(doc: Document = document): Element | null {
  if (!doc.body) return null;
  return fromTextMass(doc);
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
