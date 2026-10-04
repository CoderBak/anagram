// lib/dom/kept.ts — an answer about the whole page, kept until the page changes.
//
// A walk asks some questions of the whole page before it reads a line of it: where the bylines
// are, which boxes are posts, where a quoted mail history starts (lib/dom/scope.ts). A page that
// keeps changing is walked again and again, and a drain often walks several roots in a row with
// nothing changed in between — on a chat adding a message every 300 ms, the group of short
// messages the new one joins is read anew, and every message the old group held is walked again
// on its own afterwards: up to thirty walks a drain, each surveying the whole page. An answer
// that is a function of the document's tree is the same answer while the tree is the same, so
// it is kept, and made again only after the page has changed in any way at all: a node added,
// removed or moved, a text, an attribute. A MutationObserver says so; it watches only while an
// answer is kept, and lets go at the first change it reports.

/** `make`'s answer about `doc`'s light DOM, made again only once that has changed. */
export function keptUntilChanged<T>(make: () => T, doc?: Document): () => T {
  let kept: { value: T } | null = null;
  let watch: MutationObserver | null = null;
  function forget(): void {
    kept = null;
    watch?.disconnect();
  }
  return () => {
    // A change made since the answer was, but not yet reported, waits in the observer's queue.
    if (kept && watch && watch.takeRecords().length > 0) forget();
    if (!kept) {
      kept = { value: make() };
      watch ??= new MutationObserver(forget);
      watch.observe(doc ?? document, { subtree: true, childList: true, characterData: true, attributes: true });
    }
    return kept.value;
  };
}
