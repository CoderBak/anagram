// lib/render/badge.css.ts — constructable stylesheet for the badge shadow root.
//
// The badge host is an INLINE-FLOW element inserted after the paragraph's last
// text run. Typography rules:
// - The host inherits the surrounding font-size (set AFTER `all: initial`), so the
//   chip scales with the text it annotates (clamped 9–12px) and sits on the SAME
//   BASELINE as the words before it — no vertical fudge factors.
// - `margin-inline-start` keeps the gap on the correct side in RTL text.
// - The chip reads "<pct>% AI" — the number plus its unit tag, self-explanatory
//   without hovering; the full calibrated readout stays in the hover card.
// - A chip can render in a PENDING state ("analyzing") the moment its unit is
//   dispatched, then morphs in place into the verdict — the host is reused, so
//   the line lays out once, not twice.
// - The card is edge-aware: badge.ts flips it below the chip near the viewport
//   top and pins it left/right near the horizontal edges; a caret points at the
//   chip in the centered orientations.
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
  z-index: 2147483646;
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
  padding: 0.34em 0.72em 0.34em 0.56em;
  border-radius: 9999px;
  border: 1px solid rgba(15, 23, 42, 0.09);
  background: rgba(255, 255, 255, 0.92);
  -webkit-backdrop-filter: saturate(1.4) blur(8px);
  backdrop-filter: saturate(1.4) blur(8px);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.10), 0 1px 1px rgba(15, 23, 42, 0.04);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-weight: 640;
  letter-spacing: 0.01em;
  color: #57606a;
  white-space: nowrap;
  direction: ltr; /* "9% AI" must not bidi-flip to "AI 9%" inside RTL paragraphs */
  cursor: default;
  animation: anagram-badge-in 180ms ease-out both;
  transition: box-shadow 130ms ease, transform 130ms ease;
}

