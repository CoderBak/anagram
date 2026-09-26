// lib/dom/shadow.ts — shadow roots the walk and the observers cannot come across by walking.
//
// A shadow root attached, or filled, after the walk passed its host changes nothing the
// document's own MutationObserver sees. Two things find it: every subtree the page adds is
// searched for roots (a host added with its root already attached, but too empty then for
// the walk to go in), and the page-world script (entrypoints/shadow.content.ts) announces
// every attachShadow() with an event on the host, which bubbles out of shadow trees to the
// content script's listener on the document.

import { MARK_ATTR } from "../types";

/** Dispatched on a host by the page-world script when a shadow root is attached to it. It
 *  carries nothing: the content script reads the root itself. */
export const SHADOW_ATTACHED_EVENT = "anagram-shadow-attached";

// Adapted from Mozilla Firefox, TranslationsDocument#addShadowRootsToObserver in
// toolkit/components/translations/content/translations-document.sys.mjs
// (https://github.com/mozilla-firefox/firefox), MPL-2.0, © Mozilla Foundation and
// contributors. Unlike the original, the node itself is looked at as well as what is below,
// and Anagram's own hosts are passed over.
/** Every shadow root on `node` and below it, the roots inside those roots included — but
 *  none in Anagram's own UI: the ball redrawing its count must not wake the observer. */
export function eachShadowRoot(node: Node, visit: (root: ShadowRoot) => void): void {
  if (node.nodeType === Node.ELEMENT_NODE) {
    if ((node as Element).hasAttribute(MARK_ATTR)) return;
    const own = (node as Element).shadowRoot;
    if (own) {
      visit(own);
      eachShadowRoot(own, visit);
    }
  }
  const doc = node.ownerDocument ?? (node as Document);
  const walker = doc.createTreeWalker(node, NodeFilter.SHOW_ELEMENT, (el) =>
    (el as Element).hasAttribute(MARK_ATTR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  );
  for (let el = walker.nextNode() as Element | null; el; el = walker.nextNode() as Element | null) {
    const root = el.shadowRoot;
    if (!root) continue;
    visit(root);
    eachShadowRoot(root, visit);
  }
}
