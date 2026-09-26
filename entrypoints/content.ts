import { sendDocumentMessage } from "../lib/access/session";
// entrypoints/content.ts — main content script.
// Runs in EVERY frame (allFrames): the top frame gets the full experience (FAB,
// Docs actions, popup state); subframes run a chrome-less pipeline so framed
// article content (webmail readers, embedded posts) is scored too — gated on
// frame size so ad slots and tracking pixels never pay for a walk.
import { defineContentScript, browser } from "#imports";
import { createOrchestrator } from "../lib/capture/orchestrator";
import { effectiveRule, enabledForSite, settings } from "../lib/settings/settings";
import { NO_RULE, oneShotEnds, ruleState, type RuleState } from "../lib/settings/oneShot";
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
import { t } from "../lib/i18n";
import { ACTIONS } from "../lib/messaging/protocol";
import type { ControlMessage, PingReply, TabState, TopHostReply } from "../lib/messaging/protocol";
import { serveTabPdfBytes } from "../lib/pdf/handoff";
import { isPageTranslated, watchPageTranslation } from "../lib/dom/translation";

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
      sendDocumentMessage({ action: ACTIONS.GET_TOP_HOST }),
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

/**
 * How this document was reached — "navigate", "reload", "back_forward" or "prerender".
 * It decides one thing: the reading mode REPLACES the tab, so the PDF stays in history,
 * and a reader who presses Back to get out of it lands on the PDF again. Opening the
 * reading mode a second time there would take the Back button away from them entirely.
 */
function navigationType(): string {
  try {
    const [nav] = performance.getEntriesByType("navigation") as PerformanceNavigationTiming[];
    return nav?.type ?? "navigate";
  } catch {
    return "navigate"; // no navigation timing at all — treat it as an ordinary visit
  }
}

/**
 * This document already has a content script. The worker injects into tabs of a newly
 * granted origin and into a tab it has only `activeTab` for (lib/access/worker.ts), and
 * either can land on a page the registration has already reached — a second orchestrator
 * on the same document would mean two balls and two chips per paragraph. The flag lives
 * in the isolated world, which every injection of this extension shares.
 */
const ALREADY_RUNNING = "__anagramContentScript";

/**
 * This script was put here for ONE action — a context-menu entry, a keyboard command —
 * on a site nothing has been granted for, so it must behave exactly as it does on a site
 * the user has switched off: present, answering, and analyzing nothing until asked. The
 * worker sets the flag just before it injects (lib/access/worker.ts); it is cleared again
 * below if that site is later granted, which is why it is read live rather than copied.
 */
const ON_DEMAND = "__anagramOnDemand";

