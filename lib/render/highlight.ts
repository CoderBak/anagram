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
// - shadow-root adoption: ::highlight() rules only paint text whose tree scope
//   has the rule, so surfaces we render INTO a shadow root (the Docs overlay)
//   adopt a shared constructable sheet carrying the same rules;
// - print suppression: verdict marks are reading aids, not document content —
//   all rules live under `@media screen`.
//
// v4: marks are per WINDOW. A paragraph longer than the model reads in one pass is
// scored in consecutive windows, and each window's text is marked in its OWN band — so a
// paragraph that turns from human to AI halfway shows where. Ranges then start and end
// inside text nodes (lib/dom/locate.ts); still nothing in the page is touched. Text no
// window covers (past the window cap) and windows the language gate refused get no mark:
// a mark claims that the model read what it covers.
//
// v5 — QUIET BY DEFAULT. Every read unit used to carry its band's tint and underline all
// the time, and the two flagged bands carried a WAVY one: that is the spell-checker's
// "this is wrong", and a tint changes how the page's own words look, which is the one
// thing Anagram must never do. Nothing is wavy any more, and at rest the page is nearly
// untouched — only the windows in the two flagged bands carry a thin SOLID underline, no
// tint, and human and lightly-edited text carries nothing at all (its chip has already
// said it was read). Heavily-edited and AI-generated are told apart by WEIGHT as well as
// hue (1 px against 2 px), so a reader who sees no colour still sees two marks.
//
// Detail on demand: while a unit is ACTIVE — its chip hovered, its card pinned, or a
// jump from the panel or the next/previous-flagged command just landed on it — every
// window of THAT unit shows its band's tint and underline, so the reader sees exactly
// which text was read and how each window scored. Its ranges move into a second set of
// highlight names for as long as it lasts (::highlight() rules are global per tree
// scope, so one unit cannot be styled apart from the others in any other way), and move
// back when the pointer leaves. Nothing animates: the highlight pseudo-element takes no
// transition, so there is no motion to hold back under prefers-reduced-motion.
//
// The `markStyle` setting picks between that and the old always-on marking:
// "quiet" (default) is the above, "always" marks every unit all the time, solid.
import type { Unit } from "../types";
import { MARK_ATTR } from "../types";
import type { UnitVerdict } from "../capture/windows";
import { isScoredWindow } from "../capture/windows";
import { locateSpans } from "../dom/locate";
import { band, isFlaggedBand, isNoVerdict, type Band } from "./band";
import { isDarkPage } from "./theme";

const HIGHLIGHT_NAME: Record<Band, string> = {
  human: "anagram-human",
  light: "anagram-light",
  heavy: "anagram-heavy",
  ai: "anagram-ai",
  unknown: "anagram-unknown",
  unsupported: "anagram-unsupported",
};

/** The same bands for the unit the reader is looking at right now (see setActiveUnit). */
const ACTIVE_NAME: Record<Band, string> = {
  human: "anagram-active-human",
  light: "anagram-active-light",
  heavy: "anagram-active-heavy",
  ai: "anagram-active-ai",
  unknown: "anagram-active-unknown",
  unsupported: "anagram-active-unsupported",
};

/** Bands that get a mark ("unknown" is painted by nothing). */
type PaintBand = Exclude<Band, "unknown" | "unsupported">;
const PAINT_BANDS: readonly PaintBand[] = ["human", "light", "heavy", "ai"];

/** "quiet" = flagged windows only, underlined, until the unit is looked at; "always" =
 *  every unit marked all the time. The stored setting is normalized onto these two in
 *  lib/settings/settings.ts, which spells the union out again rather than import it
 *  (see the note there). */
export type MarkStyle = "quiet" | "always";

interface BandPaint {
  bg: string;
  lineColor: string;
  /** What tells "heavily edited" from "AI-generated" without relying on hue. */
  thickness: string;
  offset: string;
}

// Per-band tint + underline (matches the badge palette). ::highlight() rules are
// GLOBAL per tree scope, so the palette can only switch per page — the page-level
// background verdict picks light or dark.
const LIGHT: Record<PaintBand, BandPaint> = {
  human: { bg: "rgba(26, 127, 55, 0.07)", lineColor: "rgba(26, 127, 55, 0.5)", thickness: "1px", offset: "3px" },
  light: { bg: "rgba(212, 160, 23, 0.12)", lineColor: "rgba(212, 160, 23, 0.75)", thickness: "1px", offset: "3px" },
  heavy: { bg: "rgba(232, 89, 12, 0.15)", lineColor: "rgba(232, 89, 12, 0.85)", thickness: "1px", offset: "3px" },
  ai: { bg: "rgba(229, 72, 77, 0.16)", lineColor: "rgba(229, 72, 77, 0.9)", thickness: "2px", offset: "3px" },
};

