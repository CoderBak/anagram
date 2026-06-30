// entrypoints/content.ts — main content script (spec §4.1).
// Constructs + starts the orchestrator when scoring is enabled for this site, and listens
// for popup/SW control messages (RESCAN / SET_ENABLED / GET_TAB_STATE / TEARDOWN).
import { defineContentScript, browser } from "#imports";
import { createOrchestrator } from "../lib/capture/orchestrator";
import { enabledForSite } from "../lib/settings/settings";
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
