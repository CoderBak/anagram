// entrypoints/background.ts — MV3 service worker (spec §4.6).
// Registers a SINGLE runtime.onMessage listener SYNCHRONOUSLY at top level (MV3 wakes the
// worker by re-running this registration), routes SCORE_BATCH → router.handle, and returns
// true to keep the message channel open for the async sendResponse. Popup control actions
// (RESCAN / SET_ENABLED / GET_TAB_STATE) are addressed straight to the active tab's content
// script via tabs.sendMessage (spec §4.9), so they do not pass through here.
import { defineBackground, browser } from "#imports";
import { createRouter } from "../lib/backend/router";
import { getScoreClient } from "../lib/backend/getScoreClient";
import { ACTIONS } from "../lib/messaging/protocol";
import type {
  ScoreBatchMessage,
  ScoreBatchReply,
  UpdateBadgeMessage,
} from "../lib/messaging/protocol";

export default defineBackground(() => {
  const router = createRouter(getScoreClient());

  browser.runtime.onMessage.addListener(
    (
      message: unknown,
      sender,
      sendResponse: (response?: unknown) => void,
    ): boolean | undefined => {
      const msg = message as {
        action?: string;
        req?: ScoreBatchMessage["req"];
        flagged?: UpdateBadgeMessage["flagged"];
      };
      if (!msg) return;

      // Per-tab flagged count on the toolbar icon (sent by the TOP frame only).
      if (msg.action === ACTIONS.UPDATE_BADGE) {
        const tabId = sender.tab?.id;
        if (tabId != null) {
          const flagged = typeof msg.flagged === "number" ? msg.flagged : 0;
          void browser.action.setBadgeText({ tabId, text: flagged > 0 ? String(flagged) : "" });
          void browser.action.setBadgeBackgroundColor({ tabId, color: "#e5484d" });
        }
        return;
      }

      if (msg.action !== ACTIONS.SCORE_BATCH || !msg.req) return;

      router
        .handle(msg.req)
        .then((resp) => {
          const reply: ScoreBatchReply = { results: resp.results };
          sendResponse(reply);
        })
        .catch(() => {
          const reply: ScoreBatchReply = { results: [] };
          sendResponse(reply);
        });

      return true; // keep the channel open for the async sendResponse
    },
  );
});
