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
import { getScoreClient } from "../lib/backend/getScoreClient";
import { createCacheModeController } from "../lib/backend/cacheMode";
import { ACTIONS } from "../lib/messaging/protocol";
import type {
  CacheCountReply,
  ClearCacheReply,
  CopyDiagnosticsReply,
  PdfPassOnceReply,
  ScoreBatchReply,
  TopHostReply,
} from "../lib/messaging/protocol";
import { ensureInjected, installAccess } from "../lib/access/worker";
import { documentAuthority } from "../lib/access/authority";
import { invalidateAndNotify } from "../lib/access/cacheControls";
import { callerRole, parseWorkerMessage, permitsMessage, type AccessSender } from "../lib/access/messages";
import { READER_PAGE, readerQuery } from "../lib/pdf/source";
import { createPdfNavigation } from "../lib/pdf/navigation";
import { createPdfHandoff } from "../lib/pdf/handoff";
import { PDF_TAB_SCRIPTS_RUN } from "../lib/surface";
import { settings, cacheModeStorage } from "../lib/settings/settings";
import { t } from "../lib/i18n";
import { handleNativePageMessage } from "../lib/backend/nativeBridge";
import { NATIVE_MESSAGE, NATIVE_UNINSTALL } from "../lib/backend/nativeProtocol";
const EXTENSION_UPDATE_KEY = "extensionUpdatePending";

