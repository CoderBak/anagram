// entrypoints/shadow.content.ts — the one script Anagram runs in the page's own world.
//
// It says THAT a shadow root was attached, and on which element: a web component defined
// after the walk passed its host renders into a root that changes nothing the content
// script can observe from its isolated world. It reads nothing, sends nothing and keeps
// nothing — the content script (lib/capture/observers.ts) hears the event on the document
// and reads the root itself. Registered next to the content script, on the same granted
// sites, at document_start so that it is in place before the page's own scripts run
// (lib/access/worker.ts).
import { defineContentScript } from "#imports";
import { SHADOW_ATTACHED_EVENT } from "../lib/dom/shadow";

export default defineContentScript({
  registration: "runtime",
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: true,
  world: "MAIN",
  // No `var shadow = …` on the page's own window.
  globalName: false,
  main() {
    // Adapted from FluentRead, installShadowRouteBridgeCore in
    // src/platform/shadow-ui/pageBridgeCore.ts (https://github.com/FluentRead/FluentRead),
    // GPL-3.0, © the FluentRead contributors. Only the attachShadow wrapper is taken; the
    // event goes out for closed roots too, which the content script reads through the
    // extension API.
    const proto = Element.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "attachShadow");
    const original = descriptor?.value as Element["attachShadow"] | undefined;
    if (!descriptor || typeof original !== "function") return;
    const attachShadow = function attachShadow(this: Element, init: ShadowRootInit): ShadowRoot {
      // The page's own arguments, as it passed them: a bad one must throw what it throws.
      // eslint-disable-next-line prefer-rest-params
      const root = Reflect.apply(original, this, arguments) as ShadowRoot;
      try {
        this.dispatchEvent(new CustomEvent(SHADOW_ATTACHED_EVENT, { bubbles: true, composed: true }));
      } catch {
        /* a page that broke its own event API still gets its root */
      }
      return root;
    };
    try {
      Object.defineProperty(proto, "attachShadow", { ...descriptor, value: attachShadow });
    } catch {
      /* a page that froze the prototype keeps it as it is */
    }
  },
});
