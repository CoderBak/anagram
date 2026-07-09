// entrypoints/content.ts — main content script.
// Runs in EVERY frame (allFrames): the top frame gets the full experience (FAB,
// Docs actions, popup state); subframes run a chrome-less pipeline so framed
// article content (webmail readers, embedded posts) is scored too — gated on
// frame size so ad slots and tracking pixels never pay for a walk.
import { defineContentScript, browser } from "#imports";
import { createOrchestrator } from "../lib/capture/orchestrator";
import { enabledForSite, settings } from "../lib/settings/settings";
import {
  detectDocsPage,
  readingViewUrl,
  editorUrl,
  currentTabParam,
  isReadingMarked,
  applyDocsReadingStyle,
  DOCS_RETURN_KEY,
} from "../lib/docs";
import { createDocsOverlay } from "../lib/docsOverlay";
import { analyzeSelection } from "../lib/render/selectionCard";
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
    // Google Docs (top frame only): the editor is a canvas (no DOM text) — the
    // FAB's action opens our in-tab analyzed reading overlay instead.
    const docs = isTop ? detectDocsPage(location) : null;
    const orchestrator = createOrchestrator(ctx, {
      mountFab: isTop,
      lockScope: docs?.kind === "editor" ? "page" : undefined,
    });

    // Site rules are keyed on the TOP page's hostname — that is what the popup
    // writes. Cross-origin frames cannot read it; the referrer (the embedding
    // page) is the honest fallback, then the frame's own host.
    const effectiveHost = ((): string => {
      if (isTop) return location.hostname;
      try {
        const h = window.top?.location.hostname; // same-origin frames only
        if (h) return h;
      } catch {
        /* cross-origin */
      }
      try {
        if (document.referrer) return new URL(document.referrer).hostname;
      } catch {
        /* unparsable referrer */
      }
      return location.hostname;
    })();

    let enabled = await enabledForSite(effectiveHost);

    const frameGateOk = (): boolean =>
      isTop ||
      (window.innerWidth >= MIN_FRAME_WIDTH &&
        window.innerWidth * window.innerHeight >= MIN_FRAME_AREA);

    let resizeArmed = false;
    const startWhenGated = (): void => {
      if (!enabled) return;
      if (frameGateOk()) {
        orchestrator.start();
        return;
      }
      // Lazy frames start collapsed and grow later (embeds, chat panes) —
      // retry once the frame is resized past the gate. Armed at most once.
      if (resizeArmed) return;
      resizeArmed = true;
      const onResize = (): void => {
        if (!enabled || !frameGateOk()) return;
        window.removeEventListener("resize", onResize);
        resizeArmed = false;
        orchestrator.start();
      };
      window.addEventListener("resize", onResize);
    };
    startWhenGated();

    // Options-page / popup changes must reach already-open tabs: recompute the
    // effective state whenever the global flag or the site rules change.
    const applyEnabled = async (): Promise<void> => {
      let v: boolean;
      try {
        v = await enabledForSite(effectiveHost);
      } catch {
        return; // storage gone (extension context invalidated) — keep current state
      }
      if (v === enabled) return;
      enabled = v;
      if (v) startWhenGated();
      else orchestrator.stop();
    };
    settings.enabled.watch(() => void applyEnabled());
    settings.siteOverrides.watch(() => void applyEnabled());

    if (docs) {
      if (docs.kind === "editor") {
        // Classic flow — kept as the fallback and as the "Open as page" action.
        const goToReadingPage = (): void => {
          try {
            sessionStorage.setItem(DOCS_RETURN_KEY, location.href);
          } catch {
            /* storage may be blocked — fallback return URL still works */
          }
          location.href = readingViewUrl(docs.id, currentTabParam(location));
        };

        const overlay = createDocsOverlay({
          id: docs.id,
          tab: currentTabParam(location),
          onClose: () => setEditorAction(),
          onOpenAsPage: goToReadingPage,
        });

        const openOverlay = async (): Promise<void> => {
          orchestrator.setFabAction("Loading document…");
          const ok = await overlay.open();
          if (!ok) {
            // Same-origin fetch failed (offline, consent wall) — the navigation
            // flow still works; never strand the user on a dead button.
            goToReadingPage();
            return;
          }
          orchestrator.setFabAction("Close reading mode", () => overlay.close());
        };

        function setEditorAction(): void {
          orchestrator.setFabAction(
            "Analyze document",
            () => void openOverlay(),
            { attention: true }, // the main toggle is useless on canvas — point here
          );
        }
        setEditorAction();
      } else {
        // Organic /mobilebasic visit via our marker: apply reading typography and
        // offer the way back to the exact editor tab.
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
            // Rescan must never force-start a disabled page or bypass the gate.
            if (enabled && frameGateOk()) orchestrator.rescan();
            return;

          case ACTIONS.SET_ENABLED:
            if (msg.value && !enabled) {
              enabled = true;
              startWhenGated(); // arms the resize retry for collapsed lazy frames
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
              flagged: orchestrator.flaggedCount(),
            };
            sendResponse(state);
            return; // synchronous response
          }

          case ACTIONS.TOGGLE_OVERLAY:
            if (enabled && frameGateOk()) orchestrator.toggle();
            return;

          case ACTIONS.ANALYZE_SELECTION:
            void analyzeSelection(); // works even where passive capture skips
            return;

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
