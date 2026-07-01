// lib/render/highlight.ts — in-place marking via the CSS Custom Highlight API.
//
// ZERO DOM mutation: we build `Range`s over the unit's text and add them to a
// named `Highlight` registered with `CSS.highlights.set`, painted by the
// `::highlight()` rules injected once by `registerHighlightStyles()`.
//
// v2: a unit may span SEVERAL visual paragraphs (merged short runs), so we paint
// ONE RANGE PER PART — never a single range across parts, which would sweep up
// interstitial content (code blocks, images) that is not part of the unit.
import type { Unit } from "../types";
import { MARK_ATTR } from "../types";
import type { ScoreResult } from "../contract";
import { band, type Band } from "./band";

const HIGHLIGHT_NAME: Record<Band, string> = {
  human: "pangram-human",
  mixed: "pangram-mixed",
  ai: "pangram-ai",
  unknown: "pangram-unknown",
};

// Per-band tint + underline (matches the badge palette).
const HIGHLIGHT_CSS = `
::highlight(pangram-human)   {
  background-color: rgba(26, 127, 55, 0.07);
  text-decoration-line: underline;
  text-decoration-style: solid;
  text-decoration-color: rgba(26, 127, 55, 0.5);
  text-underline-offset: 3px;
}
::highlight(pangram-mixed)   {
  background-color: rgba(217, 158, 0, 0.18);
  text-decoration-line: underline;
  text-decoration-style: wavy;
  text-decoration-color: rgba(217, 158, 0, 0.85);
  text-underline-offset: 2px;
}
::highlight(pangram-ai)      {
  background-color: rgba(229, 72, 77, 0.16);
  text-decoration-line: underline;
  text-decoration-style: wavy;
  text-decoration-color: rgba(229, 72, 77, 0.9);
  text-underline-offset: 2px;
}
::highlight(pangram-unknown) { background-color: rgba(95, 99, 104, 0.10); }
`;

function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

const _bandHighlights = new Map<Band, Highlight>();
function bandHighlight(b: Band): Highlight | null {
  if (!highlightsSupported()) return null;
  let h = _bandHighlights.get(b);
  if (!h) {
    h = new Highlight();
    CSS.highlights.set(HIGHLIGHT_NAME[b], h);
    _bandHighlights.set(b, h);
  }
  return h;
}

// Ranges added per unit id, with the band they live in, so we can clear them.
const _byUnit = new Map<string, Array<{ band: Band; range: Range }>>();

let _stylesInjected = false;
let _styleEl: HTMLStyleElement | null = null;

/** Inject the `::highlight()` pseudo rules once. */
export function registerHighlightStyles(): void {
  if (_stylesInjected) return;
  if (!highlightsSupported()) return;
  _stylesInjected = true;
  const style = document.createElement("style");
  style.setAttribute(MARK_ATTR, "style");
  style.textContent = HIGHLIGHT_CSS;
  (document.head ?? document.documentElement).appendChild(style);
  _styleEl = style;
}

/** Instantly show/hide ALL highlights by toggling the stylesheet (keeps ranges). */
export function setHighlightsVisible(visible: boolean): void {
  if (_styleEl) _styleEl.disabled = !visible;
}

/**
 * Underline the unit in its verdict colour — green (human), amber (AI-Assisted),
 * red (AI). Detection cannot attribute below the unit level, so the whole unit is
 * marked uniformly (matching its badge); "insufficient" gets no mark.
 */
export function setHighlight(unit: Unit, result: ScoreResult): void {
  if (!highlightsSupported()) return;

  clearHighlight(unit.id);

  const b = band(result);
  if (b === "unknown") return;

  const highlight = bandHighlight(b);
  if (!highlight) return;

  const entries: Array<{ band: Band; range: Range }> = [];
  for (const part of unit.parts) {
    const first = part.nodes[0];
    const last = part.nodes[part.nodes.length - 1];
    if (!first || !last) continue;
    try {
      const range = new Range();
      range.setStart(first, 0);
      range.setEnd(last, last.textContent?.length ?? 0);
      highlight.add(range);
      entries.push({ band: b, range });
    } catch {
      /* node detached mid-flight — skip this part */
    }
  }
  if (entries.length > 0) _byUnit.set(unit.id, entries);
}

/** Remove all highlight ranges associated with a unit id. */
export function clearHighlight(id: string): void {
  const entries = _byUnit.get(id);
  if (!entries) return;
  for (const e of entries) {
    const h = _bandHighlights.get(e.band);
    if (h) h.delete(e.range);
  }
  _byUnit.delete(id);
}
