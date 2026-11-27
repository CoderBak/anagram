// lib/render/badge.css.ts — constructable stylesheet for the badge shadow root.
//
// The badge host is an INLINE-FLOW element inserted after the paragraph's last
// text run. Typography rules:
// - The host inherits the surrounding font-size (set AFTER `all: initial`), so the
//   chip scales with the text it annotates (clamped 9–12px) and sits on the SAME
//   BASELINE as the words before it — no vertical fudge factors.
// - `margin-inline-start` keeps the gap on the correct side in RTL text.
// - The chip reads the bare number (".38" on a 0-1 scale — see lib/render/score.ts);
//   what the number means is explained in the hover card's footer and on the onboarding
//   page, not repeated on every line.
// - The chip is quiet: a neutral pill, no border and no shadow, the number in grey, and the
//   verdict's word only as a small dot in its colour (lib/render/scale.ts). The page's text
//   leads; the colour is on the underlines of the paragraphs that are flagged.
// - A chip can render in a PENDING state ("analyzing") the moment its unit is
//   dispatched, then morphs in place into the verdict — the host is reused, so
//   the line lays out once, not twice.
// - The card is placed by Floating UI (badge.ts): above the chip, flipped below
//   near the viewport top, shifted to stay on screen; the caret is aimed at the
//   chip by the arrow middleware.
//
// Cascade note: page rules from the outer tree beat ordinary :host declarations,
// but shadow-context !important beats page !important — so the layout-critical
// host props are declared !important here AND mirrored as inline styles.
import { DIST_CSS } from "./dist";
import { bandColorRules } from "./scale";

/** A jump-target chip pulses this long, this many times; its card stays open as long
 *  (badge.ts flash). */
export const FLASH_PULSE_MS = 800;
export const FLASH_PULSES = 2;

