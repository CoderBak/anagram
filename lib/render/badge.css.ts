// lib/render/badge.css.ts — constructable stylesheet for the badge shadow root.
//
// The badge host is an INLINE-FLOW element inserted after the paragraph's last
// text run. Typography rules:
// - The host inherits the surrounding font-size (set AFTER `all: initial`), so the
//   chip scales with the text it annotates (clamped 9–12px) and sits on the SAME
//   BASELINE as the words before it — no vertical fudge factors.
// - `margin-inline-start` keeps the gap on the correct side in RTL text.
// - The chip reads the bare number ("38%"); what the number means is explained in
//   the hover card's footer and on the onboarding page, not repeated on every line.
// - Visual language follows Basecoat's Vega pack (the extension pages): neutral
//   greys, hairline borders, 6–8 px radii, one flat shadow, no gradients, no blur,
//   verdict colour only on the dot / text / marks.
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

export const BADGE_CSS: string = `
:host {
  all: initial;
  font-size: inherit; /* after all:initial — chip scales with the annotated text */
  display: inline-block !important;
  position: relative !important;
  vertical-align: middle;
  margin-inline-start: 6px;
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

@keyframes anagram-badge-in {
  from { opacity: 0; transform: translateY(1px); }
  to   { opacity: 1; transform: translateY(0); }
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.42em;
  box-sizing: border-box;
  font-size: clamp(9px, 0.66em, 12px);
  line-height: 1;
  padding: 0.3em 0.6em 0.3em 0.5em;
  border-radius: 6px;
  border: 1px solid #e5e5e5;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: #525252;
  white-space: nowrap;
  direction: ltr; /* the number must not bidi-flip inside RTL paragraphs */
  cursor: default;
  animation: anagram-badge-in 180ms ease-out both;
  transition: background-color 130ms ease, border-color 130ms ease;
}

:host(:hover) .pill {
  background: #f5f5f5;
  border-color: #d4d4d4;
}

.dot {
  width: 0.56em;
  height: 0.56em;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--dot, #9aa3ad);
  box-shadow: 0 0 0 0.18em var(--ring, rgba(154, 163, 173, 0.16));
}

.num {
  display: inline-block;
  font-variant-numeric: tabular-nums;
}

.pill.band-human   { --dot: #1a7f37; --ring: rgba(26, 127, 55, 0.16);   color: #116a37; }
.pill.band-light   { --dot: #d4a017; --ring: rgba(212, 160, 23, 0.20);  color: #7a5b00; }
.pill.band-heavy   { --dot: #e8590c; --ring: rgba(232, 89, 12, 0.18);   color: #a13d00; }
.pill.band-ai      { --dot: #dc2626; --ring: rgba(220, 38, 38, 0.18);   color: #b42318; }
.pill.band-unknown { --dot: #a3a3a3; --ring: rgba(163, 163, 163, 0.16); color: #525252; }
.pill.band-unsupported { --dot: #a3a3a3; --ring: rgba(163, 163, 163, 0.16); color: #737373; font-weight: 500; }

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
  position: absolute;
  inset: auto;
  top: 0;
  left: 0;
  margin: 0;
  overflow: visible;
  height: auto;
  box-sizing: border-box;
  width: max-content;
  min-width: 232px;
  max-width: min(300px, 78vw);
  padding: 11px 13px 10px;
  border-radius: 8px;
  border: 1px solid #e5e5e5;
  background: #ffffff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  font: 400 11px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #252525;
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
  margin-bottom: 6px;
}
.card .verdict { font-weight: 700; font-size: 12px; }
.card .verdict.band-human   { color: #116a37; }
.card .verdict.band-light   { color: #7a5b00; }
.card .verdict.band-heavy   { color: #a13d00; }
.card .verdict.band-ai      { color: #b42318; }
.card .verdict.band-unknown { color: #57606a; }
.card .verdict.band-unsupported { color: #737373; }
.card .big { font-weight: 700; font-size: 12px; font-variant-numeric: tabular-nums; color: #252525; }

.card .row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.card .row .k { color: #737373; }
.card .row .v { font-variant-numeric: tabular-nums; color: #252525; }
/* "Scored in 8 windows" carries up to eight numbers: the label keeps its line and the
   numbers wrap under each other, flush right like every other value. */
.card .row.wins .k { flex: none; }
.card .row.wins .v { text-align: right; }

.card .actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
/* Basecoat "outline" button: hairline border, plain surface, muted hover. */
.card .act {
  font: 500 10.5px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #252525;
  border: 1px solid #e5e5e5;
  background: #ffffff;
  border-radius: 6px;
  padding: 5px 10px;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
.card .act:hover { background: #f5f5f5; }
.card .act.done { color: #116a37; border-color: rgba(26, 127, 55, 0.4); background: rgba(26, 127, 55, 0.08); }

.card .foot {
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px solid #f0f0f0;
  color: #737373;
  font-size: 10px;
  line-height: 1.4;
}

/* ---- dark surfaces ------------------------------------------------------------ */

:host(.pg-dark) .pill {
  border-color: rgba(255, 255, 255, 0.12);
  background: #171717;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4);
  color: #a3a3a3;
}
:host(.pg-dark:hover) .pill { background: #262626; border-color: rgba(255, 255, 255, 0.2); }
:host(.pg-dark) .pill.band-human   { color: #4ecb71; }
:host(.pg-dark) .pill.band-light   { color: #e6c84c; }
:host(.pg-dark) .pill.band-heavy   { color: #ff9a57; }
:host(.pg-dark) .pill.band-ai      { color: #ff7b81; }
:host(.pg-dark) .pill.band-unknown { color: #b9c0c8; }
:host(.pg-dark) .pill.band-unsupported { color: #a3a3a3; }
:host(.pg-dark) .card .verdict.band-unsupported { color: #a3a3a3; }

:host(.pg-dark) .card {
  border-color: rgba(255, 255, 255, 0.10);
  background: #171717;
  color: #fafafa;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
}
:host(.pg-dark) .card .big { color: #fafafa; }
:host(.pg-dark) .card .row .k { color: #a3a3a3; }
:host(.pg-dark) .card .row .v { color: #fafafa; }
:host(.pg-dark) .card .verdict.band-human { color: #4ecb71; }
:host(.pg-dark) .card .verdict.band-light { color: #e6c84c; }
:host(.pg-dark) .card .verdict.band-heavy { color: #ff9a57; }
:host(.pg-dark) .card .verdict.band-ai    { color: #ff7b81; }
:host(.pg-dark) .card .act { color: #fafafa; border-color: rgba(255, 255, 255, 0.15); background: rgba(255, 255, 255, 0.06); box-shadow: none; }
:host(.pg-dark) .card .act:hover { background: rgba(255, 255, 255, 0.12); }
:host(.pg-dark) .card .foot { border-top-color: rgba(255, 255, 255, 0.08); color: #8a8a8a; }

/* ---- forced colors (Windows High Contrast) ------------------------------------ */
/* Let the system palette flatten surfaces, but keep the verdict dot semantic and
   guarantee a visible chip boundary. */
@media (forced-colors: active) {
  .pill, .card { border: 1px solid ButtonText; }
  .dot { forced-color-adjust: none; }
}

/* Jump-target pulse: a ring in the chip's own verdict colour, nothing foreign. */
@keyframes anagram-flash {
  0%, 100% { box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05); }
  25%, 65% { box-shadow: 0 0 0 5px color-mix(in oklab, var(--dot, #a3a3a3) 35%, transparent); }
}
.pill.pg-flash { animation: anagram-flash 800ms ease-in-out 2; }

@media (prefers-reduced-motion: reduce) {
  .pill { animation: none; transition: none; }
  .pill.pending .dot { animation: none; opacity: 0.6; }
  .pill.pg-flash { animation: none; outline: 2px solid var(--dot, #a3a3a3); outline-offset: 2px; }
  .card { transition: none; }
}
` + DIST_CSS;
