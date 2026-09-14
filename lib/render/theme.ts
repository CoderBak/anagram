// lib/render/theme.ts — shared background-theme detection.
//
// Badges adapt per-anchor (a dark card on a light page gets a dark chip); the
// highlight palette can only switch PER PAGE — ::highlight() rules are global —
// so it keys off the page-level verdict.
//
// Colour parsing is culori's (complete CSS Color 4). Chrome keeps the AUTHORED colour
// space in computed values, so a page styled with oklch(), lab(), hwb() or
// color(display-p3 …) backgrounds serialises exactly that way — the hand-rolled
// rgb()/color(srgb) matcher this replaces read those as "unpainted" and picked the
// wrong palette. Luminance is WCAG relative luminance (linear light), not a
// gamma-encoded average.
import {
  useMode,
  modeRgb,
  modeLrgb,
  modeLab,
  modeLch,
  modeOklab,
  modeOklch,
  modeP3,
  modeA98,
  modeProphoto,
  modeRec2020,
  modeXyz50,
  modeXyz65,
  parse,
  wcagLuminance,
} from "culori/fn";

// Register only the spaces a computed background can serialise in (tree-shaken build):
// legacy sRGB syntaxes (hex, named, hsl, hwb) always compute to rgb(); the CSS Color 4
// spaces keep their authored form. lrgb is what wcagLuminance converts through.
useMode(modeRgb);
useMode(modeLrgb);
useMode(modeLab);
useMode(modeLch);
useMode(modeOklab);
useMode(modeOklch);
useMode(modeP3);
useMode(modeA98);
useMode(modeProphoto);
useMode(modeRec2020);
useMode(modeXyz50);
useMode(modeXyz65);

/** WCAG relative luminance below which a surface counts as dark (≈ sRGB-encoded 0.42). */
const DARK_LUMINANCE = 0.15;
/** Alpha at or below which a background is treated as not painted. */
const MIN_ALPHA = 0.1;

/** Relative luminance of a painted CSS colour; null when transparent or unparsable. */
export function paintedLuminance(css: string): number | null {
  const c = parse(css);
  if (!c) return null;
  if ((c.alpha ?? 1) <= MIN_ALPHA) return null;
  return wcagLuminance(c);
}

/** True if the FIRST painted background walking up from `el` is dark. */
export function isDarkContext(el: Element, maxHops = 8): boolean {
  let node: Element | null = el;
  for (let i = 0; i < maxHops && node; i++, node = node.parentElement) {
    try {
      const lum = paintedLuminance(getComputedStyle(node).backgroundColor);
      if (lum !== null) return lum < DARK_LUMINANCE;
    } catch {
      return false;
    }
  }
  return false; // nothing painted → default light
}

/** Page-level dark verdict (body, then html). */
export function isDarkPage(): boolean {
  const body = document.body;
  if (body && isDarkContext(body, 1)) return true;
  const lum = paintedLuminance(getComputedStyle(document.documentElement).backgroundColor);
  if (lum !== null) return lum < DARK_LUMINANCE;
  // Neither paints: the UA default canvas is light unless the page opts into dark.
  return false;
}
