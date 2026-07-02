// lib/render/theme.ts — shared background-theme detection.
//
// Badges adapt per-anchor (a dark card on a light page gets a dark chip); the
// highlight palette can only switch PER PAGE — ::highlight() rules are global —
// so it keys off the page-level verdict.

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export function parseColor(s: string): Rgba | null {
  const m = s.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/);
  if (m) {
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  }
  // Wide-gamut backgrounds serialize as color(srgb r g b / a) with 0–1 channels
  // (Chrome keeps the authored color space in the computed value).
  const c = s.match(/color\(srgb(?:-linear)?\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.%]+))?\s*\)/);
  if (c) {
    const a = c[4] === undefined ? 1 : c[4].endsWith("%") ? parseFloat(c[4]) / 100 : +c[4];
    return { r: +c[1] * 255, g: +c[2] * 255, b: +c[3] * 255, a };
  }
  return null;
}

export function luminance(c: { r: number; g: number; b: number }): number {
  return (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
}

/** True if the FIRST painted background walking up from `el` is dark. */
export function isDarkContext(el: Element, maxHops = 8): boolean {
  let node: Element | null = el;
  for (let i = 0; i < maxHops && node; i++, node = node.parentElement) {
    try {
      const rgba = parseColor(getComputedStyle(node).backgroundColor);
      if (rgba && rgba.a > 0.1) return luminance(rgba) < 0.42;
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
  const html = document.documentElement;
  const rgba = parseColor(getComputedStyle(html).backgroundColor);
  if (rgba && rgba.a > 0.1) return luminance(rgba) < 0.42;
  // Neither paints: the UA default canvas is light unless the page opts into dark.
  return false;
}