// Dark-page variant: lighter decoration colors, slightly stronger tints so the
// marks read against dark surfaces without glowing.
const DARK: Record<PaintBand, BandPaint> = {
  human: { bg: "rgba(78, 203, 113, 0.10)", lineColor: "rgba(78, 203, 113, 0.55)", thickness: "1px", offset: "3px" },
  light: { bg: "rgba(230, 200, 76, 0.13)", lineColor: "rgba(230, 200, 76, 0.75)", thickness: "1px", offset: "3px" },
  heavy: { bg: "rgba(255, 154, 87, 0.15)", lineColor: "rgba(255, 154, 87, 0.85)", thickness: "1px", offset: "3px" },
  ai: { bg: "rgba(255, 123, 129, 0.16)", lineColor: "rgba(255, 123, 129, 0.9)", thickness: "2px", offset: "3px" },
};

/** A solid rule under the words, in the band's colour — never wavy, which reads as a
 *  spelling mistake, and never anything that moves the text. */
function underline(p: BandPaint): string[] {
  return [
    "text-decoration-line: underline",
    "text-decoration-style: solid",
    `text-decoration-color: ${p.lineColor}`,
    `text-decoration-thickness: ${p.thickness}`,
    `text-underline-offset: ${p.offset}`,
    // Descenders cut a page's own underlines; ours would look like the page's own if it
    // did not, and a skipped mark is a mark a reader has to hunt for.
    "text-decoration-skip-ink: none",
  ];
}

function buildCss(dark: boolean, style: MarkStyle): string {
  const pal = dark ? DARK : LIGHT;
  const rules: string[] = [];
  const rule = (name: string, decl: string[]) => rules.push(`::highlight(${name}) { ${decl.join("; ")}; }`);
  for (const b of PAINT_BANDS) {
    const p = pal[b];
    // At rest, quietly: nothing under human or lightly-edited text — the chip has said
    // the paragraph was read, and the page keeps the look its author gave it.
    if (style === "always") rule(HIGHLIGHT_NAME[b], [`background-color: ${p.bg}`, ...underline(p)]);
    else if (isFlaggedBand(b)) rule(HIGHLIGHT_NAME[b], underline(p));
    // Active: every window of the one unit being looked at, whatever it scored, so the
    // extent of what was read — and where it changed band — is visible for that moment.
    rule(ACTIVE_NAME[b], [`background-color: ${p.bg}`, ...underline(p)]);
  }
  return `@media screen {\n${rules.join("\n")}\n}`;
}

function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

const _bandHighlights = new Map<string, Highlight>();
/** The Highlight a band's ranges live in — one set at rest, one for the active unit. */
function bandHighlight(b: Band, active: boolean): Highlight | null {
  if (!highlightsSupported()) return null;
  const name = active ? ACTIVE_NAME[b] : HIGHLIGHT_NAME[b];
  let h = _bandHighlights.get(name);
  if (!h) {
    h = new Highlight();
    _bandHighlights.set(name, h);
  }
  // Chrome empties the HighlightRegistry when a page reopens its document
  // (document.open()/write()); a cached Highlight must be re-registered to paint.
  if (CSS.highlights.get(name) !== h) CSS.highlights.set(name, h);
  return h;
}

// Ranges added per unit id, with the band they live in, so we can clear them.
const _byUnit = new Map<string, Array<{ band: Band; range: Range }>>();
/** The one unit the reader is on — hovered chip, pinned card, or a jump's target. */
let _activeUnit: string | null = null;

let _stylesInjected = false;
let _styleEl: HTMLStyleElement | null = null;
/** Shared constructable sheet adopted by shadow-root surfaces (Docs overlay). */
let _shadowSheet: CSSStyleSheet | null = null;
let _markStyle: MarkStyle = "quiet";
let _visible = true;

function applyCss(): void {
  const css = buildCss(isDarkPage(), _markStyle);
  if (_styleEl) _styleEl.textContent = css;
  if (_shadowSheet) _shadowSheet.replaceSync(css);
}

