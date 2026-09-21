// entrypoints/popup/main.ts — popup logic.
//
// The popup opens over whatever page the reader is looking at, and Anagram installs with
// access to no site, so most of those pages are ones it is doing nothing on. The top of
// the popup is therefore the page's state and ONE button that follows it — rescan, analyze
// this page once, read this PDF, open a PDF from this computer, or open local setup
// (./state.ts decides which). Under it: where Anagram runs (this site, all websites — the
// rule that decides the active tab may belong to a parent domain, see ./siteSwitch.ts),
// what it shows, and a folded-away "More" for the three controls that are set once and
// forgotten. The model line closes the popup; the shortcuts are listed on the options page.
import { browser } from "#imports";
import type { PublicPath } from "wxt/browser";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { localizePage } from "../../lib/ui/localize";
import { t, tn } from "../../lib/i18n";
import {
  settings,
  clearSiteOverride,
  effectiveRule,
  normalizeMarkStyle,
  setSiteOverride,
  type SiteRule,
} from "../../lib/settings/settings";
import type { MarkStyle } from "../../lib/settings/settings";
import { siteLine, switchWrite } from "./siteSwitch";
import { ACTION_LABEL, popupLead, type PageFacts, type PopupLead } from "./state";
import { ALL_SITES, sitePattern } from "../../lib/access/patterns";
import { accessSummary, hasAccess, requestAccess } from "../../lib/access/grant";
import { ACTIONS } from "../../lib/messaging/protocol";
import type { BackendStatus, ControlMessage, TabState } from "../../lib/messaging/protocol";
import { looksLikePdfUrl, READER_PAGE } from "../../lib/pdf/source";
import { PDF_TAB_SCRIPTS_RUN } from "../../lib/surface";

const enabledEl = document.getElementById("enabled") as HTMLInputElement;
const siteEl = document.getElementById("siteEnabled") as HTMLInputElement;
const siteHostEl = document.getElementById("siteHost") as HTMLElement;
const highlightsEl = document.getElementById("highlights") as HTMLInputElement;
const markStyleEl = document.getElementById("markStyle") as HTMLSelectElement;
const scopeEl = document.getElementById("analysisScope") as HTMLSelectElement;
const actionEl = document.getElementById("action") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;
const cmdEl = document.getElementById("cmd") as HTMLElement;
const gearEl = document.getElementById("gear") as HTMLButtonElement;
const backendEl = document.getElementById("backend") as HTMLElement;
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
      const next = els[(i + (e.key === "ArrowRight" ? 1 : els.length - 1)) % els.length];
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

function sendToTab(tabId: number | undefined, msg: ControlMessage): void {
  if (tabId == null) return;
  // The content script may not be present (e.g. chrome:// pages) — swallow rejections.
  void browser.tabs.sendMessage(tabId, msg).catch(() => undefined);
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
  pdfReadable: PDF_TAB_SCRIPTS_RUN,
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
  return [
    document.createTextNode(tn("popupAnalyzed", analyzed)),
    flaggedEl,
    document.createTextNode(state.unsupported ? t("popupNotEnglish", state.unsupported) : ""),
    document.createTextNode(unavailable ? t("popupUnavailable", unavailable) : ""),
  ];
}

/** The status line and the button, from the facts as they stand. */
function paint(): void {
  if (!asked) return;
  lead = popupLead(facts);
  const down = lead.status === "daemon";
  statusEl.classList.toggle("down", down);
  const mismatch = facts.daemon === "mismatch";
  cmdEl.hidden = !down;

  switch (lead.status) {
    case "counts":
      statusEl.replaceChildren(...(counts ? countsLine(counts) : [t("popupRescanning")]));
      break;
    case "off":
      statusEl.textContent = t("popupOff");
      break;
    case "unsupported":
      statusEl.textContent = t("popupUnsupportedPage");
      break;
    case "noTab":
      statusEl.textContent = t("popupNoTab");
      break;
    case "daemon":
      statusEl.textContent = mismatch ? t("popupDaemonMismatch") : t("popupDaemonDown");
      break;
    case "none":
      statusEl.textContent = "";
      break;
  }
  // On a PDF tab the button says the whole of it; an empty line above it would only be a
  // gap where a sentence used to be.
  statusEl.hidden = lead.status === "none";

  actionEl.textContent = t(ACTION_LABEL[lead.action]);
  actionEl.disabled = false;
  if (lead.primary) delete actionEl.dataset.variant;
  else actionEl.dataset.variant = "outline";
}

