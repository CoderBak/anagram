// entrypoints/nav-hook.content.ts — MAIN-world SPA navigation hook.
//
// Content scripts live in an isolated world, so patching history there would
// never see the PAGE's pushState/replaceState calls. This tiny script runs in
// the MAIN world (exempt from page CSP), wraps both methods, and announces
// navigations via a DOM event — events cross worlds, so the isolated-world
// orchestrator gets an immediate, event-driven signal instead of polling.
import { defineContentScript } from "#imports";

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_start",
  world: "MAIN",
  allFrames: true,
  main() {
    const announce = () => window.dispatchEvent(new Event("pangram:navigate"));
    for (const method of ["pushState", "replaceState"] as const) {
      const original = history[method];
      history[method] = function (this: History, ...args: Parameters<History["pushState"]>) {
        const result = original.apply(this, args);
        announce();
        return result;
      } as History["pushState"];
    }
  },
});
