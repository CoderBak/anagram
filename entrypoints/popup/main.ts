// entrypoints/popup/main.ts — popup logic.
//
// The toolbar menu is the one place Anagram is used from: no page carries a control of its
// own. It opens over whatever page the reader is looking at, and Anagram installs with
// access to no site, so most of those pages are ones it is doing nothing on. The top of the
// menu is therefore the page: what its paragraphs read as (./report.ts), or why there is
// nothing, and ONE button that follows it — rescan, analyze this page once, read this PDF,
// open a PDF from this computer, or set the engine up (./state.ts decides which). Under it:
// the per-site switch (the rule that decides the active tab may belong to a parent domain,
// see ./siteSwitch.ts) and what the page shows; at the foot, the other ways in and the
// engine. Everything else lives in Settings.
import { browser } from "#imports";
import type { PublicPath } from "wxt/browser";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { localizePage } from "../../lib/ui/localize";
import { t, tn, type MessageKey } from "../../lib/i18n";
import {
  settings,
  clearSiteOverride,
  effectiveRule,
  setSiteOverride,
  type SiteRule,
} from "../../lib/settings/settings";
import { siteLine, switchWrite } from "./siteSwitch";
import { ACTION_LABEL, popupLead, type PageFacts, type PopupLead } from "./state";
import { sitePattern } from "../../lib/access/patterns";
import { hasAccess, requestAccess } from "../../lib/access/grant";
import { readerFrames } from "../../lib/surfaces/frames";
import { ACTIONS } from "../../lib/messaging/protocol";
import type { BackendStatus, ControlMessage, EngineSetup, TabState } from "../../lib/messaging/protocol";
import { looksLikePdfUrl, READER_PAGE } from "../../lib/pdf/source";
import { PDF_TAB_SCRIPTS_RUN } from "../../lib/surface";
import { getFileAccess } from "../../lib/pdf/fileAccess";
import { FILE_URL_ACCESS_SUPPORTED } from "../../lib/surface";
import { chooseEngine } from "../../lib/backend/engineChoice";
import { decide } from "../../lib/device";
import { readDeviceInputs } from "../../lib/ui/deviceInputs";
import { timeLeft } from "../../lib/ui/size";
import { detectDocsPage } from "../../lib/docs";
import { commentHost } from "../../lib/access/commentFrames";
import { sendTabControl } from "../../lib/messaging/tabControl";
import type { PageReport } from "../../lib/capture/pageReport";
import { mountReport } from "./report";
import { bandColorRules } from "../../lib/render/scale";
import { aiShare, localDate, viewedWords, type UiEvent } from "../../lib/stats/model";
import { readStatsConfig } from "../../lib/stats/settings";
import { openStatsStore } from "../../lib/stats/store";
import { formatShare, formatWords } from "../../lib/stats/format";

const siteEl = document.getElementById("siteEnabled") as HTMLInputElement;
const siteHostEl = document.getElementById("siteHost") as HTMLElement;
const actionEl = document.getElementById("action") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;
const gearEl = document.getElementById("gear") as HTMLButtonElement;
const backendEl = document.getElementById("backend") as HTMLElement;
const switchEngineEl = document.getElementById("switchEngine") as HTMLButtonElement;
const keepOpenEl = document.getElementById("keepOpen") as HTMLElement;
const openReaderEl = document.getElementById("openReader") as HTMLButtonElement;
const analyzeTextEl = document.getElementById("analyzeText") as HTMLButtonElement;
const pageActionEl = document.getElementById("pageAction") as HTMLButtonElement;
let currentTab: { id?: number; url?: string } | undefined;
let docsEditor = false;
let report: PageReport | null = null;
let offset = 0;
let statusRequest = 0;
let pageControlFailed = false;
/** One use of this menu, for the statistics where they keep such events (the worker decides). */
const noteUi = (kind: UiEvent): void => void browser.runtime.sendMessage({ action: ACTIONS.STATS_UI, kind, ...(currentTab?.id !== undefined ? { tabId: currentTab.id } : {}) }).catch(() => undefined);
const paintReport = mountReport(document.getElementById("pageReport")!, {
  jump: (documentId, id) => { noteUi("jump"); void runPageControl({ action: ACTIONS.JUMP_TO_RESULT, documentId, id }); },
  page: (next) => { offset = next; void refreshStatus(currentTab?.id); },
  allow: (origin) => {
    void browser.tabs.create({ url: `${browser.runtime.getURL("/options.html")}#comments=${encodeURIComponent(commentHost(origin))}` });
    window.close();
  },
});

