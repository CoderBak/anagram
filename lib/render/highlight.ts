// lib/render/highlight.ts — in-place marking via the CSS Custom Highlight API.
//
// ZERO DOM mutation: we build `Range`s over the unit's text and add them to a
// named `Highlight` registered with `CSS.highlights.set`, painted by the
// `::highlight()` rules injected once by `registerHighlightStyles()`.
//
// v2: a unit may span SEVERAL visual paragraphs (merged short runs), so we paint
// ONE RANGE PER PART — never a single range across parts, which would sweep up
// interstitial content (code blocks, images) that is not part of the unit.
//
// v3 additions:
// - markStyle variants (underline + tint / underline only / tint only), rebuilt
//   live when the setting changes;
// - shadow-root adoption: ::highlight() rules only paint text whose tree scope
//   has the rule, so surfaces we render INTO a shadow root (the Docs overlay)
//   adopt a shared constructable sheet carrying the same rules;
// - print suppression: verdict marks are reading aids, not document content —
//   all rules live under `@media screen`.
import type { Unit } from "../types";
import { MARK_ATTR } from "../types";
import type { ScoreResult } from "../contract";
import { band, type Band } from "./band";
import { isDarkPage } from "./theme";

const HIGHLIGHT_NAME: Record<Band, string> = {
  human: "anagram-human",
  light: "anagram-light",
  heavy: "anagram-heavy",
  ai: "anagram-ai",
  unknown: "anagram-unknown",
};

/** Bands that get a mark ("unknown" is painted by nothing). */
type PaintBand = Exclude<Band, "unknown">;
const PAINT_BANDS: readonly PaintBand[] = ["human", "light", "heavy", "ai"];

export type MarkStyle = "both" | "underline" | "tint";

interface BandPaint {
  bg: string;
  lineColor: string;
  lineStyle: "solid" | "wavy";
  offset: string;
}

// Per-band tint + underline (matches the badge palette). ::highlight() rules are
// GLOBAL per tree scope, so the palette can only switch per page — the page-level
// background verdict picks light or dark.
const LIGHT: Record<PaintBand, BandPaint> = {
  human: { bg: "rgba(26, 127, 55, 0.07)", lineColor: "rgba(26, 127, 55, 0.5)", lineStyle: "solid", offset: "3px" },
  light: { bg: "rgba(212, 160, 23, 0.12)", lineColor: "rgba(212, 160, 23, 0.75)", lineStyle: "solid", offset: "3px" },
  heavy: { bg: "rgba(232, 89, 12, 0.15)", lineColor: "rgba(232, 89, 12, 0.85)", lineStyle: "wavy", offset: "2px" },
  ai: { bg: "rgba(229, 72, 77, 0.16)", lineColor: "rgba(229, 72, 77, 0.9)", lineStyle: "wavy", offset: "2px" },
};

// Dark-page variant: lighter decoration colors, slightly stronger tints so the
// marks read against dark surfaces without glowing.
const DARK: Record<PaintBand, BandPaint> = {
  human: { bg: "rgba(78, 203, 113, 0.10)", lineColor: "rgba(78, 203, 113, 0.55)", lineStyle: "solid", offset: "3px" },
  light: { bg: "rgba(230, 200, 76, 0.13)", lineColor: "rgba(230, 200, 76, 0.75)", lineStyle: "solid", offset: "3px" },
  heavy: { bg: "rgba(255, 154, 87, 0.15)", lineColor: "rgba(255, 154, 87, 0.85)", lineStyle: "wavy", offset: "2px" },
  ai: { bg: "rgba(255, 123, 129, 0.16)", lineColor: "rgba(255, 123, 129, 0.9)", lineStyle: "wavy", offset: "2px" },
};

function buildCss(dark: boolean, style: MarkStyle): string {
  const pal = dark ? DARK : LIGHT;
  const rules: string[] = [];
  for (const b of PAINT_BANDS) {
    const p = pal[b];
    const decl: string[] = [];
    if (style !== "underline") decl.push(`background-color: ${p.bg}`);
    if (style !== "tint") {
      decl.push(
        "text-decoration-line: underline",
        `text-decoration-style: ${p.lineStyle}`,
        `text-decoration-color: ${p.lineColor}`,
        `text-underline-offset: ${p.offset}`,
      );
    }
    rules.push(`::highlight(${HIGHLIGHT_NAME[b]}) { ${decl.join("; ")}; }`);
  }
  return `@media screen {\n${rules.join("\n")}\n}`;
}

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
/** Shared constructable sheet adopted by shadow-root surfaces (Docs overlay). */
let _shadowSheet: CSSStyleSheet | null = null;
let _markStyle: MarkStyle = "both";
let _visible = true;

function applyCss(): void {
  const css = buildCss(isDarkPage(), _markStyle);
  if (_styleEl) _styleEl.textContent = css;
  if (_shadowSheet) _shadowSheet.replaceSync(css);
}

/** Inject the `::highlight()` pseudo rules once. */
export function registerHighlightStyles(): void {
  if (_stylesInjected) return;
  if (!highlightsSupported()) return;
  _stylesInjected = true;
  const style = document.createElement("style");
  style.setAttribute(MARK_ATTR, "style");
  (document.head ?? document.documentElement).appendChild(style);
  _styleEl = style;
  applyCss();
}

/**
 * Make highlights paint inside a shadow root we render into (the Docs overlay).
 * ::highlight() rules do not cross tree scopes, so each such root adopts a shared
 * sheet carrying the same rules. Idempotent per root.
 */
export function adoptHighlightStyles(root: ShadowRoot): void {
  if (!highlightsSupported()) return;
  if (!_shadowSheet) {
    _shadowSheet = new CSSStyleSheet();
    _shadowSheet.replaceSync(buildCss(isDarkPage(), _markStyle));
    _shadowSheet.disabled = !_visible;
  }
  if (!root.adoptedStyleSheets.includes(_shadowSheet)) {
    root.adoptedStyleSheets = [...root.adoptedStyleSheets, _shadowSheet];
  }
}

/** Instantly show/hide ALL highlights by toggling the stylesheets (keeps ranges). */
export function setHighlightsVisible(visible: boolean): void {
  _visible = visible;
  if (_styleEl) _styleEl.disabled = !visible;
  if (_shadowSheet) _shadowSheet.disabled = !visible;
}

/** Switch between underline / tint / both (live from the settings watch). */
export function setMarkStyle(style: MarkStyle): void {
  if (style === _markStyle) return;
  _markStyle = style;
  applyCss();
}

/** Re-evaluate the page background and swap the palette (site theme toggles). */
export function refreshHighlightTheme(): void {
  applyCss();
}

/**
 * Underline the unit in its verdict colour — green (human), yellow (lightly
 * edited), orange (heavily edited), red (AI-generated). Detection cannot attribute
 * below the unit level, so the whole unit is marked uniformly (matching its
 * badge); "unavailable" gets no mark.
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