/** The model line at the foot: what is scoring, when anything is. */
function paintModel(s: BackendStatus | undefined): void {
  if (!s || s.active !== "server" || !s.model) {
    backendEl.textContent = ""; // the action block above is already saying it
    backendEl.hidden = true;
    return;
  }
  backendEl.hidden = false;
  // Scoring, but from a daemon older than this extension: the owner's rule is that the two
  // are updated together, so the line that names the model asks for that instead.
  if (s.server.outdated) {
    backendEl.textContent = t("popupDaemonBehind");
    return;
  }
  const b = document.createElement("b");
  b.textContent = s.model.id;
  backendEl.replaceChildren(t("popupModel"), b, t("popupLocal") + (s.server.device ? " · " + s.server.device : ""));
}

/** Is the local engine ready? If not, the action opens setup and Settings. */
async function refreshBackend(probe = false): Promise<void> {
  try {
    const s = (await browser.runtime.sendMessage({
      action: ACTIONS.GET_BACKEND_STATUS,
      probe,
    })) as BackendStatus | undefined;
    if (!s) throw new Error("no status");
    // The one place a `reason` is read. A daemon that is THERE but cannot work with this
    // extension — another contract major, or one too old to answer an extension that asks
    // for no host permission ("outdated") — needs updating, and telling somebody to start
    // what is already running sends them down the wrong path. A daemon that is merely OLDER
    // than the extension still scores, so it is "up" here and the model line asks for the
    // update instead (paintModel).
    const there = s.server.reason === "contract" || s.server.reason === "outdated";
    facts.daemon = s.active === "server" && s.model ? "up" : there ? "mismatch" : "down";
    paintModel(s);
  } catch {
    // No worker to ask at all: say nothing about a model, and leave the page's own state
    // alone rather than blaming the daemon for a failure that is not its.
    paintModel(undefined);
  }
  paint();
}

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
/** Every site is granted — what "All websites" needs before it can mean what it says. */
let allGranted = false;

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
  allGranted = (await accessSummary()).all;
  // "All websites" is painted from the same two facts as "This site": the setting AND the
  // access. A fresh install has the setting on and may read nothing, and a switch that
  // said ON there would be describing an extension that does not exist yet.
  enabledEl.checked = globalDefault && allGranted;
  if (!host) {
    siteEl.checked = false;
    siteHostEl.textContent = t("popupSiteUnavailable");
    siteHostEl.title = "";
    return;
  }
  siteRule = await effectiveRule(host);
  siteEl.checked = granted && ruleSaysOn();
  siteHostEl.textContent = siteLine(host, siteRule);
  siteHostEl.title = host;
}

/**
 * Ask the page what it is doing. A site nothing has been granted for holds no content
 * script to ask — that is not an error and not an unsupported page, it is simply Anagram
 * being off, which is what the button below then offers to change for this one page.
 */
async function refreshStatus(tabId: number | undefined): Promise<void> {
  // There is nobody to ask on a site nothing has been granted for, and asking anyway
  // would only cost the popup a rejection to swallow.
  const canAsk = tabId != null && !(facts.pattern !== null && !granted);
  facts.tab = null;
  counts = null;
  if (canAsk) {
    try {
      const state = (await browser.tabs.sendMessage(tabId, {
        action: ACTIONS.GET_TAB_STATE,
      })) as TabState | undefined;
      if (!state) throw new Error("no state");
      // Chrome's PDF tab answers with pdf:true; its own URL is the other evidence, read
      // in init(). A `file:` PDF is neither: no content script may read it back for the
      // reading mode, so it is not offered (facts.pattern is null there).
      if (state.pdf && facts.pattern) facts.pdfTab = true;
      facts.tab = { enabled: state.enabled };
      counts = state.enabled ? state : null;
    } catch {
      /* no content script there, or the page tore it down — Anagram is not running */
    }
  }
  asked = true;
  paint();
}

/** The reading mode with no document in it: its empty state is a drop zone and a picker. */
function openEmptyReader(): void {
  void browser.tabs.create({ url: browser.runtime.getURL(READER_PAGE as PublicPath) });
}