async function runPageControl(message: ControlMessage): Promise<void> {
  pageControlFailed = false;
  const reply = await sendTabControl(currentTab, message).catch(() => undefined) as { ok?: boolean } | undefined;
  if (reply?.ok) { window.close(); return; }
  await refreshStatus(currentTab?.id);
  pageControlFailed = true;
  paint();
}
// The one segmented control left is a Basecoat tab list (buttons with aria-selected).
const displayModeEls = segButtons("displayMode");

function segButtons(name: string): HTMLButtonElement[] {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(`nav[data-seg="${name}"] > [role="tab"]`),
  );
}

/** Wire a tab list as a single-choice control (click + arrow keys) → callback. */
function bindSeg(els: HTMLButtonElement[], onPick: (value: string) => void): void {
  els.forEach((el, i) => {
    el.addEventListener("click", () => {
      checkSeg(els, el.dataset.value ?? "");
      onPick(el.dataset.value ?? "");
    });
    el.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
      e.preventDefault();
      const next = els[(i + (e.key === "ArrowRight" ? 1 : els.length - 1)) % els.length]!;
      next.focus();
      next.click();
    });
  });
}

async function activeTab() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function sendToTab(tabId: number | undefined, msg: ControlMessage): Promise<unknown> {
  if (tabId == null) return Promise.resolve(undefined);
  // The content script may not be present (e.g. chrome:// pages) — swallow rejections.
  return sendTabControl(currentTab, msg).catch(() => undefined);
}

function checkSeg(els: HTMLButtonElement[], value: string): void {
  for (const el of els) {
    const on = el.dataset.value === value;
    el.setAttribute("aria-selected", String(on));
    el.tabIndex = on ? 0 : -1;
  }
}

/**
 * Everything the action block is painted from, in one place: the tab's own facts arrive
 * first (they are read straight off the tab), the content script's answer and the daemon's
 * come back over messages. Each of them repaints, so the block never shows two things at
 * once — and never a button whose reason has already gone away.
 */
const facts: PageFacts = {
  hasTab: false,
  pattern: null,
  pdfTab: false,
  pdfReadable: true,
  tab: null,
  daemon: "up",
};
/** The counts, once a running page has reported them — the "counts" status line. */
let counts: TabState | null = null;
/** What the button is currently offering, so its click knows what it promised. */
let lead: PopupLead = popupLead(facts);
/**
 * Has the page been asked what it is doing yet? Nothing is painted before it has: the
 * daemon's answer usually arrives first (it is cached in the worker) and painting on it
 * alone would offer "Analyze this page" for a moment on a page that is already running.
 */
let asked = false;

/** The counts line: analyzed, flagged, and the two kinds of paragraph that were not read. */
function countsLine(state: TabState): Node[] {
  const flaggedEl = document.createElement("span");
  flaggedEl.textContent = t("popupFlaggedCount", state.flagged);
  if (state.flagged > 0) flaggedEl.classList.add("flagged");
  // A paragraph the daemon never answered for was not analyzed, and neither was one
  // the language gate refused — both are counted apart from the analyzed number.
  const unavailable = state.unavailable ?? 0;
  const analyzed = state.scored - (state.unsupported ?? 0) - unavailable;
  const sep = (): Text => document.createTextNode(t("listSeparator"));
  const out: Node[] = [document.createTextNode(tn("popupAnalyzed", analyzed)), sep(), flaggedEl];
  if (state.unsupported) out.push(sep(), document.createTextNode(t("popupNotEnglish", state.unsupported)));
  if (unavailable) out.push(sep(), document.createTextNode(t("popupUnavailable", unavailable)));
  return out;
}

