// entrypoints/shadowPort.content.ts — the page-world script's isolated companion.
//
// It hears the one message the page-world script (entrypoints/shadow.content.ts) sends as it
// starts: the name, drawn for this document, of the event it dispatches on a host that was
// given a shadow root (lib/dom/shadow.ts). Registered just before it, on the same sites, at
// document_start (lib/access/worker.ts): both run before the page's first script, so the
// page is never there to hear it.
import { defineContentScript } from "#imports";
import { hearShadowPort } from "../lib/dom/shadow";

export default defineContentScript({
  registration: "runtime",
  matches: ["<all_urls>"],
  runAt: "document_start",
  allFrames: true,
  // WXT would also post its "started" note to the window, where the page reads it.
  noScriptStartedPostMessage: true,
  main() {
    hearShadowPort();
  },
});
