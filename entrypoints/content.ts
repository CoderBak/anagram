// entrypoints/content.ts — main content script.
// Runs in EVERY frame (allFrames): the top frame gets the full experience (FAB,
// Docs actions, popup state); subframes run a chrome-less pipeline so framed
// article content (webmail readers, embedded posts) is scored too — gated on
// frame size so ad slots and tracking pixels never pay for a walk.
import { defineContentScript, browser } from "#imports";
import { createOrchestrator } from "../lib/capture/orchestrator";
import { effectiveRule, enabledForSite, settings } from "../lib/settings/settings";
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
import type { ControlMessage, TabState, TopHostReply } from "../lib/messaging/protocol";

/** Min frame viewport for a subframe to be worth scanning (ad slots are smaller). */
const MIN_FRAME_AREA = 40_000; // e.g. 400×100
const MIN_FRAME_WIDTH = 200;
/** How long a subframe waits for the worker's answer before falling back. A sleeping
 *  MV3 worker normally wakes in tens of ms; nothing here is worth stalling a scan for. */
const TOP_HOST_TIMEOUT_MS = 1000;

/**
 * Which page is this SUBFRAME embedded in? The same-origin shortcut comes first (no
 * round trip at all), then the worker, which reads the tab's URL off the sender —
 * the only source an `referrerpolicy="no-referrer"` embed cannot take away.
 */
async function resolveFrameHost(): Promise<string> {
  try {
    const h = window.top?.location.hostname; // same-origin frames only
    if (h) return h;
  } catch {
    /* cross-origin */
  }
  try {
    const reply = (await Promise.race([
      browser.runtime.sendMessage({ action: ACTIONS.GET_TOP_HOST }),
      new Promise<undefined>((r) => setTimeout(() => r(undefined), TOP_HOST_TIMEOUT_MS)),
    ])) as TopHostReply | undefined;
    if (reply?.host) return reply.host;
  } catch {
    /* worker asleep mid-restart, or the extension context is gone */
  }
  try {
    if (document.referrer) return new URL(document.referrer).hostname;
  } catch {
    /* unparsable referrer */
  }
  return location.hostname;
}

export default defineContentScript({
  matches: ["<all_urls>"],
  runAt: "document_end",
  allFrames: true,
  async main(ctx) {
    const isTop = window.self === window.top;
    // Google Docs (top frame only): the editor is a canvas (no DOM text) — the
    // FAB's action opens our in-tab analyzed reading overlay instead.
    const docs = isTop ? detectDocsPage(location) : null;
    // A PDF tab: Chrome wraps the plugin in an outer HTML document that content scripts
    // do run in, and that document holds a single <embed> and no text at all. So there
    // is nothing to scan here — the walk finds nothing and costs nothing — and the whole
    // feature is the ball's action chip, which hands the file to our reader page.
    const isPdf = isTop && !docs && document.contentType === "application/pdf";
    const orchestrator = createOrchestrator(ctx, {
      mountFab: isTop,
      lockScope: docs?.kind === "editor" ? "page" : undefined,
    });

    // Site rules are keyed on the TOP page's hostname — that is what the popup writes.
    // The top frame knows it outright; a cross-origin frame has to ask the worker, which
    // sees the tab's URL on the sender. Only if the worker says nothing does the old
    // chain apply: the referrer (empty under a no-referrer policy, which is exactly the
    // case that used to let an embed ignore its host page's rule), then the frame itself.
    const effectiveHost = isTop ? location.hostname : await resolveFrameHost();

    let enabled = await enabledForSite(effectiveHost);
    /**
     * The user asked for THIS page from the context menu although the settings say no.
     * The run belongs to the page, not to the settings: it lasts until the tab navigates
     * away (a new document runs a new content script) and nothing is stored, so the site
     * is off again next time. Only an explicit "off" for this very site ends it early.
     */
    let onceForPage = false;

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
        if (!v && onceForPage) {
          // A one-shot run was asked for on this page, so a change elsewhere — another
          // site's rule, the global default — must not silently stop it. Only a rule that
          // turns THIS site off does, and then the one-shot is over for good.
          const rule = await effectiveRule(effectiveHost);
          if (rule?.mode !== "off") return;
          onceForPage = false;
        }
      } catch {
        return; // storage gone (extension context invalidated) — keep current state
      }
      // The settings now ask for what the page is already doing, so the run stands on its
      // own and follows them from here on.
      if (v) onceForPage = false;
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

    if (isPdf) {
      // The worker navigates the tab: an extension page the content script could reach
      // by itself would have to be web accessible, and the reader must not be.
      orchestrator.setFabAction(
        "Analyze PDF",
        () => void browser.runtime.sendMessage({ action: ACTIONS.OPEN_PDF_READER }).catch(() => undefined),
        { attention: true }, // nothing on this page can be scored — point at the way out
      );
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
              onceForPage = false; // the user turning this site off outranks the menu
              orchestrator.stop();
            }
            return;

          case ACTIONS.ANALYZE_PAGE:
            // "Analyze this page with Anagram". A page already being analyzed treats it as
            // a Rescan; a page Anagram is off for starts here and now — the frame gate
            // still decides for a subframe, and nothing is written to storage.
            if (enabled) {
              if (frameGateOk()) orchestrator.rescan();
            } else {
              enabled = true;
              onceForPage = true;
              startWhenGated();
            }
            return;

          case ACTIONS.GET_TAB_STATE: {
            // tabs.sendMessage broadcasts to every frame — only the TOP frame
            // answers, so the popup's count is the page's, not some iframe's.
            if (!isTop) return;
            const state: TabState = {
              enabled,
              hostname: location.hostname,
              pdf: isPdf,
              scored: orchestrator.scoredCount(),
              flagged: orchestrator.flaggedCount(),
              unsupported: orchestrator.unsupportedCount(),
              unavailable: orchestrator.unavailableCount(),
            };
            sendResponse(state);
            return; // synchronous response
          }

          case ACTIONS.TOGGLE_OVERLAY:
            if (enabled && frameGateOk()) orchestrator.toggle();
            return;

          // The remaining keyboard commands are the PAGE's, not a frame's: the panel and
          // the ball live in the top frame, and so does the walk through its verdicts.
          case ACTIONS.OPEN_PANEL:
            if (isTop && enabled) orchestrator.openPanel();
            return;

          case ACTIONS.NEXT_FLAGGED:
            if (isTop && enabled) orchestrator.jumpFlagged(1);
            return;

          case ACTIONS.PREV_FLAGGED:
            if (isTop && enabled) orchestrator.jumpFlagged(-1);
            return;

          case ACTIONS.ANALYZE_SELECTION:
            void analyzeSelection(); // works even where passive capture skips
            return;

          case ACTIONS.RETRY_BACKEND:
            if (enabled) orchestrator.retryBackend();
            return;

          case ACTIONS.CACHE_CLEARED:
            // Every frame drops its own layer, running or not: a frame that starts later
            // must not serve verdicts the user has just thrown away.
            orchestrator.forgetCached();
            return;

          case ACTIONS.TEARDOWN:
            enabled = false;
            onceForPage = false;
            orchestrator.stop();
            return;

          default:
            return;
        }
      },
    );
  },
});