/** The status line and the button, from the facts as they stand. */
function paint(): void {
  if (!asked) return;
  lead = popupLead(facts);
  // A page no extension may be granted — a browser page, the web store, a file, the reader —
  // has no site to switch, and one nothing can run on has nothing to show either.
  const siteField = siteEl.closest(".field") as HTMLElement;
  const showField = document.getElementById("displayModeLbl")!.closest(".field") as HTMLElement;
  siteField.hidden = facts.pattern === null;
  showField.hidden = lead.status === "unsupported" || lead.status === "noTab";
  (siteField.closest(".grp") as HTMLElement).hidden = siteField.hidden && showField.hidden;
  (document.getElementById("localFileSettings") as HTMLButtonElement).hidden = lead.status !== "fileAccess" || !FILE_URL_ACCESS_SUPPORTED;
  const down = lead.status === "daemon";
  statusEl.classList.toggle("down", down || lead.status === "crashed");
  switchEngineEl.hidden = !(lead.status === "crashed" && canSwitch);
  const mismatch = facts.daemon === "mismatch";

  switch (lead.status) {
    case "counts":
      // The report says it better, as soon as there is one.
      statusEl.replaceChildren(...(counts ? countsLine(counts) : [t("selAnalyzing")]));
      break;
    case "off":
      statusEl.textContent = t("popupOff");
      break;
    case "unsupported":
      statusEl.textContent = t("popupUnsupportedPage");
      break;
    case "translated":
      statusEl.textContent = t("popupTranslatedPage");
      break;
    case "noText":
      statusEl.textContent = t("readerNoText");
      break;
    case "noTab":
      statusEl.textContent = t("popupUnsupportedPage");
      break;
    case "daemon":
      statusEl.textContent = t(mismatch ? "popupEngineOutdated" : inBrowser ? "popupEngineInBrowserDown" : "popupEngineDown");
      break;
    case "crashed":
      statusEl.textContent = t("popupEngineCrashed");
      break;
    case "fileAccess":
      statusEl.textContent = t(FILE_URL_ACCESS_SUPPORTED ? "popupFileAccessNeeded" : "safariLocalPdfNote");
      break;
    case "setup": {
      const setup = facts.setup!;
      const left = setup.state === "downloading" ? downloadLeft(setup.percent) : null;
      statusEl.textContent = setup.state === "downloading" ? (left === null ? t("popupSetupDownloading", setup.percent) : t("popupSetupDownloadingLeft", setup.percent, timeLeft(left)))
        : setup.state === "paused" ? t("popupSetupPaused", setup.percent)
        : setup.state === "failed" ? t(SETUP_FAILURE[setup.failure ?? "other"])
        : setup.state === "error" ? t(setup.problem === "device" ? "popupEngineCannotRun" : "popupEngineLoadFailed")
        : t(setup.state === "loading" ? "engineLoading" : "popupSetupNeeded");
      break;
    }
    case "none":
      statusEl.textContent = "";
      break;
  }
  // On a PDF tab the button says the whole of it, and on a page read the report does; an
  // empty line above them would only be a gap where a sentence used to be.
  const reported = lead.status === "counts" && !!counts && !!report && !facts.tab?.translated;
  statusEl.hidden = lead.status === "none" || reported;
  // While the in-browser engine's model downloads, the browser has to stay open.
  keepOpenEl.hidden = !(lead.status === "setup" && facts.setup?.state === "downloading");
  // The main button already opens the reader empty on these tabs.
  openReaderEl.hidden = lead.action === "openReader";

  actionEl.textContent = t(lead.action === "setup" ? setupLabel(facts.setup!) : ACTION_LABEL[lead.action]);
  if (docsEditor && (lead.action === "analyze" || lead.action === "rescan")) actionEl.textContent = t("actionAnalyzeDocument");
  const pageAction = facts.tab?.translated ? null : report?.pageAction;
  pageActionEl.hidden = !pageAction;
  pageActionEl.textContent = pageAction?.label ?? "";
  pageActionEl.disabled = !pageAction?.enabled;
  // Docs actions replace the ordinary rescan; the editor itself paints text on a canvas.
  actionEl.hidden = !!pageAction && (docsEditor && (lead.action === "analyze" || lead.action === "rescan") || lead.action === "readPdf");
  if (!pageAction || lead.primary && !actionEl.hidden) pageActionEl.dataset.variant = "outline";
  else delete pageActionEl.dataset.variant;
  // While no engine can score, what waits for one or found none is the status line's to say.
  const engineAway = lead.status === "setup" || lead.status === "daemon" || lead.status === "crashed";
  paintReport(counts && !facts.tab?.translated ? report : null, engineAway);
  actionEl.disabled = false;
  if (lead.primary) delete actionEl.dataset.variant;
  else actionEl.dataset.variant = "outline";
  if (pageControlFailed) {
    statusEl.hidden = false;
    statusEl.textContent = t("popupPageActionFailed");
  }
}

