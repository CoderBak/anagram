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

import { finish } from "../slices";
import { MARK_ATTR } from "../types";

/**
 * How the page-world script tells the isolated world the name of its event. The event it
 * dispatches on a host when a shadow root is attached carries nothing (the content script
 * reads the root itself) and is named at random for each document, so that a page has no
 * name to listen for. That name is told once, in this event on the document, before any
 * script of the page runs: the page-world script runs at document_start, just after its
 * isolated companion (entrypoints/shadowPort.content.ts), which is listening for it and
 * keeps the name where only the extension's own scripts in this frame can read it.
 */
export const SHADOW_PORT_EVENT = "anagram-shadow-port";
/** The per-document name, as the isolated world keeps it (a global of that world only). */
const SHADOW_EVENT_KEY = "__anagramShadowEvent";
/** What a name drawn by the page-world script looks like. */
const SHADOW_EVENT_NAME = /^[a-z]{20}$/;

/** Hear the page-world script's one message (entrypoints/shadowPort.content.ts). */
export function hearShadowPort(): void {
  document.addEventListener(
    SHADOW_PORT_EVENT,
    (e) => {
      const name = (e as CustomEvent<unknown>).detail;
      if (typeof name === "string" && SHADOW_EVENT_NAME.test(name)) (window as unknown as Record<string, string>)[SHADOW_EVENT_KEY] = name;
    },
    { capture: true, once: true },
  );
}

/** The name of the event the page-world script dispatches on a host that was given a shadow
 *  root, or null where it did not run (a tab the content script was injected into later). */
export function shadowAttachedEvent(): string | null {
  return (window as unknown as Record<string, string | undefined>)[SHADOW_EVENT_KEY] ?? null;
}

// Adapted from Mozilla Firefox, TranslationsDocument#addShadowRootsToObserver in
// toolkit/components/translations/content/translations-document.sys.mjs
// (https://github.com/mozilla-firefox/firefox), MPL-2.0, © Mozilla Foundation and
// contributors. Unlike the original, the node itself is looked at as well as what is below,
// and Anagram's own hosts are passed over.
/** Every shadow root on `node` and below it, the roots inside those roots included — but
 *  none in Anagram's own UI: the ball redrawing its count must not wake the observer. */
export function eachShadowRoot(node: Node, visit: (root: ShadowRoot) => void): void {
  finish(eachShadowRootInSlices(node, visit));
}

/** eachShadowRoot, a few hundred elements at a time (finishInSlices): the whole page's, at
 *  start, is every element of it. */
export function* eachShadowRootInSlices(node: Node, visit: (root: ShadowRoot) => void): Generator<void, void> {
  if (node.nodeType === Node.ELEMENT_NODE) {
    if ((node as Element).hasAttribute(MARK_ATTR)) return;
    const own = shadowRootOf(node as Element);
    if (own) {
      visit(own);
      yield* eachShadowRootInSlices(own, visit);
    }
  }
  const doc = node.ownerDocument ?? (node as Document);
  const walker = doc.createTreeWalker(node, NodeFilter.SHOW_ELEMENT, (el) =>
    (el as Element).hasAttribute(MARK_ATTR) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  );
  let n = 0;
  for (let el = walker.nextNode() as Element | null; el; el = walker.nextNode() as Element | null) {
    if (++n % 512 === 0) yield;
    const root = shadowRootOf(el);
    if (!root) continue;
    visit(root);
    yield* eachShadowRootInSlices(root, visit);
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

