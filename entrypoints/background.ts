import { toolbarBadge, type BadgeApi } from "../lib/ui/toolbarBadge";
import { nativeSetupRelease } from "../lib/backend/engineChoice";
import { defaultRelease, listDetectorReleases, resolveDetectorRelease, setupCatalog } from "../lib/detectorReleases";
// entrypoints/background.ts — MV3 service worker.
// Registers a SINGLE runtime.onMessage listener SYNCHRONOUSLY at top level (MV3 wakes the
// worker by re-running this registration). It routes SCORE_BATCH → router.handle, answers
// GET_BACKEND_STATUS (is the daemon up?) and GET_TOP_HOST (which page is this frame in?),
// empties the score caches on CLEAR_CACHE and mirrors the per-tab flagged count onto the
// toolbar icon (UPDATE_BADGE). Popup control actions (RESCAN / SET_ENABLED / GET_TAB_STATE /
// RETRY_BACKEND) are addressed straight to the active tab's content script via
// tabs.sendMessage, so they do not pass through here.
import { projectTab } from "../lib/stats/coarsen";
import { defineBackground, browser } from "#imports";
import type { PublicPath } from "wxt/browser";
import { createRouter } from "../lib/backend/router";
import { upgradeScoreCache } from "../lib/backend/swCache";
import { getScoreClient } from "../lib/backend/getScoreClient";
import { engineChoice, engineTransport, nativeGranted, transportOf } from "../lib/backend/engines";
import type { SetEngineReply } from "../lib/backend/engineChoice";
import { createTokenCounter } from "../lib/backend/tokenCounts";
import { createCacheModeController } from "../lib/backend/cacheMode";
import { ACTIONS } from "../lib/messaging/protocol";
import type {
  BackendStatus,
  CacheCountReply,
  CommentAccessReply,
  ClearCacheReply,
  CopyDiagnosticsReply,
  PdfPassOnceReply,
  CountTokensReply,
  ScoreBatchReply,
  TopHostReply,
} from "../lib/messaging/protocol";
import { ensureInjected, installAccess, readFrame } from "../lib/access/worker";
import { documentAuthority } from "../lib/access/authority";
import { applyCacheMode, invalidateAndNotify } from "../lib/access/cacheControls";
import { callerRole, parseWorkerMessage, permitsMessage, type AccessSender } from "../lib/access/messages";
import { sendTabControl } from "../lib/messaging/tabControl";
import type { ControlMessage } from "../lib/messaging/protocol";
import { READER_PAGE, readerQuery, safePdfSource } from "../lib/pdf/source";
import { createPdfNavigation } from "../lib/pdf/navigation";
import { createPdfHandoff } from "../lib/pdf/handoff";
import type { PdfReopenResult } from "../lib/pdf/sourceTransfer";
import { PDF_TAB_SCRIPTS_RUN } from "../lib/surface";
import { settings, cacheModeStorage, enabledForSite, RETIRED_SETTINGS } from "../lib/settings/settings";
import { t } from "../lib/i18n";
import { handleNativePageMessage } from "../lib/backend/nativeBridge";
import { readEngineSetup } from "../lib/backend/engineSetup";
import { deleteEngineFiles, startSetupByItself } from "../lib/webengine/autoSetup";
import { tierOf } from "../lib/webengine/tier";
import { engineTierChoice } from "../lib/webengine/tierStore";
import { closeWebEngine, webEngineRunning } from "../lib/webengine/client";
import { createSetupFeed, type SetupListener } from "../lib/backend/setupFeed";
import { createWarmup } from "../lib/backend/warmup";
import { NATIVE_MESSAGE, NATIVE_UNINSTALL } from "../lib/backend/nativeProtocol";
import { createStatsKeeper } from "../lib/stats/worker";
import { openStatsStore } from "../lib/stats/store";
import { createTabTracker } from "../lib/stats/tabs";
import { readStatsConfig, statsSecret } from "../lib/stats/settings";
import { noteStatsContext } from "../lib/stats/context";
import { localDate } from "../lib/stats/model";
import { registrableDomain } from "../lib/publicSuffixes";
const EXTENSION_UPDATE_KEY = "extensionUpdatePending";

/** Where a text was read, for the caches pages share (RequestOrigin.partition in
 *  lib/backend/router.ts): the tab's top-level site, the frame's own origin, and a private
 *  window apart from the rest — the way the browser partitions a page's own storage. */
/** Where a document's text was read: its partition (RequestOrigin.partition), and the registered
 *  domain of the tab's page, which shares a site's part of the router's limits. */
