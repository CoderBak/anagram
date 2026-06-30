// lib/dom/visibility.ts — explicit visibility filter (the gap the reference lacked).

/** Explicit display:none / visibility:hidden / aria-hidden / zero-rect skip. */
export function isVisible(el: Element): boolean {
  const he = el as HTMLElement;
  if (he.hidden) return false;
  if (el.getAttribute("aria-hidden") === "true") return false;
  const cs = getComputedStyle(el);
  if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") return false;
  // offsetParent === null catches most display:none ancestors cheaply (except fixed).
  if (he.offsetParent === null && cs.position !== "fixed") return false;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  return true;
}
