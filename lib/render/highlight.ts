// lib/render/highlight.ts — optional in-place marking via the CSS Custom Highlight API.
//
// ZERO DOM mutation: we never insert or alter nodes. Instead we build `Range`s over the
// unit's flagged sentences and add them to a named `Highlight` registered with
// `CSS.highlights.set`. One named highlight per confidence band, painted by the
// `::highlight()` rules injected once by `registerHighlightStyles()`.
//
// This whole layer is gated by `settings.showHighlights` (default off) at the call site.
import type { Unit } from "../types";
import type { ScoreResult } from "../contract";
import { band, type Band } from "./band";

const HIGHLIGHT_NAME: Record<Band, string> = {
  human: "pangram-human",
  mixed: "pangram-mixed",
  ai: "pangram-ai",
  unknown: "pangram-unknown",
};

// Per-band background tint for the painted ranges (matches the badge band palette).
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

// Feature-detect the CSS Custom Highlight API once.
function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

// Lazily create + register one Highlight per band.
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

// Track each range added per unit id WITH the band it lives in (a mixed paragraph can hold
// both green human ranges and amber AI ranges), so we can clear them all later.
const _byUnit = new Map<string, Array<{ band: Band; range: Range }>>();

let _stylesInjected = false;
let _styleEl: HTMLStyleElement | null = null;

/** Inject the `::highlight()` pseudo rules once (one per confidence band). */
export function registerHighlightStyles(): void {
  if (_stylesInjected) return;
  if (!highlightsSupported()) return;
  _stylesInjected = true;
  const style = document.createElement("style");
  style.setAttribute("data-pangram-highlight", "");
  style.textContent = HIGHLIGHT_CSS;
  (document.head ?? document.documentElement).appendChild(style);
  _styleEl = style;
}

/** Instantly show/hide ALL highlights by toggling the injected stylesheet (keeps ranges). */
export function setHighlightsVisible(visible: boolean): void {
  if (_styleEl) _styleEl.disabled = !visible;
}

/**
 * Underline the WHOLE paragraph in its verdict colour — green (human), amber (AI-Assisted),
 * red (AI). Detection is paragraph-level: Pangram is "accurate to ~75 words" and cannot
 * attribute human-vs-AI at the sentence level, so we mark the block uniformly (matching the
 * badge) rather than colouring sentences individually. "Insufficient" gets no mark.
 */
export function setHighlight(unit: Unit, result: ScoreResult): void {
  if (!highlightsSupported()) return;

  // Re-applying for the same unit: drop the previous range first.
  clearHighlight(unit.id);

  const b = band(result);
  if (b === "unknown") return; // insufficient evidence → no underline

  const highlight = bandHighlight(b);
  if (!highlight) return;

  // One range over the entire paragraph (spans all its text nodes, incl. links/citations).
  const offsets = buildOffsetMap(unit.nodes);
  const range = makeRange(offsets, 0, offsets.text.length);
  if (!range) return;

  highlight.add(range);
  _byUnit.set(unit.id, [{ band: b, range }]);
}

/** Remove all highlight ranges associated with a unit id (across whichever bands they used). */
export function clearHighlight(id: string): void {
  const entries = _byUnit.get(id);
  if (!entries) return;
  for (const e of entries) {
    const h = _bandHighlights.get(e.band);
    if (h) h.delete(e.range);
  }
  _byUnit.delete(id);
}

// ---- offset mapping helpers (no DOM mutation) --------------------------------------

interface OffsetMap {
  text: string;
  nodes: Text[];
  /** Cumulative start offset of each node within the joined text. */
  starts: number[];
}

function buildOffsetMap(nodes: Text[]): OffsetMap {
  const starts: number[] = [];
  let text = "";
  for (const n of nodes) {
    starts.push(text.length);
    text += n.textContent ?? "";
  }
  return { text, nodes, starts };
}

/** Resolve a global character offset to a (textNode, nodeOffset) pair. */
function locate(map: OffsetMap, offset: number): { node: Text; offset: number } | null {
  const { nodes, starts } = map;
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (offset >= starts[i]) {
      const local = offset - starts[i];
      const len = nodes[i].textContent?.length ?? 0;
      return { node: nodes[i], offset: Math.min(local, len) };
    }
  }
  return null;
}

function makeRange(map: OffsetMap, start: number, end: number): Range | null {
  const s = locate(map, start);
  const e = locate(map, end);
  if (!s || !e) return null;
  try {
    const range = new Range();
    range.setStart(s.node, s.offset);
    range.setEnd(e.node, e.offset);
    return range;
  } catch {
    return null;
  }
}
