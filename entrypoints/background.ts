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
  ClearCacheReply,
  CopyDiagnosticsReply,
  ScoreBatchMessage,
  ScoreBatchReply,
  TopHostReply,
  UpdateBadgeMessage,
} from "../lib/messaging/protocol";
import { READER_PAGE, readerQuery } from "../lib/pdf/source";
import { t } from "../lib/i18n";

export default defineBackground(() => {
  const router = createRouter(getScoreClient());
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
  browser.tabs.onRemoved.addListener((tabId) => badgeText.delete(tabId));

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

  /** The reading-mode URL for a PDF. Not web accessible — only we may navigate to it. */
  const readerUrl = (src: string): string =>
    browser.runtime.getURL(READER_PAGE as PublicPath) + readerQuery(src);

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
      browser.contextMenus.create({
        id: "anagram-open-pdf",
        title: t("menuOpenPdf"),
        contexts: ["link"],
        targetUrlPatterns: [
          "*://*/*.pdf",
          "*://*/*.pdf?*",
          "*://*/*.PDF",
          "*://*/*.PDF?*",
          "file:///*.pdf",
          "file:///*.PDF",
        ],
      });
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
    void browser.tabs.sendMessage(tabId, { action: ACTIONS.ANALYZE_PAGE }).catch(() => undefined);
  };

  /**
   * "Copy page diagnostics". Only the TOP frame is asked: the report is the page's, and
   * its document is the one a clipboard write is measured against. The page answers
   * whether Anagram is running there or not — the content script is in every frame of
   * every page regardless — so "nothing shows up" on a switched-off site is answered with
   * "switched off" instead of with silence.
   */
  const copyDiagnostics = (tabId: number, frameId: number): void => {
    void browser.tabs
      .sendMessage(tabId, { action: ACTIONS.COPY_DIAGNOSTICS, frameId }, { frameId: 0 })
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
      // only when that tab was already the PDF.
      if (info.linkUrl) {
        void browser.tabs.create({
          url: readerUrl(info.linkUrl),
          index: tab ? tab.index + 1 : undefined,
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
    // Target the frame the selection lives in.
    void browser.tabs
      .sendMessage(tab.id, { action: ACTIONS.ANALYZE_SELECTION }, { frameId: info.frameId ?? 0 })
      .catch(() => undefined);
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
      if (tab?.id != null) {
        void browser.tabs.sendMessage(tab.id, { action }).catch(() => undefined);
      }
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
      };
      if (!msg) return;

      // Show the PDF reading mode IN PLACE of the PDF. The tab and the URL come off the
      // sender for a content script, and from the popup when it is the popup asking.
      if (msg.action === ACTIONS.OPEN_PDF_READER) {
        const tabId = msg.tabId ?? sender.tab?.id;
        const src = msg.url ?? sender.tab?.url;
        if (tabId != null && src) void browser.tabs.update(tabId, { url: readerUrl(src) });
        return;
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
      // guess — but the sender carries the tab's own URL (<all_urls> host permission).
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
        .handle(msg.req)
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