async function init(): Promise<void> {
  localizePage();
  followSystemTheme();
  const tab = await activeTab();
  const host = hostOf(tab?.url);
  facts.hasTab = tab != null;
  facts.pattern = sitePattern(tab?.url);
  // Only a PDF served over http(s) can be handed to the reading mode: the bytes come from
  // the tab showing it, and a `file:` page may not re-read itself (lib/pdf/handoff.ts).
  facts.pdfTab = facts.pattern !== null && looksLikePdfUrl(tab?.url);

  highlightsEl.checked = await settings.showHighlights.getValue();
  markStyleEl.value = normalizeMarkStyle(await settings.markStyle.getValue());
  scopeEl.value = await settings.analysisScope.getValue();
  checkSeg(displayModeEls, await settings.displayMode.getValue());
  // A page no extension may be granted — a browser page, the web store, a file — has
  // nothing this switch could do.
  siteEl.disabled = !host || facts.pattern === null;
  await refreshSite(host);

  enabledEl.addEventListener("change", async () => {
    const want = enabledEl.checked;
    // Turning it on while Anagram may not read every site is asking for every site — and
    // the asking has to be the first thing this click does, with nothing awaited before
    // it (see refreshSite). Chrome closes the popup to show its prompt, so what follows a
    // yes happens in the worker: it registers the content script and injects the open
    // tabs (lib/access/worker.ts). The setting is written either way; a no leaves it on
    // and the switch, painted from both, goes back to off.
    const asked = want && !allGranted ? requestAccess([...ALL_SITES]) : null;
    await settings.enabled.setValue(want);
    if (asked) await asked;
    await refreshSite(host); // a host with no rule of its own follows the new default
    sendToTab(tab?.id, { action: ACTIONS.SET_ENABLED, value: siteEl.checked });
    setTimeout(() => void refreshStatus(tab?.id), 400);
  });

  siteEl.addEventListener("change", () => {
    if (!host) return;
    const want = siteEl.checked;
    // The rules first, and only where they disagree with the switch: a site that is off
    // merely for want of access must not collect a rule saying what the default already
    // says. Nothing is awaited here — see refreshSite.
    let written: Promise<void> = Promise.resolve();
    if (want !== ruleSaysOn()) {
      const write = switchWrite(host, siteRule, globalDefault, want);
      written = write.kind === "clear" ? clearSiteOverride(write.host) : setSiteOverride(write.host, write.mode);
    }
    if (want && facts.pattern && !granted) {
      // Turning it on for a site Anagram may not read is asking for the site. The prompt
      // is the browser's and the explanation is the browser's; Chrome closes the popup to
      // show it, so everything that follows a yes happens in the worker — the content
      // script is registered and the open tabs are injected there (lib/access/worker.ts).
      void requestAccess([facts.pattern]).then((ok) => {
        if (ok) granted = true;
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

  highlightsEl.addEventListener("change", () => {
    // The content script watches this setting and re-derives text marks live.
    void settings.showHighlights.setValue(highlightsEl.checked);
  });

  markStyleEl.addEventListener("change", () => {
    void settings.markStyle.setValue(markStyleEl.value as MarkStyle);
  });

  scopeEl.addEventListener("change", () => {
    void settings.analysisScope.setValue(scopeEl.value as "page" | "main");
  });

  bindSeg(displayModeEls, (v) => void settings.displayMode.setValue(v as "all" | "flagged"));

  actionEl.addEventListener("click", () => {
    switch (lead.action) {
      case "analyze":
        // A page Anagram is off for — by a rule, or because nothing was ever granted for
        // its site — is analyzed ONCE, with no setting written and no permission asked:
        // opening this popup gave the extension `activeTab`, which is all the worker needs.
        if (tab?.id != null) void browser.runtime.sendMessage({ action: ACTIONS.ANALYZE_TAB, tabId: tab.id });
        window.close(); // the answer is on the page, not in here
        return;
      case "readPdf":
        void browser.runtime.sendMessage({
          action: ACTIONS.OPEN_PDF_READER,
          url: tab?.url,
          tabId: tab?.id,
        });
        window.close();
        return;
      case "openReader":
        openEmptyReader();
        window.close();
        return;
      case "retry":
        void browser.runtime.openOptionsPage();
        window.close();
        return;
      case "rescan":
        sendToTab(tab?.id, { action: ACTIONS.RESCAN });
        counts = null; // "Rescanning…" until the page reports again
        paint();
        setTimeout(() => void refreshStatus(tab?.id), 1500);
        return;
    }
  });

  gearEl.addEventListener("click", () => {
    void browser.runtime.openOptionsPage();
  });

  void refreshStatus(tab?.id);
  void refreshBackend();
}

void init();