/** The download's percentages as the menu saw them come in, and when: how long the rest takes,
 *  as the setup page tells it from its bytes. */
const downloadSeen: { at: number; percent: number }[] = [];
function downloadLeft(percent: number): number | null {
  const now = performance.now(), last = downloadSeen.at(-1);
  if (!last || percent < last.percent) downloadSeen.length = 0;
  if (!last || percent !== last.percent) downloadSeen.push({ at: now, percent });
  while (downloadSeen.length > 2 && now - downloadSeen[0]!.at > 20_000) downloadSeen.shift();
  const first = downloadSeen[0]!, newest = downloadSeen.at(-1)!;
  if (newest.at - first.at < 3_000 || newest.percent <= first.percent) return null;
  const perSecond = ((newest.percent - first.percent) * 1000) / (newest.at - first.at);
  return (100 - percent) / perSecond;
}

/** Why the model's download stopped, in the menu's few words; the setup page says what to do. */
const SETUP_FAILURE: Record<NonNullable<EngineSetup["failure"]>, MessageKey> = {
  network: "popupSetupStoppedNetwork",
  storage: "popupSetupStoppedStorage",
  server: "popupSetupStoppedServer",
  damaged: "popupSetupStoppedDamaged",
  other: "engineSetupFailed",
};

/** The setup button's words: start it, watch it, carry on with it, or see why the model did
 *  not start (the setup page says what to do, and has Retry). */
function setupLabel(setup: EngineSetup): MessageKey {
  if (setup.state === "error") return "engineSeeWhy";
  return setup.state === "needed" ? "engineSetUp" : setup.state === "downloading" || setup.state === "loading" ? "engineShowProgress" : "engineContinueSetup";
}

/** The engine in use is the in-browser one, which is not a program on this computer. */
let inBrowser = false;
/** The local engine kept crashing and this device runs the in-browser engine: offer it. */
let canSwitch = false;

/** The engine line at the foot, when the engine is up (the action block says the rest). */
function paintModel(s: BackendStatus | undefined): void {
  const up = s?.active === "idle" || (s?.active === "server" && !!s.model);
  backendEl.hidden = !up;
  if (!up || !s) { backendEl.textContent = ""; return; }
  const where = deviceWords(s.server.device);
  backendEl.textContent = s.server.outdated ? t("popupEngineOutdated")
    : t(inBrowser ? "popupEngineInBrowser" : "popupEngine", t("componentReady") + (where ? ", " + where : ""));
}

/** Where the model runs, in Settings' words; a runtime's own name ("mps", "webgpu") is none. */
function deviceWords(device: string | undefined): string {
  if (!device) return "";
  if (/gpu|cuda|mps|metal|rocm|directml|dml/iu.test(device)) return t("engineWordsGpu");
  if (/cpu|wasm/iu.test(device)) return t("engineWordsCpu");
  return "";
}

/** Is the local engine ready? If not, the action opens setup and Settings. */
async function refreshBackend(probe = false): Promise<void> {
  try {
    const s = (await browser.runtime.sendMessage({
      action: ACTIONS.GET_BACKEND_STATUS,
      probe,
    })) as BackendStatus | undefined;
    if (!s) throw new Error("no status");
    const there = s.server.reason === "contract";
    facts.daemon = (s.active === "server" && s.model) || s.active === "idle" ? "up" : there ? "mismatch" : "down";
    facts.setup = s.setup ?? null;
    inBrowser = s.engine === "inbrowser";
    facts.crashed = s.engine === "native" && s.server.code === "engine_crashed";
    // The in-browser engine is offered beside Retry only where this device runs it.
    if (facts.crashed && !canSwitch) canSwitch = (await readDeviceInputs().then(decide).catch(() => null))?.path != null;
    paintModel(s);
  } catch {
    // No worker to ask at all: say nothing about a model, and leave the page's own state
    // alone rather than blaming the daemon for a failure that is not its.
    paintModel(undefined);
  }
  paint();
}