/** Inject the `::highlight()` pseudo rules once (again if the document was replaced). */
export function registerHighlightStyles(): void {
  if (_stylesInjected && _styleEl?.isConnected) return;
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

/** Switch between the quiet marks and always-on ones (live from the settings watch). */
export function setMarkStyle(style: MarkStyle): void {
  if (style === _markStyle) return;
  _markStyle = style;
  applyCss();
}

/**
 * The unit the reader is on, or null. Its windows carry their tint and underline for as
 * long as it lasts — the "detail on demand" half of the quiet marks. Only one unit is
 * ever active: showing a second one's extent while the pointer sits on the first would
 * say the two were read together.
 */
export function setActiveUnit(id: string | null): void {
  if (id === _activeUnit) return;
  const previous = _activeUnit;
  _activeUnit = id;
  if (previous) restate(previous, false);
  if (id) restate(id, true);
}

/** Let go of `id` — but only if it is still the active one, so a unit whose flash has
 *  run out cannot take the marks off the chip the pointer has moved on to. */
export function clearActiveUnit(id: string): void {
  if (_activeUnit === id) setActiveUnit(null);
}

/** Move one unit's ranges between the resting highlights and the active ones. */
function restate(id: string, active: boolean): void {
  const entries = _byUnit.get(id);
  if (!entries) return;
  for (const e of entries) {
    bandHighlight(e.band, !active)?.delete(e.range);
    bandHighlight(e.band, active)?.add(e.range);
  }
}

/** Re-evaluate the page background and swap the palette (site theme toggles). */
export function refreshHighlightTheme(): void {
  applyCss();
}

/**
 * How a surface that is NOT the page's own DOM finds a stretch of a unit's text on
 * screen. The PDF reader installs one: there a paragraph was reconstructed from glyphs at
 * coordinates, so locateSpans — which re-derives the text from the nodes and insists it
 * matches — can never answer, and "everything between the first node and the last" would
 * sweep up whatever the reconstruction left out (a running head, the other column). The
 * reader knows which run of which page every character came from and hands back ranges
 * over exactly those glyphs. Null from it falls back to the whole unit, as always.
 */
export type RangeLocator = (
  unit: Unit,
  spans: ReadonlyArray<{ start: number; end: number }>,
) => Range[][] | null;

let _locator: RangeLocator | null = null;

/** Install (or, with null, remove) the locator above. One per document. */
export function setRangeLocator(locator: RangeLocator | null): void {
  _locator = locator;
}

/** One range per part, first text node to last — the whole unit, as it was scanned. */
function wholeParts(unit: Unit): Range[] {
  const ranges: Range[] = [];
  for (const part of unit.parts) {
    const first = part.nodes[0];
    const last = part.nodes[part.nodes.length - 1];
    if (!first || !last) continue;
    try {
      const range = new Range();
      range.setStart(first, 0);
      range.setEnd(last, last.textContent?.length ?? 0);
      ranges.push(range);
    } catch {
      /* node detached mid-flight — skip this part */
    }
  }
  return ranges;
}

/**
 * Register what was read, window by window, in the colour of its verdict — green
 * (human), yellow (lightly edited), orange (heavily edited), red (AI-generated);
 * "unavailable" and "unsupported" get no mark. Every band's ranges are registered
 * whatever the style: which of them the reader SEES is buildCss's business, and a range
 * that is not painted at rest is the one the active state has to hand the moment the
 * pointer arrives. Detection cannot attribute below what the model read in
 * one pass, so that is the grain of the marks: the whole unit for nearly every
 * paragraph (one window, marked uniformly in the chip's band, no offsets resolved), and
 * window by window for a long one.
 *
 * When a window cannot be found in the page any more (the DOM changed between the scan
 * and the verdict), the unit falls back to whole parts in the AGGREGATE band rather
 * than showing nothing; the mutation observer is about to retire it anyway.
 */
export function setHighlight(unit: Unit, verdict: UnitVerdict): void {
  if (!highlightsSupported()) return;

  clearHighlight(unit.id);

  const b = band(verdict.result);
  if (isNoVerdict(b)) return; // no verdict → no mark

  const marks: Array<{ band: Band; ranges: Range[] }> = [];
  const onePass = verdict.windows.length === 1 && verdict.unreadChars === 0;
  // With a locator even a ONE-PASS unit is placed span by span: on a surface whose text is
  // not what its nodes say, the whole-parts shortcut would cover more than was read.
  const located = _locator
    ? _locator(unit, onePass ? [{ start: 0, end: unit.text.length }] : verdict.windows)
    : onePass
      ? null
      : locateSpans(unit.parts, unit.text, verdict.windows);
  if (located && _locator && onePass) {
    marks.push({ band: b, ranges: located[0] ?? [] });
  } else if (located) {
    verdict.windows.forEach((w, i) => {
      if (isScoredWindow(w)) marks.push({ band: band(w.result), ranges: located[i] });
    });
  } else {
    marks.push({ band: b, ranges: wholeParts(unit) });
  }

  // A unit re-rendered while the pointer is still on its chip (a verdict landing on a
  // hovered paragraph) keeps its marks where the reader can see them.
  const active = _activeUnit === unit.id;
  const entries: Array<{ band: Band; range: Range }> = [];
  for (const mark of marks) {
    const highlight = bandHighlight(mark.band, active);
    if (!highlight) continue;
    for (const range of mark.ranges) {
      highlight.add(range);
      entries.push({ band: mark.band, range });
    }
  }
  if (entries.length > 0) _byUnit.set(unit.id, entries);
}

/** Remove all highlight ranges associated with a unit id. */
export function clearHighlight(id: string): void {
  if (_activeUnit === id) _activeUnit = null;
  const entries = _byUnit.get(id);
  if (!entries) return;
  for (const e of entries) {
    // Which of the two sets a range sits in depends on whether the unit was being looked
    // at when it went; asking both is cheaper than remembering.
    _bandHighlights.get(HIGHLIGHT_NAME[e.band])?.delete(e.range);
    _bandHighlights.get(ACTIVE_NAME[e.band])?.delete(e.range);
  }
  _byUnit.delete(id);
}
