// lib/dom/visibility.ts — geometry-level visibility.
//
// The v2 walker already prunes display:none / [hidden] / aria-hidden / opacity:0 /
// visibility:hidden subtrees from COMPUTED STYLE during the walk, so the only
// remaining question at emit time is geometric: does this container actually take
// up space? (height:0 + overflow:hidden collapses, empty flex tracks, off-DOM
// measurement containers.) Cached per scan — getBoundingClientRect forces layout.

export interface RectVisibleCache {
  get(el: Element): boolean;
}

export function createRectVisibleCache(): RectVisibleCache {
  const cache = new WeakMap<Element, boolean>();
  return {
    get(el: Element): boolean {
      let v = cache.get(el);
      if (v === undefined) {
        const r = el.getBoundingClientRect();
        v = r.width > 0 && r.height > 0;
        cache.set(el, v);
      }
      return v;
    },
  };
}
