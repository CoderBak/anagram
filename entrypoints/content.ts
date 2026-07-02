// entrypoints/content.ts — main content script.
// Runs in EVERY frame (allFrames): the top frame gets the full experience (FAB,
// Docs actions, popup state); subframes run a chrome-less pipeline so framed
// article content (webmail readers, embedded posts) is scored too — gated on
// frame size so ad slots and tracking pixels never pay for a walk.
import { defineContentScript, browser } from "#imports";
import { createOrchestrator } from "../lib/capture/orchestrator";
import { enabledForSite } from "../lib/settings/settings";
import {
  detectDocsPage,
  readingViewUrl,
  editorUrl,
  currentTabParam,
  isReadingMarked,
  applyDocsReadingStyle,
  DOCS_RETURN_KEY,
} from "../lib/docs";
import { ACTIONS } from "../lib/messaging/protocol";
import type { ControlMessage, TabState } from "../lib/messaging/protocol";

/** Min frame viewport for a subframe to be worth scanning (ad slots are smaller). */
const MIN_FRAME_AREA = 40_000; // e.g. 400×100
const MIN_FRAME_WIDTH = 200;

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_end",
  allFrames: true,
  async main(ctx) {
    const isTop = window.self === window.top;
    const orchestrator = createOrchestrator(ctx, { mountFab: isTop });
    let enabled = await enabledForSite(location.hostname);

    const frameGateOk = (): boolean =>
      isTop ||
      (window.innerWidth >= MIN_FRAME_WIDTH &&
        window.innerWidth * window.innerHeight >= MIN_FRAME_AREA);

    const startWhenGated = (): void => {
      if (!enabled) return;
      if (frameGateOk()) {
        orchestrator.start();
        return;
      }
      // Lazy frames start collapsed and grow later (embeds, chat panes) —
      // retry once the frame is resized past the gate.
      const onResize = (): void => {
        if (!enabled || !frameGateOk()) return;
        window.removeEventListener("resize", onResize);
        orchestrator.start();
      };
      window.addEventListener("resize", onResize);
    };
    startWhenGated();

    // Google Docs (top frame only): the editor is a canvas (no DOM text). Offer
    // the static-HTML reading view; from the reading view, offer the way back to
    // the SAME tab.
    const docs = isTop ? detectDocsPage(location) : null;
    if (docs) {
      if (docs.kind === "editor") {
        orchestrator.setFabAction(
          "Open reading view",
          () => {
            try {
              sessionStorage.setItem(DOCS_RETURN_KEY, location.href);
            } catch {
              /* storage may be blocked — fallback return URL still works */
            }
            location.href = readingViewUrl(docs.id, currentTabParam(location));
          },
          { attention: true }, // the main toggle is useless on canvas — point here
        );
      } else {
        if (isReadingMarked(location)) applyDocsReadingStyle();
        orchestrator.setFabAction("Back to editor", () => {
          let target = editorUrl(docs.id);
          try {
            const saved = sessionStorage.getItem(DOCS_RETURN_KEY);
            if (saved && saved.includes(`/d/${docs.id}/`)) target = saved;
          } catch {
            /* fall back to the bare editor URL */
          }
          location.href = target;
        });
      }
    }

    browser.runtime.onMessage.addListener(
      (
        message: unknown,
        _sender,
        sendResponse: (response?: unknown) => void,
      ): boolean | undefined => {
        const msg = message as ControlMessage;
        if (!msg || typeof msg !== "object" || !("action" in msg)) return;

        switch (msg.action) {
          case ACTIONS.RESCAN:
            orchestrator.rescan();
            return;

          case ACTIONS.SET_ENABLED:
            if (msg.value && !enabled) {
              enabled = true;
              if (frameGateOk()) orchestrator.start();
            } else if (!msg.value && enabled) {
              enabled = false;
              orchestrator.stop();
            }
            return;

          case ACTIONS.GET_TAB_STATE: {
            // tabs.sendMessage broadcasts to every frame — only the TOP frame
            // answers, so the popup's count is the page's, not some iframe's.
            if (!isTop) return;
            const state: TabState = {
              enabled,
              hostname: location.hostname,
              scored: orchestrator.scoredCount(),
            };
            sendResponse(state);
            return; // synchronous response
          }

          case ACTIONS.TEARDOWN:
            enabled = false;
            orchestrator.stop();
            return;

          default:
            return;
        }
      },
    );
  },
});