async function placeOf(sender: Pick<AccessSender, "tab">, document: { origin: string; documentKey: string }, paste: boolean): Promise<{ partition: string; site?: string }> {
  if (paste) return { partition: `paste ${document.documentKey}` };
  let top = "?";
  try { const url = await topUrlOf(sender); if (url) top = new URL(url).host; } catch { /* no address: its own partition */ }
  return { partition: `${sender.tab?.incognito ? "private" : "normal"} ${top} ${document.origin}`, site: top === "?" || top === "" ? undefined : registrableDomain(top) };
}

/**
 * The address of the page the sender's tab shows. Chrome puts it on every message. Firefox
 * leaves it off where Anagram has no access to that page's own site — a frame of a granted
 * site inside a page of one not granted — and every such frame of a site, whatever page it
 * was in, then shared one partition: the cross-site sharing the partition is there to stop.
 * webNavigation, which Anagram holds, tells the address there.
 */
async function topUrlOf(sender: Pick<AccessSender, "tab">): Promise<string | undefined> {
  if (sender.tab?.url || sender.tab?.id === undefined) return sender.tab?.url;
  const top = await browser.webNavigation.getFrame({ tabId: sender.tab.id, frameId: 0 }).catch(() => null);
  return top?.url;
}

export default defineBackground(() => {
  // A native port can keep this worker alive. Preserve an available extension
  // update for Settings rather than interrupting analysis with an automatic reload.
  browser.runtime.onUpdateAvailable?.addListener((details) => {
    void browser.storage.local.set({ [EXTENSION_UPDATE_KEY]: details.version });
  });
  const router = createRouter(getScoreClient());
  const tokenCounter = createTokenCounter(getScoreClient());
  const cacheModes=createCacheModeController((mode,restored)=>applyCacheMode(router,mode,restored),cacheModeStorage);
  // Do not dispatch scoring until persisted privacy preferences have been applied.
  const cacheModeReady=cacheModes.restore();
  if (typeof globalThis.indexedDB?.databases === "function") {
    void upgradeScoreCache().catch(() => console.warn("Could not upgrade the score cache"));
  }
  void cacheModeReady.catch(()=>console.warn("Anagram could not clear stored verdicts; disk writes remain disabled"));
  cacheModeStorage.watch(()=>{void cacheModes.restore().catch(()=>console.warn("Anagram cache mode change failed"));});
  // Site access is optional: the content script is registered for the origins the user has
  // granted and injected on demand where only activeTab applies (lib/access/worker.ts).
  installAccess();
  const badge = toolbarBadge(browser.action ?? (browser as unknown as { browserAction?: BadgeApi }).browserAction);
  browser.tabs.onRemoved.addListener((tabId) => {
    badge.forget(tabId);
    pdfNavigation.forget(tabId);
    setupFeed.forget(tabId);
    handoff.forget(tabId);
  });

  // Firefox requires the optional clipboard grant to be requested within the click.
  const clipboardOptional = browser.runtime.getManifest().optional_permissions?.includes("clipboardWrite");

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

  // The in-browser engine's download, pushed to the popup and the panels that show it.
  const setupFeed = createSetupFeed({
    read: async () => (await engineTransport().current()) === "inbrowser" ? readEngineSetup((op) => engineTransport().request(op)) : null,
    tell: async (listener, setup) => {
      const message = {action: ACTIONS.ENGINE_SETUP, setup};
      const reply = listener === "pages" ? await browser.runtime.sendMessage(message)
        : await browser.tabs.sendMessage(listener.tabId, message, {frameId: listener.frameId, ...(listener.documentId ? {documentId: listener.documentId} : {})});
      return (reply as {ok?: unknown} | undefined)?.ok === true;
    },
  });

  // A page Anagram reads, opening in the tab in front: an idle in-browser engine starts loading beside it.
  const warmup = createWarmup({
    engine: () => engineTransport().current(),
    reads: async (url) => {
      const {protocol, hostname} = new URL(url);
      return (await browser.permissions.contains({origins: [`${protocol}//${hostname}/*`]}).catch(() => false)) && (await enabledForSite(hostname));
    },
    inFront: async (tabId) => (await browser.tabs.get(tabId).catch(() => null))?.active === true,
    known: () => getScoreClient().known(),
    running: webEngineRunning,
    ask: async () => (await getScoreClient().status(false)).active,
    warm: () => transportOf("inbrowser").request("warm"),
  });
  browser.webNavigation.onBeforeNavigate.addListener((details) => void warmup(details));

  // The reading log, which pages' recorders send what they learn to and which only this
  // worker writes (lib/stats/worker.ts). Off unless the reader chose what to keep.
  const statsStore = openStatsStore();
  const statsModel = () => {
    const { id, ver, calibration } = getScoreClient().model();
    return id === "none" ? null : { id, ver, calibration };
  };
  const statsEngine = async () => {
    const kind = await engineTransport().current().catch(() => null);
    const { device, dtype } = getScoreClient().runtime();
    return kind ? { kind, backend: device, tier: dtype } : null;
  };
  let tabConfig = readStatsConfig();
  settings.statsConfig.watch(() => { tabConfig = readStatsConfig(); });
  const statsTabs = createTabTracker({ store: statsStore, config: () => tabConfig });
  statsTabs.install();
  settings.statsClearedAt.watch((at) => statsTabs.reset(at));
  const stats = createStatsKeeper({
    store: statsStore,
    config: readStatsConfig,
    enabledFor: (hostname) => hostname ? enabledForSite(hostname) : settings.enabled.getValue(),
    model: statsModel,
    engine: statsEngine,
    secret: statsSecret,
    tabs: statsTabs,
  });
  // A visit's last message, posted on its document's session port as the page goes
  // (lib/access/session.ts postDocumentMessage): held to the same schema and roles as one sent
  // as a runtime message, and kept unless the document's access was withdrawn.
  documentAuthority.setPortHandler((record, sender, value) => {
    const msg = parseWorkerMessage(value);
    if (msg?.action !== ACTIONS.STATS_RECORD) return;
    const role = callerRole(sender, browser.runtime.id, browser.runtime.getURL("/"));
    if (!role || !permitsMessage(role, msg, sender) || msg.session !== record.session) return;
    void documentAuthority.allowsPort(record, sender).then((ok) => ok ? stats.record(msg.wire, sender, role === "reader" ? "reader" : "content") : false).catch(() => false);
  });
  // What the log is recorded under: noted when the worker starts and when any of it changes.
  const noteContext = (): void => void noteStatsContext({ store: statsStore, model: statsModel, engine: statsEngine }).catch(() => undefined);
  noteContext();
  for (const item of [settings.statsConfig, settings.flagFrom, settings.displayMode, settings.underlineScope, settings.showHighlights, cacheModeStorage, settings.pdfReadAhead, settings.autoOpenPdfs, settings.siteOverrides, settings.enabled]) {
    item.watch(noteContext);
  }

  // Context menus; recreated idempotently on install/update. The PDF entry is offered on
  // LINKS to a .pdf, which is where a reader decides to open one — the tab that is
  // already showing a PDF is served by the ball's own action chip and by the popup.
  browser.runtime.onInstalled.addListener((details) => {
    if (details.reason === "install" || details.reason === "update") {
      void browser.storage.local.remove(EXTENSION_UPDATE_KEY);
      if (details.reason === "update") {
        void browser.storage.local.remove(RETIRED_SETTINGS);
        if (typeof globalThis.indexedDB?.databases !== "function")
          void upgradeScoreCache().catch(() => console.warn("Could not upgrade the score cache"));
      }
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
    // The setup page decides which engine this device runs (lib/device.ts) and starts the
    // in-browser one's download where there is no choice. An update carries on a download
    // the in-browser engine had under way (lib/webengine/autoSetup.ts says when it does not).
    if (details.reason === "install") {
      void browser.tabs.create({ url: browser.runtime.getURL("/onboarding.html") });
    } else if (details.reason === "update") {
      void engineTransport().current().then((engine) => {
        if (engine === "inbrowser") void engineTierChoice.getValue().catch(() => null).then((choice) => startSetupByItself((op, payload) => transportOf("inbrowser").request(op, payload),{tier:tierOf(choice), release:choice?.release}));
      });
    }
  });

  // Native Messaging taken back (Firefox's add-on page lets the person do that): the local
  // engine cannot be reached, so the choice is asked again on the setup page.
  browser.permissions.onRemoved.addListener((removed) => {
    if (!removed.permissions?.includes("nativeMessaging")) return;
    void engineChoice.getValue().then((chosen) => chosen === "native" ? engineChoice.setValue(null) : undefined).catch(() => undefined);
  });

  /**
   * "Analyze this page with Anagram": every frame of the tab is asked to analyze itself
   * once. The message goes to the whole tab, not one frame, because a page is its frames
   * too — each of them applies the usual size gate — and the content script decides what
   * "once" means for it: a running page re-scans, a switched-off one starts without any
   * setting or site rule being written.
   */
  async function analyzePage(tabId: number): Promise<boolean> {
    try {
      await ensureInjected(tabId);
      const reply = await browser.tabs.sendMessage(tabId, { action: ACTIONS.ANALYZE_PAGE });
      if (reply?.ok === true) return true;
    } catch { /* The page may no longer be reachable. */ }
    badge.feedback(tabId, false);
    return false;
  }

  /**
   * "Copy page diagnostics". Only the TOP frame is asked: the report is the page's, and
   * its document is the one a clipboard write is measured against. The page answers
   * whether Anagram is running there or not — the script is put into the page for this
   * one report if it is not there already — so "nothing shows up" on a switched-off site,
   * or on one nothing was ever granted for, is answered instead of met with silence.
   */
  async function copyDiagnostics(tabId: number, frameId: number): Promise<void> {
    try {
      await ensureInjected(tabId);
      const reply = await browser.tabs.sendMessage(tabId, { action: ACTIONS.COPY_DIAGNOSTICS, frameId }, { frameId: 0 }) as CopyDiagnosticsReply | undefined;
      badge.feedback(tabId, reply?.ok === true && reply.via !== "none");
    } catch { badge.feedback(tabId, false); }
  }

  browser.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "anagram-open-pdf") {
      if (!info.linkUrl || !safePdfSource(info.linkUrl)) return;
      try {
        // Record the user's choice before a fast response can commit in the new tab.
        const opened = await browser.tabs.create({ url: "about:blank", windowId: tab?.windowId, index: tab && tab.index + 1 });
        if (opened.id != null) {
          try { await pdfNavigation.want(opened.id, info.linkUrl); }
          finally { await browser.tabs.update(opened.id, { url: info.linkUrl }); }
        }
      } catch { if (tab?.id != null) badge.feedback(tab.id, false); }
      return;
    }
    if (tab?.id == null) return;
    if (info.menuItemId === "anagram-analyze-page") {
      await analyzePage(tab.id);
      return;
    }
    if (info.menuItemId === "anagram-copy-diagnostics") {
      try {
        // An existing grant resolves immediately. A revoked grant can be requested again.
        if (clipboardOptional && !await browser.permissions.request({ permissions: ["clipboardWrite"] })) {
          badge.feedback(tab.id, false);
          return;
        }
        await copyDiagnostics(tab.id, info.frameId ?? 0);
      } catch { badge.feedback(tab.id, false); }
      return;
    }
    if (info.menuItemId !== "anagram-analyze-selection") return;
    try {
      await ensureInjected(tab.id);
      await browser.tabs.sendMessage(tab.id, { action: ACTIONS.ANALYZE_SELECTION }, { frameId: info.frameId ?? 0 });
    } catch { badge.feedback(tab.id, false); }
  });

  // Keyboard commands, forwarded to the active tab. The message reaches every frame;
  // which of them may act on it is the content script's own rule (the overlay is
  // per-frame; the flagged walk belongs to the top frame).
  const COMMAND_ACTIONS: Record<string, ControlMessage["action"]> = {
    "toggle-overlay": ACTIONS.TOGGLE_OVERLAY,
    "next-flagged": ACTIONS.NEXT_FLAGGED,
    "prev-flagged": ACTIONS.PREV_FLAGGED,
  };
  browser.commands?.onCommand.addListener(async (command) => {
    const action = COMMAND_ACTIONS[command];
    if (!action) return;
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (tab?.id == null) return;
      await ensureInjected(tab.id);
      await sendTabControl(tab, { action } as ControlMessage);
    } catch { /* The active tab can close or navigate during the command. */ }
  });

  async function handleMessage(message: unknown, sender: AccessSender): Promise<unknown> {
    const raw=message as {action?:unknown}|null;
    if (raw?.action === "detectorCatalog") {
      const role = callerRole(sender,browser.runtime.id,browser.runtime.getURL("/"));
      if (role !== "options" && role !== "onboarding") return {ok:false};
      const ref=(message as {ref?:{release:string;revision:string}}).ref;
      try {
        const setup = (message as { setup?: boolean }).setup === true;
        const signal=AbortSignal.timeout(setup ? 6000 : 30000);
        if (setup) return {ok:true,value:await setupCatalog(signal)};
        return {ok:true,value:ref ? await resolveDetectorRelease(ref,signal) : await listDetectorReleases(signal)};
      } catch {return {ok:false};}
    }
    if (raw?.action === NATIVE_MESSAGE || raw?.action === NATIVE_UNINSTALL) {
      return handleNativePageMessage(message,sender,{invalidate:()=>getScoreClient().invalidate(),clear:()=>invalidateAndNotify(()=>router.clear())});
    }
    const msg=parseWorkerMessage(message);
    if (!msg) return {ok:false,error:"invalid_request"};
    const role=callerRole(sender,browser.runtime.id,browser.runtime.getURL("/"));
    if (!role || !permitsMessage(role,msg,sender)) return {ok:false,error:"forbidden"};
    // A frame's stub has no session: whether its frame may be read is the grant's to say.
    if (msg.action === ACTIONS.READ_FRAME) return {ok:await readFrame(sender)};
    const needsDocument=role === "content" || role === "reader" || role === "paste";
    const document=needsDocument ? await documentAuthority.authorize(sender,"session" in msg ? msg.session : undefined) : null;
    if (needsDocument && (!document || document.signal.aborted)) return {ok:false,error:"forbidden"};
    switch(msg.action) {
      case ACTIONS.ANALYZE_TAB:
        return {ok: await analyzePage(msg.tabId)};
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
        await pdfNavigation.contentPdf(tabId,sender.url!,msg.navigationType);
        return {ok:true};
      }
      case ACTIONS.PDF_PASS_ONCE: {
        const src=new URL(sender.url!).searchParams.get("src");
        if(src !== msg.url)return {ok:false} satisfies PdfPassOnceReply;
        await pdfNavigation.pass(sender.tab!.id!,msg.url); return {ok:true} satisfies PdfPassOnceReply;
      }
      case ACTIONS.PDF_REOPEN: {
        // Only a reader showing that very source, with its ticket already spent, asks again.
        const shown=new URL(sender.url!).searchParams;
        if(shown.has("ticket") || safePdfSource(shown.get("src") ?? "")?.href!==msg.url)return {ok:false,error:"forbidden"} satisfies PdfReopenResult;
        return handoff.reopen(sender.tab!.id!,msg.url);
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
        badge.count(sender.tab!.id!, msg.flagged);
        return {ok:true};
      }
      case ACTIONS.GET_TOP_HOST: {
        let host="";
        try {host=new URL((await topUrlOf(sender)) ?? "").hostname;}catch {/* no readable top URL */}
        return {host} satisfies TopHostReply;
      }
      case ACTIONS.GET_BACKEND_STATUS: {
        // A probe is somebody's Retry: an engine given up on after it kept dying may start again.
        if (msg.probe===true) engineTransport().retry?.();
        const engine=await engineTransport().current();
        const status=await getScoreClient().status(msg.probe===true);
        // No engine yet: setup is what is missing, and its page decides which.
        if (engine === null) return {...status,engine,setup:{state:"needed",percent:0}} satisfies BackendStatus;
        // The in-browser engine is down until it is set up, and then loading: the popup and the
        // panel say how far setup has got, and offer its page, instead of "not ready".
        if (engine !== "inbrowser" || (status.active !== "down" && status.active !== "loading") || status.server.code === "engine_crashed") return {...status,engine} satisfies BackendStatus;
        const setup=await readEngineSetup((op) => engineTransport().request(op));
        // A running download is then pushed to the popup and the panel as it moves.
        const listener:SetupListener|null=role === "popup" ? "pages" : role === "content" ? {tabId:sender.tab!.id!,frameId:sender.frameId ?? 0,documentId:sender.documentId} : null;
        if (listener) setupFeed.follow(listener,setup);
        return {...status,engine,setup} satisfies BackendStatus;
      }
      case ACTIONS.GET_ENGINE:
        return {engine:await engineTransport().current()};
      case ACTIONS.SET_ENGINE: {
        // The local engine only once Native Messaging is granted: the page asked in its click.
        if (msg.engine === "native" && !(await nativeGranted())) return {ok:false,error:"permission"} satisfies SetEngineReply;
        // The tier the setup page decided for the in-browser engine; a different one than the
        // engine started with means it starts again, on the new pin.
        if(msg.engine === "inbrowser" && msg.tier){
          const before = await engineTierChoice.getValue().catch(() => null);
          const release = msg.release ?? before?.release;
          const changed = (before?.release ?? defaultRelease).revision !== (release ?? defaultRelease).revision;
          await engineTierChoice.setValue({tier: msg.tier, fallback: msg.fallback === true,
            ...(release && release.revision !== defaultRelease.revision ? {release} : {})});
          if (tierOf(before) !== msg.tier || changed) await closeWebEngine();
        }
        if (msg.engine === "native" && msg.release) await nativeSetupRelease.setValue(msg.release);
        await engineChoice.setValue(msg.engine);
        const engine=await engineTransport().refresh();
        getScoreClient().invalidate();
        const choice = engine === "inbrowser" ? await engineTierChoice.getValue().catch(() => null) : null;
        const setup=engine === "inbrowser" && msg.setup
          ? await startSetupByItself((op, payload) => transportOf("inbrowser").request(op, payload),{asked:msg.setup === "now",tier:tierOf(choice),release:msg.release ?? choice?.release,explicitRelease:!!msg.release && msg.setup === "now"}) : undefined;
        return {ok:engine === msg.engine,engine,setup} satisfies SetEngineReply;
      }
      case ACTIONS.DELETE_INBROWSER_MODEL: {
        // Settings, after a switch to the local engine: the files the in-browser one kept.
        if ((await engineTransport().current()) === "inbrowser") return {ok:false,error:"in_use"};
        await closeWebEngine();
        try { await deleteEngineFiles(); return {ok:true}; } catch { return {ok:false,error:"delete_failed"}; }
      }
      case ACTIONS.COMMENT_ACCESS: {
        const missing:string[]=[];
        for (const origin of msg.origins) if (!(await browser.permissions.contains({origins:[origin]}).catch(()=>false))) missing.push(origin);
        return {missing} satisfies CommentAccessReply;
      }
      case ACTIONS.STATS_RECORD:
        // Answered the same whether anything was kept: a page learns nothing of what is kept.
        await stats.record(msg.wire,sender,role === "reader" ? "reader" : "content").catch(()=>false);
        return {ok:true};
      case ACTIONS.STATS_UI: {
        const at=Date.now();
        const config=await readStatsConfig();
        if (!config.on || config.layers.rows !== "event" || config.layers.ui !== "events") return {ok:true};
        const tab=msg.tabId ?? sender.tab?.id;
        if (sender.tab?.incognito || (tab !== undefined && (await browser.tabs.get(tab).catch(() => null))?.incognito !== false)) return {ok:true};
        if (tab === undefined && role === "popup") return {ok:true};
        const row = projectTab({at,date:localDate(new Date(at)),kind:"ui",ui:msg.kind,
          ...(tab !== undefined && config.layers.tabs !== "none" ? {tab:statsTabs.tabId(tab),visit:statsTabs.topVisit(tab)} : {})}, config.layers);
        if (row) await statsStore.tab(row, at).catch(()=>undefined);
        return {ok:true};
      }
      case ACTIONS.COUNT_TOKENS: {
        const signal = document!.scoringSignal(msg.scoringView);
        const counts=await tokenCounter.count(msg.texts,signal,(await placeOf(sender,document!,role === "paste")).partition).catch(()=>null);
        return {counts,model:getScoreClient().model(),backend:counts || getScoreClient().isUp() ? "up" : "down"} satisfies CountTokensReply;
      }
      case ACTIONS.SCORE_BATCH: {
        const signal = document!.scoringSignal(msg.scoringView);
        try {
          await cacheModeReady.catch(()=>undefined);
          const paste = role === "paste";
          const place=await placeOf(sender,document!,paste);
          const resp=await router.handle(msg.req,{private:paste || sender.tab?.incognito===true,partition:place.partition,site:place.site,documentKey:document!.documentKey,tab:sender.tab?.id,signal});
          if(signal.aborted)return {ok:false,error:"forbidden"};
          const hasModel=resp.model.id !== "none";
          // Known cached verdicts remain usable while the native model is unloaded.
          const up=getScoreClient().isUp() || (hasModel && resp.results.some((result)=>!result.degraded));
          return {results:resp.results,model:up && hasModel ? resp.model : undefined,backend:up ? "up" : "down"} satisfies ScoreBatchReply;
        } catch {return {results:[],backend:getScoreClient().isUp() ? "up" : "down"} satisfies ScoreBatchReply;}
      }
    }
  }
  browser.runtime.onMessage.addListener((message:unknown,sender,sendResponse) => {
    // Addressed extension-page controls are answered by that reader, not the worker.
    if (message && typeof message === "object" && "readerTabId" in message) return;
    void handleMessage(message,sender).then(sendResponse,()=>sendResponse({ok:false,error:"request_failed"}));
    return true;
  });
});