// While the in-browser engine's model downloads the worker pushes each new figure here, as it
// does to running pages (lib/backend/setupFeed.ts); whatever follows the download is asked for.
browser.runtime.onMessage.addListener((message: unknown, sender, sendResponse): undefined => {
  const pushed = message as { action?: unknown; setup?: EngineSetup | null } | null;
  if (pushed?.action !== ACTIONS.ENGINE_SETUP || sender.tab) return;
  if (pushed.setup?.state === "downloading") {
    facts.setup = pushed.setup;
    paint();
  } else void refreshBackend();
  sendResponse({ ok: true });
});

/**
 * What "This site" is showing, kept here because the switch has to act INSIDE the click
 * that flipped it: asking the browser for a site is only allowed as part of the user's
 * gesture, and nothing may be awaited first. So the rule that decides this page, the
 * global default and whether this site is granted at all are read whenever the popup
 * paints, and the handler works from them.
 */
let siteRule: SiteRule | null = null;
let globalDefault = true;
let granted = false;
/** The addresses this site shows its books from, asked for with it (lib/surfaces/frames.ts),
 *  and whether they are granted: without them the site runs but its books are unread, so
 *  the switch shows off and turning it on asks for them. */
let frames: string[] = [];
let framesGranted = true;

/** What the settings alone say about this site, access aside. */
const ruleSaysOn = (): boolean => (siteRule ? siteRule.mode === "on" : globalDefault);

/**
 * Paint "This site" from the rule that actually decides this page: the switch shows that
 * rule's state (or the global default when no rule covers the host), and the line under it
 * names the site the rule belongs to — "on zhihu.com" on a zhuanlan.zhihu.com tab. Access
 * comes first, though: a site Anagram may not read is a site Anagram is off for.
 */
async function refreshSite(host: string): Promise<void> {
  globalDefault = await settings.enabled.getValue();
  granted = await hasAccess(facts.pattern);
  framesGranted = frames.length === 0 || (await hasAccess(frames[0]!, frames.slice(1)));
  if (!host) {
    siteEl.checked = false;
    siteHostEl.textContent = "";
    siteHostEl.title = "";
    return;
  }
  siteRule = await effectiveRule(host);
  siteEl.checked = granted && framesGranted && ruleSaysOn();
  siteHostEl.textContent = siteLine(host, siteRule);
  siteHostEl.title = host;
}

/**
 * Ask even on ungranted sites: a one-shot run can have a script there already.
 * No response simply means Anagram is off and the popup can offer one-shot analysis.
 */
async function refreshStatus(tabId: number | undefined): Promise<void> {
  const request = ++statusRequest;
  let state: TabState | undefined;
  if (tabId != null) {
    try {
      state = (await sendTabControl(currentTab, {
        action: ACTIONS.GET_TAB_STATE,
        reportOffset: offset,
      })) as TabState | undefined;
    } catch {
      /* no content script there, or the page tore it down — Anagram is not running */
    }
  }
  if (request !== statusRequest) return;
  // A one-shot analysis can be running without a persistent site grant.
  if (state?.pdf && facts.pattern) facts.pdfTab = true;
  facts.tab = state ? { enabled: state.enabled, translated: state.translated === true, reader: state.reader === true, noText: state.noText === true } : null;
  counts = state?.enabled ? state : null;
  if (report?.documentId !== state?.report?.documentId) { offset = 0; pageControlFailed = false; }
  report = state?.report ?? null;
  asked = true;
  paint();
}

/**
 * Today's line, while statistics are recorded: how much of what was read today is expected
 * to be AI-generated, out of how many words scored, and the way to the statistics page. Read
 * from the extension's own database (lib/stats/store.ts); off, the line is not there.
 */
async function paintStatsToday(): Promise<void> {
  const line = document.getElementById("statsToday")!;
  const on = (await readStatsConfig()).on;
  line.hidden = !on;
  if (!on) return;
  const total = (await openStatsStore().day(localDate()).catch(() => undefined))?.tally;
  document.getElementById("statsTodayText")!.textContent = !total || viewedWords(total) === 0 ? t("popupStatsNothing")
    : total.scored === 0 ? t("popupStatsNoneScored", formatWords(viewedWords(total)))
    : t("popupStatsToday", formatShare(aiShare(total)), formatWords(total.scored));
}

/** The reading mode with no document in it: its empty state is a drop zone and a picker. */
function openEmptyReader(): void {
  void browser.tabs.create({ url: browser.runtime.getURL(READER_PAGE as PublicPath) });
}