export const BADGE_CSS: string = `
:host {
  all: initial;
  font-size: inherit; /* after all:initial — chip scales with the annotated text */
  writing-mode: inherit;
  display: inline-block !important;
  position: relative !important;
  vertical-align: middle;
  margin-inline-start: 4px;
  line-height: normal;
  /* NO z-index on purpose. The chip is part of the paragraph's flow and must be
     covered by whatever covers that paragraph — a comment modal, a lightbox, a
     cookie wall. A huge z-index made every chip on the page bleed THROUGH such
     overlays (Zhihu's comment sheet showed the article's chips floating over it).
     contain:layout already makes the host its own stacking context, so it paints
     as a z-index:0 positioned element: above its paragraph's own inline content,
     below any overlay the site stacks on top. Our own chrome that DOES need to sit
     above everything (the ball, the hover card) uses the top layer instead. */
  user-select: none;
  -webkit-user-select: none;
  contain: layout style;
}

/* Instant show/hide toggle (badge.ts setVisible) — keeps the badge in the DOM. */
:host(.pg-hidden) { display: none !important; }

@media print {
  :host { display: none !important; }
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.3em;
  box-sizing: border-box;
  font-size: clamp(9px, 0.66em, 12px);
  line-height: 1;
  padding: 0.18em 0.44em;
  border-radius: 999px;
  border: 1px solid rgb(0 0 0 / 0.06);
  background: #f4f4f5;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  font-weight: 500;
  letter-spacing: 0.01em;
  color: #52525b;
  white-space: nowrap;
  direction: ltr; /* the number must not bidi-flip inside RTL paragraphs */
  cursor: default;
  /* No entrance and no colour transition: each runs frames at the display's rate, and on a
     page that keeps changing every frame costs what the marks and the chips cost to draw — a
     feed's chips fading in and turning their colour took a third of what Anagram cost it. */
}

/* A chip where the whole pill has no room (between two columns of a PDF): its dot alone,
   the number in the card. */
:host([data-compact]) .pill { gap: 0; padding: 0.2em; border-color: transparent; background: transparent; }
:host([data-compact]) .num { display: none; }
:host([data-compact]) .dot { width: 0.8em; height: 0.8em; }

:host(:hover) .pill { background: #e9e9ec; border-color: rgb(0 0 0 / 0.1); }

.dot {
  width: 0.6em;
  height: 0.6em;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--dot, #a1a1aa);
}

.num {
  display: inline-block;
  font-variant-numeric: tabular-nums;
}

/* The word's colour (.b0 human … .b3 AI-generated, set per chip in badge.ts) is the dot's;
   the pill and its number stay neutral whatever the verdict. */
${bandColorRules(".pill.scored", ":host(.pg-dark)", "--c")}
.pill.scored .dot { background: var(--c); }
.pill.band-unknown { --dot: #a1a1aa; }
.pill.band-unsupported { --dot: #a1a1aa; color: #71717a; }

/* ---- pending ("analyzing") state --------------------------------------------- */
/* Shown the moment a unit's batch actually goes to the backend; morphs in place
   into the verdict. The dot breathes; the number slot holds a fixed-width
   ellipsis so the morph barely moves the line. */

@keyframes anagram-breathe {
  0%, 100% { opacity: 0.35; transform: scale(0.82); }
  50%      { opacity: 1;    transform: scale(1); }
}
.pill.pending .dot { animation: anagram-breathe 1.1s ease-in-out infinite; }
.pill.pending .num { min-width: 1.2em; text-align: center; letter-spacing: 0.14em; }

/* ---- hover detail card ------------------------------------------------------- */
/* A manual popover in the TOP LAYER (immune to ancestor overflow/clip/z-index);
   coordinates come from Floating UI (badge.ts positionCard); .below marks the
   flipped orientation for the caret and hover bridge. Fixed 11px type — card
   readability should not scale with page text. The UA popover styles (inset:0,
   margin:auto, overflow:auto, border, padding, colors) are all overridden here. */

.card {
  writing-mode: horizontal-tb;
  position: absolute;
  inset: auto;
  top: 0;
  left: 0;
  margin: 0;
  overflow: visible;
  height: auto;
  box-sizing: border-box;
  width: max-content;
  min-width: min(214px, calc(100vw - 16px));
  max-width: min(272px, calc(100vw - 16px));
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgb(0 0 0 / 0.09);
  background: #ffffff;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.10), 0 1px 3px rgb(0 0 0 / 0.05);
  font: 400 11.5px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  color: #18181b;
  text-align: left;
  white-space: normal;
  visibility: hidden;
  opacity: 0;
  transition: opacity 130ms ease, visibility 0s linear 190ms;
  pointer-events: none;
  z-index: 1;
}
.card[popover] { position: fixed; }
/* Shown: hover (.showing / :popover-open) or pinned (.open). */
.card.showing,
.card.open,
.card:popover-open {
  visibility: visible;
  opacity: 1;
  pointer-events: auto;
  transition-delay: 60ms, 60ms;
}
/* Popover open/close toggles display — fade in from the starting style. */
.card[popover] {
  transition: opacity 130ms ease, display 130ms allow-discrete, overlay 130ms allow-discrete;
}
@starting-style {
  .card:popover-open { opacity: 0; }
}

/* Invisible bridge across the chip↔card gap so the pointer can travel into the
   card without the hover (and the card) collapsing mid-way. */
.card::before {
  content: "";
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  height: 12px;
}
.card.below::before { top: auto; bottom: 100%; }

/* Caret pointing at the chip — its left offset is set by the arrow middleware. */
.caret {
  position: absolute;
  left: 0;
  bottom: -5px;
  width: 9px;
  height: 9px;
  transform: rotate(45deg);
  background: inherit;
  border: inherit;
  border-top: none;
  border-left: none;
  border-radius: 0 0 2px 0;
}
.card.overlap .caret { display: none; }
.card.below .caret {
  bottom: auto;
  top: -5px;
  border: inherit;
  border-bottom: none;
  border-right: none;
  border-radius: 2px 0 0 0;
}
.card .head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 4px;
}
.card .verdict { font-weight: 600; font-size: 12.5px; letter-spacing: -0.01em; color: #18181b; }
.card .verdict.band-unknown { color: #52525b; }
.card .verdict.band-unsupported { color: #63636c; }
.card .big { font-weight: 600; font-size: 12.5px; font-variant-numeric: tabular-nums; color: #18181b; }

.card .row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.card .row .k { color: #63636c; }
.card .row .v { font-variant-numeric: tabular-nums; color: #18181b; }
/* "Scored in 8 windows" carries up to eight numbers: the label keeps its line and the
   numbers wrap under each other, flush right like every other value. */
.card .row.wins .k { flex: none; }
.card .row.wins .v { text-align: right; }
/* A verdict on a text under the model's training minimum says so, on a line of its own. */
.card .short, .card .unsure { color: #63636c; font-style: italic; margin-bottom: 4px; }

.card .actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid #f0f0f2;
}
.card .actions .row { gap: 5px; }
.card .act {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  font: 500 10.5px/1 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  color: #52525b;
  border: 0;
  background: transparent;
  border-radius: 5px;
  min-width: 26px;
  min-height: 26px;
  padding: 4px;
  cursor: pointer;
}
.card .act svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
.card .act .check, .card .act.done .sheets { display: none; }
.card .act.done .check { display: inline; }
.card .act:hover { background: #efeff1; color: #18181b; }

.card .foot {
  margin-top: 7px;
  padding-top: 5px;
  border-top: 1px solid #f0f0f2;
  color: #63636c;
  font-size: 10.5px;
  line-height: 1.4;
}
/* The card's only line while it waits for a verdict. */
.card .foot.alone { margin: 0; padding: 0; border: 0; }

/* ---- dark surfaces ------------------------------------------------------------ */

:host(.pg-dark) .pill { background: #26282d; border-color: rgb(255 255 255 / 0.09); color: #d4d6dc; }
:host(.pg-dark:hover) .pill { background: #34373e; border-color: rgb(255 255 255 / 0.14); }
:host(.pg-dark[data-compact]) .pill { border-color: transparent; background: transparent; }
:host(.pg-dark) .pill.band-unsupported { color: #a1a4ad; }
:host(.pg-dark) .card .verdict.band-unsupported { color: #a1a4ad; }

:host(.pg-dark) .card {
  border-color: rgb(255 255 255 / 0.11);
  background: #191a1d;
  color: #f1f2f4;
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.55), 0 1px 3px rgb(0 0 0 / 0.3);
}
:host(.pg-dark) .card .big { color: #f1f2f4; }
:host(.pg-dark) .card .row .k, :host(.pg-dark) .card .short, :host(.pg-dark) .card .unsure { color: #a1a4ad; }
:host(.pg-dark) .card .row .v { color: #f1f2f4; }
:host(.pg-dark) .card .verdict { color: #f1f2f4; }
:host(.pg-dark) .card .verdict.band-unknown { color: #b9c0c8; }
:host(.pg-dark) .card .actions { border-top-color: rgb(255 255 255 / 0.08); }
:host(.pg-dark) .card .act { color: #a1a4ad; }
:host(.pg-dark) .card .act:hover { background: rgb(255 255 255 / 0.1); color: #f1f2f4; }
:host(.pg-dark) .card .foot { border-top-color: rgb(255 255 255 / 0.08); color: #9a9da6; }

/* ---- forced colors (Windows High Contrast) ------------------------------------ */
/* Let the system palette flatten surfaces, but keep the verdict dot semantic and
   guarantee a visible chip boundary. */
@media (forced-colors: active) {
  .pill, .card { border: 1px solid ButtonText; }
  .dot { forced-color-adjust: none; }
}

/* Jump-target pulse: a ring in the chip's own verdict colour, nothing foreign. */
@keyframes anagram-flash {
  0%, 100% { box-shadow: none; }
  25%, 65% { box-shadow: 0 0 0 5px color-mix(in oklab, var(--c, var(--dot, #a3a3a3)) 35%, transparent); }
}
.pill.pg-flash { animation: anagram-flash ${FLASH_PULSE_MS}ms ease-in-out ${FLASH_PULSES}; }

@media (prefers-reduced-motion: reduce) {
  .pill.pending .dot { animation: none; opacity: 0.6; }
  .pill.pg-flash { animation: none; outline: 2px solid var(--c, var(--dot, #a3a3a3)); outline-offset: 2px; }
  /* [popover] as well: the .card[popover] rule above outranks a bare .card, so the plain
     rule turned nothing off for the card that is actually shown — every hover card still
     faded in for a reader who had asked for no motion. (No backticks in here: this whole
     sheet is a template literal.) */
  .card, .card[popover] { transition: none; }
}
` + DIST_CSS;
