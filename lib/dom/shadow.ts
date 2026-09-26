// lib/dom/shadow.ts — every way into a shadow root the walk and the observers take.
//
// A shadow root attached, or filled, after the walk passed its host changes nothing the
// document's own MutationObserver sees. Two things find it: every subtree the page adds is
// searched for roots (a host added with its root already attached, but too empty then for
// the walk to go in), and the page-world script (entrypoints/shadow.content.ts) announces
// every attachShadow() with an event on the host, which bubbles out of shadow trees to the
// content script's listener on the document.
//
// A CLOSED root keeps the page's other scripts out, not the extension: Chrome (88+) gives a
// content script any root through chrome.dom.openOrClosedShadowRoot(), Firefox through
// element.openOrClosedShadowRoot. Everything here reads roots through shadowRootOf().

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
    const own = shadowRootOf(node as Element);
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
    const root = shadowRootOf(el);
    if (!root) continue;
    visit(root);
    eachShadowRoot(root, visit);
  }
}

/** Elements the page was seen attaching a shadow root to (entrypoints/shadow.content.ts). */
const announced = new WeakSet<Element>();

/** The page attached a shadow root to `el`: from now on it is asked for a closed one too. */
export function noteShadowHost(el: Element): void {
  announced.add(el);
}

/**
 * The element's shadow root, open or closed, or null. A closed one is asked for only where
 * one can be: on a custom element, or on an element the page was seen attaching a root to.
 * Asking the extension API costs a call, and the walk would pay it for every element of
 * the page; a closed root declared in the markup of a built-in element is what that misses.
 */
export function shadowRootOf(el: Element): ShadowRoot | null {
  const open = el.shadowRoot;
  if (open) return open;
  if (!el.localName.includes("-") && !announced.has(el)) return null;
  try {
    // Firefox: on the element itself, for WebExtension content scripts.
    const gecko = (el as Element & { openOrClosedShadowRoot?: ShadowRoot | null }).openOrClosedShadowRoot;
    if (gecko !== undefined) return gecko ?? null;
    // Chrome: through the extension API, for content scripts. It takes HTML elements only.
    const dom = (globalThis as { chrome?: { dom?: { openOrClosedShadowRoot?(el: HTMLElement): ShadowRoot | null } } })
      .chrome?.dom;
    if (typeof dom?.openOrClosedShadowRoot !== "function" || !(el instanceof HTMLElement)) return null;
    return dom.openOrClosedShadowRoot(el) ?? null;
  } catch {
    return null;
  }
}

type CloneInto = <T>(value: T, scope: object, options: { wrapReflectors: boolean }) => T;

/**
 * Give a shadow root these constructed stylesheets, in place of the ones it had. A content
 * script in Firefox 140 cannot do that the ordinary way: its view of the root refuses
 * `adoptedStyleSheets` ("Accessing from Xray wrapper is not supported"; Firefox 153 takes
 * it). There the list is made in the page's compartment and set on the page's view of the
 * root. The sheets are the same objects, so replaceSync() and `disabled` still reach them.
 */
export function adoptSheets(root: ShadowRoot, sheets: CSSStyleSheet[]): void {
  try {
    root.adoptedStyleSheets = sheets;
  } catch (e) {
    const page = (root as ShadowRoot & { wrappedJSObject?: ShadowRoot }).wrappedJSObject;
    const cloneInto = (globalThis as { cloneInto?: CloneInto }).cloneInto;
    if (!page || typeof cloneInto !== "function") throw e;
    page.adoptedStyleSheets = cloneInto(sheets, window, { wrapReflectors: true });
  }
}