export default defineBackground(() => {
  // A native port can keep this worker alive. Preserve an available extension
  // update for Settings rather than interrupting analysis with an automatic reload.
  browser.runtime.onUpdateAvailable.addListener((details) => {
    void browser.storage.local.set({ [EXTENSION_UPDATE_KEY]: details.version });
  });
  const router = createRouter(getScoreClient());
  const cacheModes=createCacheModeController((mode)=>invalidateAndNotify(()=>router.setCacheMode(mode)),cacheModeStorage);
  // Do not dispatch scoring until persisted privacy preferences have been applied.
  const cacheModeReady=cacheModes.restore();
  void cacheModeReady.catch(()=>console.warn("Anagram could not clear stored verdicts; disk writes remain disabled"));
  cacheModeStorage.watch(()=>{void cacheModes.restore().catch(()=>console.warn("Anagram cache mode change failed"));});
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
    pdfNavigation.forget(tabId);
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

  const handoff = createPdfHandoff({ readerUrl, ensureInjected });
  handoff.serve();
  const pdfNavigation = createPdfNavigation({setting: () => settings.autoOpenPdfs.getValue(), open: handoff.open});
  pdfNavigation.serve();
  const wants = new Set<number>();

  // Context menus; recreated idempotently on install/update. The PDF entry is offered on
  // LINKS to a .pdf, which is where a reader decides to open one — the tab that is
  // already showing a PDF is served by the ball's own action chip and by the popup.
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install" || details.reason === "update") {
      void browser.storage.local.remove(EXTENSION_UPDATE_KEY);
    }
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

  async function handleMessage(message: unknown, sender: AccessSender): Promise<unknown> {
    const raw=message as {action?:unknown}|null;
    if (raw?.action === NATIVE_MESSAGE || raw?.action === NATIVE_UNINSTALL) {
      return handleNativePageMessage(message,sender,{invalidate:()=>getScoreClient().invalidate(),clear:()=>invalidateAndNotify(()=>router.clear())});
    }
    const msg=parseWorkerMessage(message);
    if (!msg) return {ok:false,error:"invalid_request"};
    const role=callerRole(sender,browser.runtime.id,browser.runtime.getURL("/"));
    if (!role || !permitsMessage(role,msg,sender)) return {ok:false,error:"forbidden"};
    const needsDocument=role === "content" || role === "reader" || role === "paste";
    const document=needsDocument ? await documentAuthority.authorize(sender,"session" in msg ? msg.session : undefined) : null;
    if (needsDocument && (!document || document.signal.aborted)) return {ok:false,error:"forbidden"};
    switch(msg.action) {
      case ACTIONS.ANALYZE_TAB:
        analyzePage(msg.tabId); return {ok:true};
      case ACTIONS.OPEN_PDF_READER: {
        const tabId=role === "popup" ? msg.tabId! : sender.tab!.id!;
        const src=role === "popup" ? msg.url! : sender.url!;
        return handoff.open(tabId,src,{auto:false});
      }
      case ACTIONS.GET_PDF_STATUS:
        return pdfNavigation.status(msg.tabId);
      case ACTIONS.PDF_TAB_OPENED: {
        const tabId=sender.tab!.id!;
        if(document!.signal.aborted)return {ok:false,error:"forbidden"};
        await pdfNavigation.contentPdf(tabId,sender.url!,msg.navigationType,wants.delete(tabId));
        return {ok:true};
      }
      case ACTIONS.PDF_PASS_ONCE: {
        const src=new URL(sender.url!).searchParams.get("src");
        if(src !== msg.url)return {ok:false} satisfies PdfPassOnceReply;
        pdfNavigation.pass(sender.tab!.id!,msg.url); return {ok:true} satisfies PdfPassOnceReply;
      }
      case ACTIONS.SET_CACHE_MODE:
        try {
          await cacheModeReady.catch(()=>undefined);
          const mode=await cacheModes.change(msg.mode);
          return {ok:true,mode};
        } catch {
          return {ok:false,mode:cacheModes.mode(),error:"cache_mode_failed"};
        }
      case ACTIONS.CLEAR_CACHE:
        try {
          await invalidateAndNotify(()=>router.clear());
          return {ok:true} satisfies ClearCacheReply;
        } catch {return {ok:false,error:"clear_failed"} satisfies ClearCacheReply;}
      case ACTIONS.GET_CACHE_COUNT:
        try {return {entries:await router.count()} satisfies CacheCountReply;}
        catch {return {entries:null,error:"count_failed"} satisfies CacheCountReply;}
      case ACTIONS.UPDATE_BADGE: {
        const tabId=sender.tab!.id!;
        if(actionApi) {
          const text=msg.flagged>0 ? String(msg.flagged) : "";
          badgeText.set(tabId,text);
          void actionApi.setBadgeText({tabId,text});
          void actionApi.setBadgeBackgroundColor({tabId,color:COUNT_COLOR});
        }
        return {ok:true};
      }
      case ACTIONS.GET_TOP_HOST: {
        let host="";
        try {host=new URL(sender.tab?.url ?? "").hostname;}catch {/* no readable top URL */}
        return {host} satisfies TopHostReply;
      }
      case ACTIONS.GET_BACKEND_STATUS:
        return getScoreClient().status(msg.probe===true);
      case ACTIONS.SCORE_BATCH: {
        try {
          await cacheModeReady.catch(()=>undefined);
          const resp=await router.handle(msg.req,{private:sender.tab?.incognito===true,documentKey:document!.documentKey,signal:document!.signal});
          if(document!.signal.aborted)return {ok:false,error:"forbidden"};
          const hasModel=resp.model.id !== "none";
          // Known cached verdicts remain usable while the native model is unloaded.
          const up=getScoreClient().isUp() || (hasModel && resp.results.some((result)=>!result.degraded));
          return {results:resp.results,model:up && hasModel ? resp.model : undefined,backend:up ? "up" : "down"} satisfies ScoreBatchReply;
        } catch {return {results:[],backend:getScoreClient().isUp() ? "up" : "down"} satisfies ScoreBatchReply;}
      }
    }
  }
  browser.runtime.onMessage.addListener((message:unknown,sender,sendResponse) => {
    void handleMessage(message,sender).then(sendResponse,()=>sendResponse({ok:false,error:"request_failed"}));
    return true;
  });
});
