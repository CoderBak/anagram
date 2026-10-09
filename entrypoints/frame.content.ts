// entrypoints/frame.content.ts — what a granted page's frames below its top run first.
//
// The content script (entrypoints/content.ts) is some 240 KB to parse and compile, ~12 ms on
// an M4, and most of a page's frames are its ad slots, pixels and widgets, none of which holds
// a paragraph. This asks the worker for it (readFrame in lib/access/worker.ts) only once the
// frame is as large as the content script's own gate asks and its text could hold a paragraph
// as long as the shortest one read — or it has a shadow root, whose text this cannot see.
// Until then it watches the frame grow and change.
import { defineContentScript, browser } from "#imports";
import { ACTIONS } from "../lib/messaging/protocol";
import { frameLargeEnough, holdsText } from "../lib/dom/frameGate";
import { shadowAttachedEvent, shadowRootSeen } from "../lib/dom/shadow";
import { MIN_WORDS } from "../lib/dom/text";

/** How long after a change to the frame its text is counted again. */
const RECOUNT_MS = 500;

export default defineContentScript({
  // Registered at runtime on the granted sites, in every frame (lib/access/worker.ts).
  registration: "runtime",
  matches: ["<all_urls>"],
  runAt: "document_end",
  allFrames: true,
  // WXT would also post its "started" note to the window, where the page reads it.
  noScriptStartedPostMessage: true,
  main() {
    if (window.self === window.top) return;
    const world = window as unknown as Record<string, unknown>;
    // A sandboxed frame has no origin, so no grant covers it (entrypoints/content.ts).
    if (world.__anagramContentScript || world.__anagramFrame || window.origin === "null") return;
    // Also what tells the worker's one-off injections this frame is a granted one.
    world.__anagramFrame = true;
    const attached = shadowAttachedEvent();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ready = (): boolean => frameLargeEnough() && (shadowRootSeen() || holdsText(MIN_WORDS));
    const check = (): void => {
      timer = null;
      if (!ready()) return;
      stop();
      void browser.runtime.sendMessage({ action: ACTIONS.READ_FRAME }).catch(() => undefined);
    };
    const later = (): void => {
      timer ??= setTimeout(check, RECOUNT_MS);
    };
    const observer = new MutationObserver(later);
    function stop(): void {
      observer.disconnect();
      window.removeEventListener("resize", later);
      if (attached) document.removeEventListener(attached, later, true);
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }
    observer.observe(document, { childList: true, subtree: true, characterData: true });
    window.addEventListener("resize", later, { passive: true });
    if (attached) document.addEventListener(attached, later, true);
    check();
  },
});
