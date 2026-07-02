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
// - The card is edge-aware: badge.ts flips it below the chip near the viewport
//   top and pins it left/right near the horizontal edges.
//
// Cascade note: page rules from the outer tree beat ordinary :host declarations,
// but shadow-context !important beats page !important — so the layout-critical
// host props are declared !important here AND mirrored as inline styles.
export const BADGE_CSS: string = `
:host {
  all: initial;
  font-size: inherit; /* after all:initial — chip scales with the annotated text */
  display: inline-block !important;
  position: relative !important;
  vertical-align: baseline;
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

@keyframes pangram-badge-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 0.4em;
  box-sizing: border-box;
  font-size: clamp(9px, 0.66em, 12px);
  line-height: 1;
  padding: 0.3em 0.7em 0.3em 0.55em;
  border-radius: 9999px;
  border: 1px solid rgba(0, 0, 0, 0.07);
  background: rgba(255, 255, 255, 0.88);
  -webkit-backdrop-filter: saturate(1.4) blur(8px);
  backdrop-filter: saturate(1.4) blur(8px);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.10), 0 1px 1px rgba(0, 0, 0, 0.05);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  font-weight: 650;
  letter-spacing: 0.01em;
  color: #57606a;
  white-space: nowrap;
  cursor: default;
  animation: pangram-badge-in 160ms ease-out both;
  transition: box-shadow 120ms ease;
}

:host(:hover) .pill {
  box-shadow: 0 3px 10px rgba(0, 0, 0, 0.16), 0 1px 2px rgba(0, 0, 0, 0.08);
}

.dot {
  width: 0.55em;
  height: 0.55em;
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
.pill.band-mixed   { --dot: #d99e00; --ring: rgba(217, 158, 0, 0.22);   color: #8a5a00; }
.pill.band-ai      { --dot: #e5484d; --ring: rgba(229, 72, 77, 0.20);   color: #b42318; }
.pill.band-unknown { --dot: #9aa3ad; --ring: rgba(154, 163, 173, 0.16); color: #57606a; }

/* ---- hover detail card ------------------------------------------------------- */
/* Default: centered above the chip. badge.ts adds .below / .align-left /
   .align-right when the chip sits near a viewport edge. Fixed 11px type —
   card readability should not scale with page text. */

.card {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 50%;
  transform: translateX(-50%);
  box-sizing: border-box;
  width: max-content;
  min-width: 216px;
  max-width: min(280px, 74vw);
  padding: 10px 12px 9px;
  border-radius: 10px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  background: rgba(255, 255, 255, 0.97);
  -webkit-backdrop-filter: saturate(1.3) blur(14px);
  backdrop-filter: saturate(1.3) blur(14px);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.16), 0 2px 6px rgba(0, 0, 0, 0.08);
  font: 400 11px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #1f2328;
  text-align: left;
  white-space: normal;
  visibility: hidden;
  opacity: 0;
  transition: opacity 120ms ease, visibility 0s linear 120ms;
  pointer-events: none;
  z-index: 1;
}

.card.below { bottom: auto; top: calc(100% + 8px); }
.card.align-left  { left: 0; right: auto; transform: none; }
.card.align-right { left: auto; right: 0; transform: none; }

:host(:hover) .card {
  visibility: visible;
  opacity: 1;
  transition-delay: 60ms, 60ms;
}

.card .head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 5px;
}
.card .verdict { font-weight: 700; font-size: 12px; }
.card .verdict.band-human   { color: #116a37; }
.card .verdict.band-mixed   { color: #8a5a00; }
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

.card .foot {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid rgba(0, 0, 0, 0.06);
  color: #8b949e;
  font-size: 10px;
  line-height: 1.4;
}

/* ---- dark surfaces ------------------------------------------------------------ */

:host(.pg-dark) .pill {
  border-color: rgba(255, 255, 255, 0.14);
  background: rgba(32, 34, 37, 0.88);
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
  color: #b9c0c8;
}
:host(.pg-dark) .pill.band-human   { color: #4ecb71; }
:host(.pg-dark) .pill.band-mixed   { color: #e6b84c; }
:host(.pg-dark) .pill.band-ai      { color: #ff7b81; }
:host(.pg-dark) .pill.band-unknown { color: #b9c0c8; }

:host(.pg-dark) .card {
  border-color: rgba(255, 255, 255, 0.12);
  background: rgba(28, 30, 33, 0.97);
  color: #e6edf3;
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.35);
}
:host(.pg-dark) .card .big { color: #e6edf3; }
:host(.pg-dark) .card .row .k { color: #9aa3ad; }
:host(.pg-dark) .card .row .v { color: #e6edf3; }
:host(.pg-dark) .card .verdict.band-human { color: #4ecb71; }
:host(.pg-dark) .card .verdict.band-mixed { color: #e6b84c; }
:host(.pg-dark) .card .verdict.band-ai    { color: #ff7b81; }
:host(.pg-dark) .card .foot { border-top-color: rgba(255, 255, 255, 0.09); color: #768390; }

@media (prefers-reduced-motion: reduce) {
  .pill { animation: none; transition: none; }
  .card { transition: none; }
}
`;
