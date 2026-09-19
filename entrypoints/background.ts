// entrypoints/background.ts — MV3 service worker.
// Registers a SINGLE runtime.onMessage listener SYNCHRONOUSLY at top level (MV3 wakes the
// worker by re-running this registration). It routes SCORE_BATCH → router.handle, answers
// GET_BACKEND_STATUS (is the daemon up?) and GET_TOP_HOST (which page is this frame in?),
// empties the score caches on CLEAR_CACHE and mirrors the per-tab flagged count onto the
// toolbar icon (UPDATE_BADGE). Popup control actions (RESCAN / SET_ENABLED / GET_TAB_STATE /
// RETRY_BACKEND) are addressed straight to the active tab's content script via
// tabs.sendMessage, so they do not pass through here.
import { defineBackground, browser } from "#imports";
import type { PublicPath } from "wxt/browser";
import { createRouter } from "../lib/backend/router";
import { getScoreClient, getDaemonClient } from "../lib/backend/getScoreClient";
import { ACTIONS } from "../lib/messaging/protocol";
import type {
  CacheCountReply,
  ClearCacheReply,
  CopyDiagnosticsReply,
  PdfPassOnceReply,
  ScoreBatchMessage,
  ScoreBatchReply,
  TopHostReply,
  UpdateBadgeMessage,
} from "../lib/messaging/protocol";
import { ensureInjected, installAccess } from "../lib/access/worker";
import { READER_PAGE, readerQuery } from "../lib/pdf/source";
import { shouldAutoOpen } from "../lib/pdf/route";
import { createPdfHandoff } from "../lib/pdf/handoff";
import { PDF_TAB_SCRIPTS_RUN } from "../lib/surface";
import { settings } from "../lib/settings/settings";
import { t } from "../lib/i18n";

