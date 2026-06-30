// lib/render/badge.css.ts — constructable stylesheet source for the badge shadow root.
// Exported as a string so badge.ts can adopt it via
// `const s = new CSSStyleSheet(); s.replaceSync(BADGE_CSS)` →
// `shadowRoot.adoptedStyleSheets = [s]`. We never fetch a CSS URL (§4.8).

/**
 * CSS text for the badge shadow root.
 *
 * - `:host { all: initial }` fully resets inherited page styles so the badge looks the
 *   same on every site, with a near-max `z-index`.
 * - The host is absolutely positioned at the block's top-right and pulled UP by ~half its
 *   height (`translateY(-52%)`) so the chip sits on the top edge / in the inter-block
 *   whitespace rather than overlapping the paragraph's first line.
 * - `.pill` is a glass chip: a neutral translucent base with a band-coloured status dot,
 *   tinted label, soft layered shadow, gentle entrance and a hover lift.
 */
export const BADGE_CSS: string = `
:host {
  all: initial;
  position: absolute;
  top: 0;
  left: 0; /* badge.ts sets left/top inline, anchored to the end of the text's last line */
  z-index: 2147483646;
  pointer-events: none;
  contain: layout style;
}

/* Instant show/hide toggle (set by badge.ts setVisible) — keeps the badge in the DOM. */
:host(.pg-hidden) { display: none !important; }

@keyframes pangram-badge-in {
  from { opacity: 0; transform: scale(0.9); }
  to   { opacity: 1; transform: scale(1); }
}

.pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  box-sizing: border-box;
  height: 20px;
  padding: 0 9px 0 7px;
  border-radius: 9999px;
  border: 1px solid rgba(0, 0, 0, 0.06);
  background: rgba(255, 255, 255, 0.82);
  -webkit-backdrop-filter: saturate(1.4) blur(10px);
  backdrop-filter: saturate(1.4) blur(10px);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.10), 0 1px 2px rgba(0, 0, 0, 0.06);
  font: 600 11px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  letter-spacing: 0.01em;
  color: #57606a;
  white-space: nowrap;
  pointer-events: auto;
  user-select: none;
  cursor: default;
  animation: pangram-badge-in 180ms cubic-bezier(0.2, 0.7, 0.3, 1) both;
  transition: box-shadow 140ms ease, transform 140ms ease;
}

:host(:hover) .pill {
  transform: translateY(-1px);
  box-shadow: 0 5px 16px rgba(0, 0, 0, 0.14), 0 1px 3px rgba(0, 0, 0, 0.08);
}

.dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--dot, #9aa3ad);
  box-shadow: 0 0 0 2px var(--ring, rgba(154, 163, 173, 0.18));
}

.label { display: inline-block; font-variant-numeric: tabular-nums; font-weight: 650; }

.pill.band-human   { --dot: #1a7f37; --ring: rgba(26, 127, 55, 0.18);   color: #116a37; }
.pill.band-mixed   { --dot: #d99e00; --ring: rgba(217, 158, 0, 0.20);   color: #8a5a00; }
.pill.band-ai      { --dot: #e5484d; --ring: rgba(229, 72, 77, 0.18);   color: #b42318; }
.pill.band-unknown { --dot: #9aa3ad; --ring: rgba(154, 163, 173, 0.18); color: #57606a; }

@media (prefers-reduced-motion: reduce) {
  .pill { animation: none; transition: none; }
}
`;