export default defineContentScript({
  // Registered at RUNTIME, not in the manifest: Anagram installs with access to no site
  // and the registration follows what the user grants (lib/access/worker.ts). `matches`
  // is what this script may ever run on, not what it is declared on.
  registration: "runtime",
  matches: ["<all_urls>"],
  runAt: "document_end",
  allFrames: true,
  async main(ctx) {
    const world = window as unknown as Record<string, boolean>;
    if (world[ALREADY_RUNNING]) return;
    const isTop = window.self === window.top;
    // A sandboxed frame has no origin, so no grant covers it and the worker answers none of
    // its requests (pageAddress in lib/access/messages.ts). The registration reaches it all
    // the same, through the origin its page gave it before the sandbox took it away.
    if (!isTop && window.origin === "null") return;
    world[ALREADY_RUNNING] = true;
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
      // The panel's "Turn off on <host>" writes the rule; this page stops here and now.
      // It has to, because the write is not always a change: on a site whose rule already
      // says "off" — where the only way to be looking at the panel is a one-shot run from
      // the context menu — storage takes the same value again and no watch ever fires.
      onSiteOff: () => {
        enabled = false;
        onceForPage = false;
        orchestrator.stop();
      },
    });

    // Site rules are keyed on the TOP page's hostname — that is what the popup writes.
    // The top frame knows it outright; a cross-origin frame has to ask the worker, which
    // sees the tab's URL on the sender. Only if the worker says nothing does the old
    // chain apply: the referrer (empty under a no-referrer policy, which is exactly the
    // case that used to let an embed ignore its host page's rule), then the frame itself.
    const effectiveHost = isTop ? location.hostname : await resolveFrameHost();

    /** What the settings say for this page — "off" while this is a one-action injection
     *  into a site with no grant, whatever the rules say about the host. */
    const siteEnabled = async (): Promise<boolean> =>
      world[ON_DEMAND] ? false : enabledForSite(effectiveHost);

    let enabled = await siteEnabled();
    /**
     * The user asked for THIS page from the context menu although the settings say no.
     * The run belongs to the page, not to the settings: it lasts until the tab navigates
     * away (a new document runs a new content script) and nothing is stored, so the site
     * is off again next time. Only turning this very site off ends it early.
     */
    let onceForPage = false;
    /** What the rules said for this site when that run began — the baseline the watches
     *  compare against, so an off rule that was already there ends nothing. */
    let onceBaseline: Promise<RuleState> = Promise.resolve(NO_RULE);

    /** Begin such a run. Nothing is written: the page is analyzed and the site is off
     *  again next time. Both doors into it — the menu entry / the popup's button, and the
     *  toggle shortcut pressed where there is nothing to toggle — come through here. */
    const startOnce = (): void => {
      enabled = true;
      onceForPage = true;
      // Read the rules as they are NOW: the run is measured against this, so only a later
      // change to them can end it.
      onceBaseline = effectiveRule(effectiveHost).then(ruleState, () => NO_RULE);
      startWhenGated();
    };

    /**
     * The browser has translated this page (lib/dom/translation.ts). What is on it now is
     * the translator's text, so nothing is read, and nothing that was read stays up, until
     * the reader shows the original again — whatever the settings say.
     */
    let translated = isPageTranslated();

    const frameGateOk = (): boolean =>
      isTop ||
      (window.innerWidth >= MIN_FRAME_WIDTH &&
        window.innerWidth * window.innerHeight >= MIN_FRAME_AREA);

    /**
     * What the reader last opened the context menu on. "Copy page diagnostics" describes
     * the region they were pointing at, and the menu API hands an extension the FRAME a
     * click was in and nothing finer — so the page has to remember the element itself.
     * Held weakly: a feed replaces its DOM constantly and this must never be the reason a
     * removed post stays in memory.
     */
    let menuTarget: WeakRef<Element> | null = null;
    if (isTop) {
      window.addEventListener(
        "contextmenu",
        (e) => {
          // composedPath: inside an open shadow root e.target retargets to the outer host,
          // which would put every click on a web component at the top of the component.
          const el = e.composedPath()[0];
          menuTarget = el instanceof Element ? new WeakRef(el) : null;
        },
        { capture: true, passive: true },
      );
    }

    let resizeArmed = false;
    const startWhenGated = (): void => {
      if (!enabled || translated) return;
      if (frameGateOk()) {
        orchestrator.start();
        return;
      }
      // Lazy frames start collapsed and grow later (embeds, chat panes) —
      // retry once the frame is resized past the gate. Armed at most once.
      if (resizeArmed) return;
      resizeArmed = true;
      const onResize = (): void => {
        if (!enabled || translated || !frameGateOk()) return;
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
        v = await siteEnabled();
        if (!v && onceForPage) {
          // A one-shot run was asked for on this page, so a change elsewhere — another
          // site's rule, the global default — must not silently stop it. Only this site
          // being turned off DURING the run does, and then it is over for good: the rule
          // that was already there when it started is the very reason it was asked for.
          const [started, now] = await Promise.all([
            onceBaseline,
            effectiveRule(effectiveHost).then(ruleState),
          ]);
          if (!oneShotEnds(started, now)) return;
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

    watchPageTranslation((now) => {
      translated = now;
      if (now) {
        // A run asked for once was for the page as it was: it ends here, as it would if the
        // site were switched off (the settings say off, or it would not be a one-off), and
        // the one-off authorization goes with the stopped run.
        if (onceForPage) {
          onceForPage = false;
          enabled = false;
        }
        orchestrator.stop();
      } else {
        startWhenGated();
      }
    });

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
          orchestrator.setFabAction(t("actionLoadingDocument"));
          const ok = await overlay.open();
          if (!ok) {
            // Same-origin fetch failed (offline, consent wall) — the navigation
            // flow still works; never strand the user on a dead button.
            goToReadingPage();
            return;
          }
          orchestrator.setFabAction(t("actionCloseReading"), () => overlay.close());
        };

        function setEditorAction(): void {
          orchestrator.setFabAction(
            t("actionAnalyzeDocument"),
            () => void openOverlay(),
            { attention: true }, // the main toggle is useless on canvas — point here
          );
        }
        setEditorAction();
      } else {
        // Organic /mobilebasic visit via our marker: apply reading typography and
        // offer the way back to the exact editor tab.
        if (isReadingMarked(location)) applyDocsReadingStyle();
        orchestrator.setFabAction(t("actionBackToEditor"), () => {
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
      // Chromium remote PDFs can relay their own current URL with same-origin cookies.
      serveTabPdfBytes();
      // The worker navigates the tab: an extension page the content script could reach
      // by itself would have to be web accessible, and the reader must not be.
      orchestrator.setFabAction(
        t("actionAnalyzePdf"),
        () => void sendDocumentMessage({ action: ACTIONS.OPEN_PDF_READER }).catch(() => undefined),
        { attention: true }, // nothing on this page can be scored — point at the way out
      );
      // And "Open PDFs in Anagram", which is the same journey without the click. What this
      // page knows is reported; the worker decides (lib/pdf/route.ts), because the setting,
      // the one-shot pass out of the reader and the back/forward rule all live there.
      void sendDocumentMessage({
          action: ACTIONS.PDF_TAB_OPENED,
          url: location.href,
          contentType: document.contentType,
          protocol: location.protocol,
          navigationType: navigationType(),
        })
        .catch(() => undefined);
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
          case ACTIONS.PING: {
            // The worker's probe before it injects (lib/access/worker.ts). Answered by
            // the top frame only, which is the frame it asks.
            if (!isTop) return;
            const reply: PingReply = { ok: true };
            sendResponse(reply);
            return; // synchronous response
          }

          case ACTIONS.ACCESS_GRANTED:
            // The site this page is on has just been granted. The flag the worker set
            // before it injected is gone, so the settings decide from here — and this is
            // the only nudge a page that is already open ever gets.
            world[ON_DEMAND] = false;
            void applyEnabled();
            return;

          case ACTIONS.RESCAN:
            // Rescan must never force-start a disabled page or bypass the gate.
            if (enabled && !translated && frameGateOk()) orchestrator.rescan();
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
              if (!translated && frameGateOk()) orchestrator.rescan();
            } else {
              startOnce();
            }
            return;

          case ACTIONS.COPY_DIAGNOSTICS: {
            // One report per tab, from the frame that owns the page — and answered whether
            // Anagram is analyzing here or not, because "switched off for this site" is
            // one of the things the reader is trying to find out. The module is imported
            // on demand so a page that never asks does not carry it through its boot.
            if (!isTop) return;
            void (async () => {
              try {
                const { copyPageDiagnostics } = await import("../lib/diagnostics");
                sendResponse(
                  await copyPageDiagnostics({
                    host: effectiveHost,
                    running: enabled && !translated,
                    onceForPage,
                    translated,
                    pdf: isPdf,
                    docs: docs?.kind ?? null,
                    counts: {
                      scored: orchestrator.scoredCount(),
                      flagged: orchestrator.flaggedCount(),
                      unsupported: orchestrator.unsupportedCount(),
                      unavailable: orchestrator.unavailableCount(),
                    },
                    frameGate: { minWidth: MIN_FRAME_WIDTH, minArea: MIN_FRAME_AREA },
                    clickedFrameId: msg.frameId ?? 0,
                    target: menuTarget?.deref() ?? null,
                  }),
                );
              } catch {
                // A page that tore the extension context down mid-build, or a document
                // with no body at all: the worker leaves the badge alone and the reader
                // simply sees nothing happen.
                sendResponse({ ok: false, bytes: 0, via: "none" });
              }
            })();
            return true; // the answer is asynchronous
          }

          case ACTIONS.GET_TAB_STATE: {
            // tabs.sendMessage broadcasts to every frame — only the TOP frame
            // answers, so the popup's count is the page's, not some iframe's.
            if (!isTop) return;
            const state: TabState = {
              enabled,
              translated,
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
            // The toggle shortcut. On a page Anagram is off for there is no overlay to
            // show or hide, and the key used to do nothing at all — on a fresh install,
            // where no site is granted, that is every page. It now does what the popup's
            // button does there instead: one run, nothing written (the command carries
            // `activeTab`, so the worker could put a script here in the first place).
            if (!enabled) startOnce();
            else if (!translated && frameGateOk()) orchestrator.toggle();
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