async function init(): Promise<void> {
  localizePage();
  followSystemTheme();
  // The four words' colours are the chips' and the marks' own.
  const bandRules = document.createElement("style");
  bandRules.textContent = bandColorRules("", "html.dark");
  document.head.append(bandRules);
  const tab = await activeTab();
  currentTab = tab;
  noteUi("menu");
  try { docsEditor = !!tab?.url && detectDocsPage(new URL(tab.url))?.kind === "editor"; } catch { /* restricted URL */ }
  const host = hostOf(tab?.url);
  facts.hasTab = tab != null;
  facts.pattern = sitePattern(tab?.url);
  frames = host && facts.pattern ? readerFrames(host) : [];
  const localFile = tab?.url?.startsWith("file://") === true;
  facts.pdfTab = (facts.pattern !== null || localFile) && looksLikePdfUrl(tab?.url);
  if (localFile) {
    const access = await getFileAccess();
    facts.pdfReadable = access.granted && access.allowed;
  }
  if (tab?.id != null && !facts.pdfTab) {
    const pdf = await browser.runtime.sendMessage({ action: ACTIONS.GET_PDF_STATUS, tabId: tab.id }).catch(() => undefined) as { pdf?: boolean } | undefined;
    if (pdf?.pdf === true) facts.pdfTab = true;
  }

  checkSeg(displayModeEls, await settings.displayMode.getValue());
  // A page no extension may be granted — a browser page, the web store, a file — has
  // nothing this switch could do.
  siteEl.disabled = !host || facts.pattern === null;
  await refreshSite(host);

  siteEl.addEventListener("change", () => {
    if (!host) return;
    const want = siteEl.checked;
    noteUi(want ? "siteOn" : "siteOff");
    // The rules first, and only where they disagree with the switch: a site that is off
    // merely for want of access must not collect a rule saying what the default already
    // says. Nothing is awaited here — see refreshSite.
    let written: Promise<void> = Promise.resolve();
    if (want !== ruleSaysOn()) {
      const write = switchWrite(host, siteRule, globalDefault, want);
      written = write.kind === "clear" ? clearSiteOverride(write.host) : setSiteOverride(write.host, write.mode);
    }
    if (want && facts.pattern && (!granted || !framesGranted)) {
      // Turning it on for a site Anagram may not read is asking for the site. The prompt
      // is the browser's and the explanation is the browser's; Chrome closes the popup to
      // show it, so everything that follows a yes happens in the worker — the content
      // script is registered and the open tabs are injected there (lib/access/worker.ts).
      // An e-book reader's site brings the address it shows the book from (lib/surfaces/frames.ts).
      void requestAccess([facts.pattern, ...frames]).then((ok) => {
        if (ok) granted = framesGranted = true;
        void refreshSite(host); // only reached where the popup survives the prompt
      });
      return;
    }
    void written.then(async () => {
      await refreshSite(host); // the line now names wherever the rule ended up
      sendToTab(tab?.id, { action: ACTIONS.SET_ENABLED, value: want });
      setTimeout(() => void refreshStatus(tab?.id), 400);
    });
  });

  bindSeg(displayModeEls, (v) => void settings.displayMode.setValue(v as "all" | "flagged"));
  pageActionEl.addEventListener("click", () => {
    if (!report?.pageAction?.enabled) return;
    pageActionEl.disabled = true;
    void runPageControl({ action: ACTIONS.RUN_PAGE_ACTION, documentId: report.documentId, id: report.pageAction.id });
  });

  actionEl.addEventListener("click", () => {
    pageControlFailed = false;
    switch (lead.action) {
      case "analyze":
        noteUi("analyze");
        // The reader reads its document when asked; nothing is injected into it.
        if (facts.tab?.reader) { void runPageControl({ action: ACTIONS.ANALYZE_PAGE }); return; }
        // A page Anagram is off for — by a rule, or because nothing was ever granted for
        // its site — is analyzed ONCE, with no setting written and no permission asked:
        // opening this popup gave the extension `activeTab`, which is all the worker needs.
        if (tab?.id != null) void browser.runtime.sendMessage({ action: ACTIONS.ANALYZE_TAB, tabId: tab.id });
        window.close(); // the answer is on the page, not in here
        return;
      case "readPdf":
        // Firefox cannot read the privileged built-in viewer; its loader needs a host grant.
        const permission = !PDF_TAB_SCRIPTS_RUN && facts.pattern && !granted
          ? requestAccess([facts.pattern]) : Promise.resolve(true);
        void permission.then(async (accepted) => {
          if (!accepted) {
            statusEl.hidden = false; statusEl.textContent = t("popupPdfOpenFailed"); return;
          }
          const result = await browser.runtime.sendMessage({ action: ACTIONS.OPEN_PDF_READER, url: tab?.url, tabId: tab?.id });
          if (result?.ok !== true) {
            statusEl.hidden = false;
            statusEl.textContent = t("popupPdfOpenFailed");
            return;
          }
          window.close();
        }).catch(() => { statusEl.hidden = false; statusEl.textContent = t("popupPdfOpenFailed"); });
        return;
      case "openReader":
        openEmptyReader();
        window.close();
        return;
      case "retry":
        void browser.runtime.openOptionsPage();
        window.close();
        return;
      case "retryEngine":
        // A probe is a Retry: the worker may start the engine it gave up on once more.
        actionEl.disabled = true;
        void refreshBackend(true);
        return;
      case "setup":
        // The setup page, where the download is started and followed.
        void browser.tabs.create({ url: browser.runtime.getURL("/onboarding.html") });
        window.close();
        return;
      case "rescan":
        if (docsEditor) {
          if (tab?.id != null) void browser.runtime.sendMessage({ action: ACTIONS.ANALYZE_TAB, tabId: tab.id });
          window.close(); return;
        }
        sendToTab(tab?.id, { action: ACTIONS.RESCAN });
        counts = null; // "Rescanning…" until the page reports again
        paint();
        setTimeout(() => void refreshStatus(tab?.id), 1500);
        return;
    }
  });

  switchEngineEl.addEventListener("click", () => {
    switchEngineEl.disabled = true;
    // The download starts now, and the setup page shows it; on the model tier this device gets.
    void readDeviceInputs().then(decide).catch(() => null)
      .then((d) => chooseEngine("inbrowser", "now", d?.tier ? { tier: d.tier, fallback: d.fallback !== null } : undefined)).then((reply) => {
      if (!reply.ok) { switchEngineEl.disabled = false; statusEl.textContent = t("engineSwitchFailed"); return; }
      void browser.tabs.create({ url: browser.runtime.getURL("/onboarding.html") });
      window.close();
    });
  });

  openReaderEl.addEventListener("click", () => {
    noteUi("reader");
    openEmptyReader();
    window.close();
  });
  document.getElementById("openStats")!.addEventListener("click", () => {
    void browser.tabs.create({ url: browser.runtime.getURL("/stats.html" as PublicPath) });
    window.close();
  });
  void paintStatsToday();
  analyzeTextEl.addEventListener("click", () => {
    void browser.tabs.create({ url: browser.runtime.getURL("/paste.html" as PublicPath) });
    window.close();
  });

  gearEl.addEventListener("click", () => {
    void browser.runtime.openOptionsPage();
  });
  // How to keep Anagram in the toolbar, only while it is not kept there.
  const toolbarHelp = document.getElementById("toolbarHelp")!;
  const userSettings = (browser as { action?: { getUserSettings?: () => Promise<{ isOnToolbar?: boolean }> } }).action?.getUserSettings;
  void userSettings?.().then((u) => { toolbarHelp.hidden = u.isOnToolbar !== false; }).catch(() => undefined);
  toolbarHelp.addEventListener("click", () => {
    void browser.tabs.create({ url: browser.runtime.getURL("/options.html") + "#toolbar-guide" });
    window.close();
  });
  (document.getElementById("localFileSettings") as HTMLButtonElement).addEventListener("click", () => {
    void browser.tabs.create({ url: browser.runtime.getURL("/options.html") + "#local-pdfs" });
  });

  await refreshStatus(tab?.id);
  void refreshBackend();
  // Refresh only while this popup is open, with no overlapping page requests.
  let ticks = 0;
  const poll = async (): Promise<void> => {
    await refreshStatus(tab?.id);
    if (++ticks % 5 === 0) await Promise.all([refreshBackend(), paintStatsToday()]);
    window.setTimeout(() => void poll(), 1000);
  };
  window.setTimeout(() => void poll(), 1000);
}

void init();