export default defineBackground(() => {
  const router = createRouter(getScoreClient());
  // Site access is optional: the content script is registered for the origins the user has
  // granted and injected on demand where only activeTab applies (lib/access/worker.ts).
  installAccess();
  // Chrome MV3 exposes `action`; Firefox MV2 exposes `browserAction`. We only
  // need the two badge setters, so type just those.
  interface BadgeApi {
    setBadgeText(details: { tabId: number; text: string }): Promise<void> | void;
    setBadgeBackgroundColor(details: { tabId: number; color: string }): Promise<void> | void;
  }
  const b = browser as unknown as { action?: BadgeApi; browserAction?: BadgeApi };
  const actionApi: BadgeApi | undefined = b.action ?? b.browserAction;

  /** What each tab's badge is showing, so a transient flash can put back exactly that.
   *  The badge itself is the only other store, and reading it back races the scan that
   *  may write a new count while the tick is up. */
  const badgeText = new Map<number, string>();
  const COUNT_COLOR = "#dc2626";
  /** The copy said yes: a tick, on the green the chips already use for "human" — the
   *  badge's red is the chips' "AI generated" red for the same reason. */
  const FLASH_OK = { text: "✓", color: "#1a7f37" };
  /** And when nothing reached the clipboard, the same gesture says so instead of lying. */
  const FLASH_FAIL = { text: "!", color: COUNT_COLOR };
  const FLASH_MS = 1500;
  browser.tabs.onRemoved.addListener((tabId) => {
    badgeText.delete(tabId);
    dropPass(tabId);
    wants.delete(tabId);
    handoff.forget(tabId);
  });

  /**
   * Firefox only: `clipboardWrite` is declared OPTIONAL (see wxt.config.ts), so it has to
   * be asked for, and Firefox honours `permissions.request()` only from inside a
   * user-input handler — a context-menu click is one, but only until the first `await`.
   * So the answer is remembered here instead: the worker asks the browser once on wake,
   * and a reader who has already granted it is never prompted again. `null` means "not
   * known yet", which only costs a request that Firefox resolves without a prompt when
   * the permission is in fact already there.
   */
  const CLIPBOARD_OPTIONAL = (
    (browser.runtime.getManifest() as { optional_permissions?: string[] }).optional_permissions ?? []
  ).includes("clipboardWrite");
  let clipboardGranted: boolean | null = null;
  if (CLIPBOARD_OPTIONAL) {
    void browser.permissions?.contains({ permissions: ["clipboardWrite"] }).then(
      (has) => {
        clipboardGranted = has;
      },
      () => undefined,
    );
  }

  /**
   * Where "open this PDF with Anagram" goes: the reading mode, showing THAT PDF. The
   * ball's chip, the popup's button, the context menu and the automatic route all come
   * through this one function, so they cannot disagree — and none of them asks the network
   * anything first. The reader page is not web accessible, so only we may navigate to it.
   */
  const readerUrl = (src: string): string =>
    browser.runtime.getURL(READER_PAGE as PublicPath) + readerQuery(src);

  /**
   * The reading mode is HANDED the document's bytes (lib/pdf/handoff.ts): the tab that is
   * showing the PDF re-reads it, the worker holds it under a one-time ticket, and only
   * then does the tab become the reader. Nothing on the extension's own origin ever
   * fetches a remote address — which is what `connect-src` in wxt.config.ts enforces.
   *
   * `ensureInjected` is what makes this work with optional site access: on a site with no
   * grant there is no content script to ask, and the click the user just made — a menu
   * entry, the popup's button — is what gives us `activeTab` to put one there.
   */
  const handoff = createPdfHandoff({ readerUrl, ensureInjected });
  handoff.serve();

  /**
   * Tabs that were opened FOR the reading mode — the "Open PDF with Anagram" entry on a
   * link. The PDF has to load in the tab before its bytes can be read out of it, so the
   * tab is sent to the PDF and converts itself the moment it reports in, whatever "Open
   * PDFs in Anagram" is set to. One shot, like a pass.
   */
  const wants = new Set<number>();

  /**
   * Tabs allowed to show one PDF WITHOUT the reading mode opening over it: the reader's
   * "Open original", and the same way out of every line that says the file could not be
   * read. Per tab, one shot, and only in this worker's memory — a worker that was evicted
   * never held a pass, which is the same as not having one.
   */
  const passes = new Map<number, string>();
  /**
   * A pass is for ONE navigation, so a tab that goes anywhere else loses it. The listener
   * exists only while a pass does: an MV3 worker is woken by every listener it registers,
   * and being woken for every tab in the browser is not a price to pay for an empty map.
   */
  const forgetPassOnMove = (tabId: number, change: { url?: string }): void => {
    if (change.url !== undefined && change.url !== passes.get(tabId)) dropPass(tabId);
  };
  function dropPass(tabId: number): void {
    if (!passes.delete(tabId)) return;
    if (passes.size === 0) browser.tabs.onUpdated.removeListener(forgetPassOnMove);
  }
  function holdPass(tabId: number, url: string): void {
    if (passes.size === 0) browser.tabs.onUpdated.addListener(forgetPassOnMove);
    passes.set(tabId, url);
  }

  // Context menus; recreated idempotently on install/update. The PDF entry is offered on
  // LINKS to a .pdf, which is where a reader decides to open one — the tab that is
  // already showing a PDF is served by the ball's own action chip and by the popup.
  browser.runtime.onInstalled.addListener((details) => {
    void browser.contextMenus.removeAll().then(() => {
      browser.contextMenus.create({
        id: "anagram-analyze-selection",
        title: t("menuAnalyzeSelection"),
        contexts: ["selection"],
      });
      // The way into a page Anagram is switched off for, without switching it on: this
      // runs once in the tab and writes nothing.
      browser.contextMenus.create({
        id: "anagram-analyze-page",
        title: t("menuAnalyzePage"),
        contexts: ["page"],
      });
      // A page that shows nothing, described for whoever has to fix it. It sits next to
      // the entry above because that is where somebody reaches when a page stays silent,
      // and it answers on a switched-off site as well — "off" is one of the answers.
      browser.contextMenus.create({
        id: "anagram-copy-diagnostics",
        title: t("menuCopyDiagnostics"),
        contexts: ["page"],
      });
      // Only where a PDF tab admits a content script: the reading mode is handed the
      // bytes by the tab showing the document, and Firefox's viewer is a privileged page
      // no content script reaches, so there would be nobody to ask (lib/surface.ts).
      if (PDF_TAB_SCRIPTS_RUN) {
        browser.contextMenus.create({
          id: "anagram-open-pdf",
          title: t("menuOpenPdf"),
          contexts: ["link"],
          // http(s) only. A PDF on this computer cannot be read this way at all — the
          // bytes come from the tab showing the document and a file: page may not
          // re-read itself — so offering it on such a link would be an offer we cannot
          // keep. Those open through the reading mode's drop zone.
          targetUrlPatterns: ["*://*/*.pdf", "*://*/*.pdf?*", "*://*/*.PDF", "*://*/*.PDF?*"],
        });
      }
    });
    if (details.reason === "install") {
      void browser.tabs.create({ url: browser.runtime.getURL("/onboarding.html") });
    }
  });

  /**
   * "Analyze this page with Anagram": every frame of the tab is asked to analyze itself
   * once. The message goes to the whole tab, not one frame, because a page is its frames
   * too — each of them applies the usual size gate — and the content script decides what
   * "once" means for it: a running page re-scans, a switched-off one starts without any
   * setting or site rule being written.
   */
  const analyzePage = (tabId: number): void => {
    // The menu click carries `activeTab`, so this works on a site the user has granted
    // nothing for: ensureInjected puts the script there for this one page.
    void ensureInjected(tabId).then(() =>
      browser.tabs.sendMessage(tabId, { action: ACTIONS.ANALYZE_PAGE }).catch(() => undefined),
    );
  };

  /**
   * "Copy page diagnostics". Only the TOP frame is asked: the report is the page's, and
   * its document is the one a clipboard write is measured against. The page answers
   * whether Anagram is running there or not — the script is put into the page for this
   * one report if it is not there already — so "nothing shows up" on a switched-off site,
   * or on one nothing was ever granted for, is answered instead of met with silence.
   */
  const copyDiagnostics = (tabId: number, frameId: number): void => {
    void ensureInjected(tabId)
      .then(() =>
        browser.tabs.sendMessage(tabId, { action: ACTIONS.COPY_DIAGNOSTICS, frameId }, { frameId: 0 }),
      )
      .then((reply) => {
        // The tick is for the clipboard, not for the report: a page that built one and
        // could not copy it has to say so, or the reader pastes the last thing they cut.
        const r = reply as CopyDiagnosticsReply | undefined;
        flashBadge(tabId, r?.ok === true && r.via !== "none");
      })
      .catch(() => flashBadge(tabId, false));
  };

  /**
   * The only feedback this feature has: the toolbar badge shows a tick for a moment and
   * then goes back to the flagged count. Nothing new is drawn on the page, nothing is said
   * out loud, and the badge is already where a reader looks for this extension's state.
   */
  const flashBadge = (tabId: number, copied: boolean): void => {
    if (!actionApi) return;
    const flash = copied ? FLASH_OK : FLASH_FAIL;
    void actionApi.setBadgeBackgroundColor({ tabId, color: flash.color });
    void actionApi.setBadgeText({ tabId, text: flash.text });
    setTimeout(() => {
      // Whatever the tab is showing NOW, not what it showed when the tick went up: a scan
      // that finished during the flash has already sent its count, and that is the number
      // the reader must be left looking at.
      void actionApi.setBadgeBackgroundColor({ tabId, color: COUNT_COLOR });
      void actionApi.setBadgeText({ tabId, text: badgeText.get(tabId) ?? "" });
    }, FLASH_MS);
  };

  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "anagram-open-pdf") {
      // A linked PDF opens BESIDE the page it was linked from: the reader replaces a tab
      // only when that tab was already the PDF. The new tab is sent to the PDF itself,
      // because that is the only place its bytes can be read from — and it is marked as
      // wanting the reading mode, so it converts itself the moment it has loaded.
      if (info.linkUrl) {
        const src = info.linkUrl;
        const index = tab ? tab.index + 1 : undefined;
        void browser.tabs.create({ url: src, index }).then((opened) => {
          if (opened.id != null) wants.add(opened.id);
        });
      }
      return;
    }
    if (info.menuItemId === "anagram-analyze-page") {
      if (tab?.id != null) analyzePage(tab.id);
      return;
    }
    if (info.menuItemId === "anagram-copy-diagnostics") {
      if (tab?.id == null) return;
      const tabId = tab.id;
      const frameId = info.frameId ?? 0;
      if (!CLIPBOARD_OPTIONAL || clipboardGranted === true) {
        copyDiagnostics(tabId, frameId);
        return;
      }
      // FIRST USE ON FIREFOX. The request is made here, synchronously, because this
      // listener still counts as the user input that opened the menu and nothing after an
      // await would. Granted once, it sticks, and `clipboardGranted` spares every later
      // use even the question. Declined, the badge says so and nothing else happens —
      // there is no second place for this feature to nag from.
      void browser.permissions.request({ permissions: ["clipboardWrite"] }).then(
        (granted) => {
          clipboardGranted = granted;
          if (granted) copyDiagnostics(tabId, frameId);
          else flashBadge(tabId, false);
        },
        () => flashBadge(tabId, false),
      );
      return;
    }
    if (info.menuItemId !== "anagram-analyze-selection" || tab?.id == null) return;
    // Target the frame the selection lives in — after making sure there is a script in
    // the tab to receive it at all, which on an ungranted site the click itself allows.
    const tabId = tab.id;
    const frameId = info.frameId ?? 0;
    void ensureInjected(tabId).then(() =>
      browser.tabs
        .sendMessage(tabId, { action: ACTIONS.ANALYZE_SELECTION }, { frameId })
        .catch(() => undefined),
    );
  });

  // Keyboard commands, forwarded to the active tab. The message reaches every frame;
  // which of them may act on it is the content script's own rule (the overlay is
  // per-frame, the panel and the flagged walk belong to the top frame).
  const COMMAND_ACTIONS: Record<string, string> = {
    "toggle-overlay": ACTIONS.TOGGLE_OVERLAY,
    "open-panel": ACTIONS.OPEN_PANEL,
    "next-flagged": ACTIONS.NEXT_FLAGGED,
    "prev-flagged": ACTIONS.PREV_FLAGGED,
  };
  browser.commands?.onCommand.addListener((command) => {
    const action = COMMAND_ACTIONS[command];
    if (!action) return;
    void browser.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
      if (tab?.id == null) return;
      const tabId = tab.id;
      // A command grants `activeTab`, so the overlay toggle answers on a page the user
      // has granted nothing for as well.
      void ensureInjected(tabId).then(() =>
        browser.tabs.sendMessage(tabId, { action }).catch(() => undefined),
      );
    });
  });

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
        probe?: boolean;
        url?: string;
        tabId?: number;
        contentType?: string;
        protocol?: string;
        navigationType?: string;
      };
      if (!msg) return;

      // The popup's "Analyze this page": the context-menu entry by another door. Only an
      // extension page of our own may name a tab. A content script's message comes from
      // the web page's address, and a page has no business starting a run in somebody
      // else's tab; `sender.tab` cannot tell the two apart, because one of our own pages
      // opened in a tab has one too.
      if (msg.action === ACTIONS.ANALYZE_TAB) {
        const ours = sender.url?.startsWith(browser.runtime.getURL("/" as PublicPath)) === true;
        if (ours && typeof msg.tabId === "number") analyzePage(msg.tabId);
        return;
      }

      // Open this PDF the Anagram way, IN PLACE of the PDF. The tab and the URL come off
      // the sender for a content script, and from the popup when it is the popup asking.
      if (msg.action === ACTIONS.OPEN_PDF_READER) {
        const tabId = msg.tabId ?? sender.tab?.id;
        const src = msg.url ?? sender.tab?.url;
        if (tabId != null && src) void handoff.open(tabId, src, { auto: false });
        return;
      }

      // "Open PDFs in Anagram": a tab showing a PDF has told us what it is looking at.
      // The tab moved is the SENDER's — never the active one, because a PDF opened in a
      // background tab by a middle click reports from there and must move itself.
      if (msg.action === ACTIONS.PDF_TAB_OPENED) {
        const tabId = sender.tab?.id;
        const src = msg.url;
        if (tabId == null || !src) return;
        void (async () => {
          // The pass is spent on the load it was written for, whatever is decided next.
          const pass = passes.get(tabId) === src;
          if (pass) dropPass(tabId);
          // …and so is a tab opened by the menu entry for exactly this, which is a
          // reader's explicit "open it with Anagram" and not the automatic route.
          const wanted = wants.delete(tabId);
          const open = shouldAutoOpen({
            // Read now, not at startup: the switch has to take effect on the next PDF.
            setting: wanted || (await settings.autoOpenPdfs.getValue()),
            contentType: msg.contentType ?? "",
            protocol: msg.protocol ?? "",
            navigationType: msg.navigationType ?? "",
            frame: sender.frameId ?? 0,
            pass,
          });
          if (!open) return;
          await handoff.open(tabId, src, { auto: !wanted });
        })();
        return;
      }

      // The reader is leaving for the PDF itself. It waits for this answer before it
      // navigates, or the tab could arrive back at the PDF before the pass is written.
      if (msg.action === ACTIONS.PDF_PASS_ONCE) {
        const tabId = sender.tab?.id;
        if (tabId != null && msg.url) holdPass(tabId, msg.url);
        const reply: PdfPassOnceReply = { ok: tabId != null };
        sendResponse(reply);
        return; // synchronous response
      }

      // The options page asked for the cached verdicts to go. The worker's own layers are
      // emptied first — memory, pending writes and the IndexedDB store — and then every
      // open tab is told to drop its per-tab layer, so the next scan anywhere asks the
      // daemon again. A tab with no content script (chrome:// pages, the web store) has
      // nothing to drop and its rejection is swallowed.
      if (msg.action === ACTIONS.CLEAR_CACHE) {
        void (async () => {
          try {
            await router.clear();
            for (const tab of await browser.tabs.query({})) {
              if (tab.id == null) continue;
              void browser.tabs
                .sendMessage(tab.id, { action: ACTIONS.CACHE_CLEARED })
                .catch(() => undefined);
            }
          } catch {
            /* the store would not open, or tabs could not be listed — the memory layer
               is empty either way, and the page says so */
          }
          const reply: ClearCacheReply = { ok: true };
          sendResponse(reply);
        })();
        return true;
      }

      // The options page asks how many verdicts are on the disk.
      if (msg.action === ACTIONS.GET_CACHE_COUNT) {
        router.count().then(
          (entries) => sendResponse({ entries } satisfies CacheCountReply),
          () => sendResponse({ entries: 0 } satisfies CacheCountReply),
        );
        return true;
      }

      // Per-tab flagged count on the toolbar icon (sent by the TOP frame only).
      if (msg.action === ACTIONS.UPDATE_BADGE) {
        const tabId = sender.tab?.id;
        if (tabId != null && actionApi) {
          const flagged = typeof msg.flagged === "number" ? msg.flagged : 0;
          const text = flagged > 0 ? String(flagged) : "";
          badgeText.set(tabId, text);
          void actionApi.setBadgeText({ tabId, text });
          void actionApi.setBadgeBackgroundColor({ tabId, color: COUNT_COLOR });
        }
        return;
      }

      // A subframe asking whose page it sits in. Site rules are keyed on the TOP
      // hostname, which a cross-origin frame cannot read and a no-referrer embed cannot
      // guess — but the sender carries the tab's own URL, which is ours to read wherever
      // a content script of ours is running at all.
      if (msg.action === ACTIONS.GET_TOP_HOST) {
        let host = "";
        try {
          if (sender.tab?.url) host = new URL(sender.tab.url).hostname;
        } catch {
          /* about:blank and friends have no hostname — the frame keeps its fallbacks */
        }
        const reply: TopHostReply = { host };
        sendResponse(reply);
        return; // synchronous response
      }

      // Popup/options/content: is the daemon up (optionally a forced re-probe).
      if (msg.action === ACTIONS.GET_BACKEND_STATUS) {
        getDaemonClient()
          .status(msg.probe === true)
          .then((s) => sendResponse(s), () => sendResponse(undefined));
        return true;
      }

      if (msg.action !== ACTIONS.SCORE_BATCH || !msg.req) return;

      router
        // A private tab's work leaves nothing on the disk (lib/backend/router.ts).
        .handle(msg.req, { private: sender.tab?.incognito === true })
        .then((resp) => {
          const up = getDaemonClient().isUp();
          const reply: ScoreBatchReply = { results: resp.results, model: up ? resp.model : undefined, backend: up ? "up" : "down" };
          sendResponse(reply);
        })
        .catch(() => {
          const reply: ScoreBatchReply = { results: [], backend: getDaemonClient().isUp() ? "up" : "down" };
          sendResponse(reply);
        });

      return true; // keep the channel open for the async sendResponse
    },
  );
});
