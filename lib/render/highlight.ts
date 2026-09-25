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
// v4: marks are per STRETCH. A paragraph longer than the model reads in one pass is read
// in overlapping passes, and each stretch between two pass edges is marked in the colour
// of the passes that read it combined (lib/capture/windows.ts) — so a paragraph that turns
// from human to AI halfway shows where. Ranges then start and end inside text nodes
// (lib/dom/locate.ts); still nothing in the page is touched. Text no pass covers (past the
// pass cap) and text only passes the language gate refused read get no mark: a mark claims
// that the model read what it covers.
//
// v5 — ONE SCALE. Every read stretch is underlined in the colour of its own score, on the
// one-hue ramp of lib/render/scale.ts: human text carries the palest, quietest line and
// AI-generated text the darkest, so a mostly human page stays calm without anything being
// left unmarked. The line is solid, never wavy (the spell-checker's "this is wrong"), and
// the same weight everywhere, so a score on either side of a word's edge does not jump.
// A paragraph whose verdict is uncertain (scale.ts isUncertain) is underlined DASHED.
// Underlines are all on or all off (setHighlightsVisible); there is no flagged-only mode.
//
// Detail on demand: while a unit is ACTIVE — its chip hovered, its card pinned, or a
// jump from the panel or the next/previous-flagged command just landed on it — its
// stretches also carry a tint of their colour, so the reader sees exactly which text was
// read and how each window scored. Its ranges move into a second set of highlight names
// for as long as it lasts (::highlight() rules are global per tree scope, so one unit
// cannot be styled apart from the others in any other way), and move back when the
// pointer leaves. Nothing animates: the highlight pseudo-element takes no transition, so
// there is no motion to hold back under prefers-reduced-motion.
//
// ::highlight() rules cannot take a colour per range, so the ramp is sampled in
// SCALE_STEPS + 1 named steps, each solid or dashed, at rest or active.
import type { Unit } from "../types";
import { MARK_ATTR } from "../types";
import type { UnitVerdict, WindowVerdict } from "../capture/windows";
import { locateSpans } from "../dom/locate";
import { band, isNoVerdict } from "./band";
import { isUncertain, scaleColor, scaleStep, SCALE_STEPS } from "./scale";
import { isDarkPage } from "./theme";

/** One painted look: a step of the ramp, solid or dashed. */
interface Mark {
  step: number;
  dashed: boolean;
}

function markName(m: Mark, active: boolean): string {
  return `anagram-${active ? "a" : "s"}${String(m.step).padStart(2, "0")}${m.dashed ? "-u" : ""}`;
}

/** A rule under the words in the step's colour — never wavy, never anything that moves
 *  the text. */
function underline(color: string, dashed: boolean): string[] {
  return [
    "text-decoration-line: underline",
    `text-decoration-style: ${dashed ? "dashed" : "solid"}`,
    `text-decoration-color: ${color}`,
    "text-decoration-thickness: 1.5px",
    "text-underline-offset: 3px",
    // Descenders cut a page's own underlines; ours would look like the page's own if it
    // did not, and a skipped mark is a mark a reader has to hunt for.
    "text-decoration-skip-ink: none",
  ];
}

function buildCss(dark: boolean): string {
  const rules: string[] = [];
  const rule = (name: string, decl: string[]) => rules.push(`::highlight(${name}) { ${decl.join("; ")}; }`);
  for (let step = 0; step <= SCALE_STEPS; step++) {
    const score = step / SCALE_STEPS;
    const line = scaleColor(score, dark);
    const tint = scaleColor(score, dark, dark ? 0.24 : 0.18);
    for (const dashed of [false, true]) {
      rule(markName({ step, dashed }, false), underline(line, dashed));
      rule(markName({ step, dashed }, true), [`background-color: ${tint}`, ...underline(line, dashed)]);
    }
  }
  return `@media screen {\n${rules.join("\n")}\n}`;
}

function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight !== "undefined";
}

const _highlights = new Map<string, Highlight>();
/** The Highlight a look's ranges live in — one set at rest, one for the active unit. */
function markHighlight(m: Mark, active: boolean): Highlight | null {
  if (!highlightsSupported()) return null;
  const name = markName(m, active);
  let h = _highlights.get(name);
  if (!h) {
    h = new Highlight();
    _highlights.set(name, h);
  }
  // Chrome empties the HighlightRegistry when a page reopens its document
  // (document.open()/write()); a cached Highlight must be re-registered to paint.
  if (CSS.highlights.get(name) !== h) CSS.highlights.set(name, h);
  return h;
}

