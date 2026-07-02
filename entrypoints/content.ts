// entrypoints/content.ts — main content script.
// Constructs + starts the orchestrator when scoring is enabled for this site,
// wires the Google Docs reading-view action, and listens for popup/SW control
// messages (RESCAN / SET_ENABLED / GET_TAB_STATE / TEARDOWN).
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

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_end",
  allFrames: false, // top frame only — avoids a FAB per ad/embed iframe and ad-text noise
  async main(ctx) {
    const orchestrator = createOrchestrator(ctx);
    let enabled = await enabledForSite(location.hostname);
    if (enabled) orchestrator.start();

    // Google Docs: the editor is a canvas (no DOM text). Offer the static-HTML
    // reading view; from the reading view, offer the way back to the SAME tab.
    const docs = detectDocsPage(location);
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
              orchestrator.start();
            } else if (!msg.value && enabled) {
              enabled = false;
              orchestrator.stop();
            }
            return;

          case ACTIONS.GET_TAB_STATE: {
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