:host(:hover) .pill {
  transform: translateY(-0.5px);
  box-shadow: 0 3px 10px rgba(15, 23, 42, 0.16), 0 1px 2px rgba(15, 23, 42, 0.08);
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

.pill.band-human   { --dot: #1a7f37; --ring: rgba(26, 127, 55, 0.18);   color: #116a37; }
.pill.band-light   { --dot: #d4a017; --ring: rgba(212, 160, 23, 0.22);  color: #7a5b00; }
.pill.band-heavy   { --dot: #e8590c; --ring: rgba(232, 89, 12, 0.20);   color: #a13d00; }
.pill.band-ai      { --dot: #e5484d; --ring: rgba(229, 72, 77, 0.20);   color: #b42318; }
.pill.band-unknown { --dot: #9aa3ad; --ring: rgba(154, 163, 173, 0.16); color: #57606a; }

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
/* Default: centered above the chip. badge.ts adds .below / .align-left /
   .align-right when the chip sits near a viewport edge. Fixed 11px type —
   card readability should not scale with page text. */

.card {
  position: absolute;
  bottom: calc(100% + 9px);
  left: 50%;
  transform: translateX(-50%);
  box-sizing: border-box;
  width: max-content;
  min-width: 232px;
  max-width: min(300px, 78vw);
  padding: 11px 13px 10px;
  border-radius: 11px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: rgba(255, 255, 255, 0.98);
  -webkit-backdrop-filter: saturate(1.3) blur(14px);
  backdrop-filter: saturate(1.3) blur(14px);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.16), 0 2px 6px rgba(15, 23, 42, 0.08);
  font: 400 11px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #1f2328;
  text-align: left;
  white-space: normal;
  visibility: hidden;
  opacity: 0;
  transition: opacity 130ms ease, visibility 0s linear 190ms;
  pointer-events: none;
  z-index: 1;
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

/* Caret pointing at the chip — centered orientations only (edge-pinned cards sit
   asymmetrically; a mis-aimed caret is worse than none). */
.caret {
  position: absolute;
  left: 50%;
  bottom: -5px;
  width: 9px;
  height: 9px;
  margin-left: -4.5px;
  transform: rotate(45deg);
  background: inherit;
  border: inherit;
  border-top: none;
  border-left: none;
  border-radius: 0 0 2px 0;
}
.card.below .caret {
  bottom: auto;
  top: -5px;
  border: inherit;
  border-bottom: none;
  border-right: none;
  border-radius: 2px 0 0 0;
}
.card.align-left .caret, .card.align-right .caret { display: none; }

.card.below { bottom: auto; top: calc(100% + 9px); }
.card.align-left  { left: 0; right: auto; transform: none; }
.card.align-right { left: auto; right: 0; transform: none; }

:host(:hover) .card,
.card.open {
  visibility: visible;
  opacity: 1;
  pointer-events: auto;
  transition-delay: 60ms, 60ms;
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
.card .big { font-weight: 700; font-size: 12px; font-variant-numeric: tabular-nums; color: #1f2328; }

.card .row {
  display: flex;
  justify-content: space-between;
  gap: 12px;
}
.card .row .k { color: #656d76; }
.card .row .v { font-variant-numeric: tabular-nums; color: #1f2328; }

.card .actions {
  display: flex;
  gap: 6px;
  margin-top: 8px;
}
.card .act {
  font: 600 10px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #3730a3;
  border: 1px solid rgba(109, 94, 252, 0.35);
  background: rgba(109, 94, 252, 0.06);
  border-radius: 999px;
  padding: 4px 10px;
  cursor: pointer;
}
.card .act:hover { background: rgba(109, 94, 252, 0.14); }
.card .act.done { color: #116a37; border-color: rgba(26, 127, 55, 0.4); background: rgba(26, 127, 55, 0.08); }

.card .foot {
  margin-top: 7px;
  padding-top: 6px;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
  color: #8b949e;
  font-size: 10px;
  line-height: 1.4;
}

/* ---- dark surfaces ------------------------------------------------------------ */

:host(.pg-dark) .pill {
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(32, 34, 37, 0.92);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  color: #b9c0c8;
}
:host(.pg-dark) .pill.band-human   { color: #4ecb71; }
:host(.pg-dark) .pill.band-light   { color: #e6c84c; }
:host(.pg-dark) .pill.band-heavy   { color: #ff9a57; }
:host(.pg-dark) .pill.band-ai      { color: #ff7b81; }
:host(.pg-dark) .pill.band-unknown { color: #b9c0c8; }

:host(.pg-dark) .card {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(28, 30, 33, 0.98);
  color: #e6edf3;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.35);
}
:host(.pg-dark) .card .big { color: #e6edf3; }
:host(.pg-dark) .card .row .k { color: #9aa3ad; }
:host(.pg-dark) .card .row .v { color: #e6edf3; }
:host(.pg-dark) .card .verdict.band-human { color: #4ecb71; }
:host(.pg-dark) .card .verdict.band-light { color: #e6c84c; }
:host(.pg-dark) .card .verdict.band-heavy { color: #ff9a57; }
:host(.pg-dark) .card .verdict.band-ai    { color: #ff7b81; }
:host(.pg-dark) .card .act { color: #b6aefc; border-color: rgba(150, 136, 252, 0.45); background: rgba(150, 136, 252, 0.10); }
:host(.pg-dark) .card .act:hover { background: rgba(150, 136, 252, 0.2); }
:host(.pg-dark) .card .foot { border-top-color: rgba(255, 255, 255, 0.09); color: #768390; }

/* ---- forced colors (Windows High Contrast) ------------------------------------ */
/* Let the system palette flatten surfaces, but keep the verdict dot semantic and
   guarantee a visible chip boundary. */
@media (forced-colors: active) {
  .pill, .card { border: 1px solid ButtonText; }
  .dot { forced-color-adjust: none; }
}

@keyframes anagram-flash {
  0%, 100% { box-shadow: 0 1px 4px rgba(15, 23, 42, 0.10); transform: scale(1); }
  25%, 65% { box-shadow: 0 0 0 6px rgba(109, 94, 252, 0.35), 0 1px 4px rgba(15, 23, 42, 0.10); transform: scale(1.12); }
}
.pill.pg-flash { animation: anagram-flash 800ms ease-in-out 2; }

@media (prefers-reduced-motion: reduce) {
  .pill { animation: none; transition: none; }
  .pill.pending .dot { animation: none; opacity: 0.6; }
  .pill.pg-flash { animation: none; outline: 2px solid rgba(109, 94, 252, 0.8); }
  .card { transition: none; }
}
` + DIST_CSS;