// Ranges added per unit id, with the look they are painted in, so we can clear them.
const _byUnit = new Map<string, Array<{ mark: Mark; range: Range }>>();
/** The one unit the reader is on — hovered chip, pinned card, or a jump's target. */
let _activeUnit: string | null = null;

let _stylesInjected = false;
let _styleEl: HTMLStyleElement | null = null;
/** Shared constructable sheet adopted by shadow-root surfaces (Docs overlay). */
let _shadowSheet: CSSStyleSheet | null = null;
let _visible = true;

function applyCss(): void {
  const css = buildCss(isDarkPage());
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
    _shadowSheet.replaceSync(buildCss(isDarkPage()));
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

/**
 * The unit the reader is on, or null. Its stretches carry their tint for as long as it
 * lasts — the "detail on demand" half of the marks. Only one unit is
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
    markHighlight(e.mark, !active)?.delete(e.range);
    markHighlight(e.mark, active)?.add(e.range);
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

/** Stretches as runs of one step: neighbours that touch and land on the same step of the
 *  scale are one span, so a long paragraph is as few ranges as its colours need. */
function stepRuns(stretches: readonly WindowVerdict[]): Array<{ start: number; end: number; step: number }> {
  const runs: Array<{ start: number; end: number; step: number }> = [];
  for (const st of stretches) {
    const step = scaleStep(st.result.score);
    const last = runs[runs.length - 1];
    if (last && last.end === st.start && last.step === step) last.end = st.end;
    else runs.push({ start: st.start, end: st.end, step });
  }
  return runs;
}

/**
 * Register what was read, stretch by stretch, each in the colour of its own score;
 * "unavailable" and "unsupported" get no mark, and neither does text no scored pass read.
 * Detection cannot attribute below what the model read in one pass, so that is the grain
 * of the marks: the whole unit for nearly every paragraph (one pass, marked uniformly in
 * the chip's colour, no offsets resolved), and stretch by stretch between pass edges for a
 * long one. The dash follows the UNIT's verdict: a paragraph the card calls uncertain is
 * uncertain wherever the reader looks at it.
 *
 * When a stretch cannot be found in the page any more (the DOM changed between the scan
 * and the verdict), the unit falls back to whole parts in the AGGREGATE colour rather
 * than showing nothing; the mutation observer is about to retire it anyway.
 */
export function setHighlight(unit: Unit, verdict: UnitVerdict): void {
  if (!highlightsSupported()) return;

  clearHighlight(unit.id);

  if (isNoVerdict(band(verdict.result))) return; // no verdict → no mark
  const dashed = isUncertain(verdict.result);
  const look = (score: number): Mark => ({ step: scaleStep(score), dashed });

  const marks: Array<{ mark: Mark; ranges: Range[] }> = [];
  const onePass = verdict.windows.length === 1 && verdict.unreadChars === 0;
  // The stretches the verdict judged, neighbours on one step of the scale drawn as one.
  const runs = stepRuns(verdict.stretches);
  // With a locator even a ONE-PASS unit is placed span by span: on a surface whose text is
  // not what its nodes say, the whole-parts shortcut would cover more than was read.
  const located = _locator
    ? _locator(unit, onePass ? [{ start: 0, end: unit.text.length }] : runs)
    : onePass
      ? null
      : locateSpans(unit.parts, unit.text, runs);
  if (located && _locator && onePass) {
    marks.push({ mark: look(verdict.result.score), ranges: located[0] ?? [] });
  } else if (located) {
    runs.forEach((run, i) => marks.push({ mark: { step: run.step, dashed }, ranges: located[i] }));
  } else {
    marks.push({ mark: look(verdict.result.score), ranges: wholeParts(unit) });
  }

  // A unit re-rendered while the pointer is still on its chip (a verdict landing on a
  // hovered paragraph) keeps its marks where the reader can see them.
  const active = _activeUnit === unit.id;
  const entries: Array<{ mark: Mark; range: Range }> = [];
  for (const { mark, ranges } of marks) {
    const highlight = markHighlight(mark, active);
    if (!highlight) continue;
    for (const range of ranges) {
      highlight.add(range);
      entries.push({ mark, range });
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
    _highlights.get(markName(e.mark, false))?.delete(e.range);
    _highlights.get(markName(e.mark, true))?.delete(e.range);
  }
  _byUnit.delete(id);
}
