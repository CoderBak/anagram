// entrypoints/popup/main.ts — popup logic.
// Global on/off, per-site on/off (the rule that decides the active tab, which a parent
// domain may own — see ./siteSwitch.ts),
// display mode / mark-text / marking-style / analysis-scope controls (all applied
// live via settings watches in the content script), scored + flagged status line
// (GET_TAB_STATE), Rescan, and a gear to the full options page.
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { localizePage } from "../../lib/ui/localize";
import { t, tn } from "../../lib/i18n";
import {
  settings,
  clearSiteOverride,
  effectiveRule,
  setSiteOverride,
} from "../../lib/settings/settings";
import { siteLine, switchWrite } from "./siteSwitch";
import { ACTIONS } from "../../lib/messaging/protocol";
import type { BackendStatus, ControlMessage, TabState } from "../../lib/messaging/protocol";
import { looksLikePdfUrl } from "../../lib/pdf/source";

const enabledEl = document.getElementById("enabled") as HTMLInputElement;
const siteEl = document.getElementById("siteEnabled") as HTMLInputElement;
const siteHostEl = document.getElementById("siteHost") as HTMLElement;
const highlightsEl = document.getElementById("highlights") as HTMLInputElement;
const markStyleEl = document.getElementById("markStyle") as HTMLSelectElement;
const readPdfEl = document.getElementById("readPdf") as HTMLButtonElement;
const rescanEl = document.getElementById("rescan") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;
const gearEl = document.getElementById("gear") as HTMLButtonElement;
const backendEl = document.getElementById("backend") as HTMLElement;
// Segmented controls are Basecoat tab lists (buttons with aria-selected).
const displayModeEls = segButtons("displayMode");
const scopeEls = segButtons("analysisScope");

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

function setStatusText(text: string): void {
  statusEl.textContent = text;
}

function showCounts(state: TabState): void {
  const flaggedEl = document.createElement("span");
  flaggedEl.textContent = t("popupFlaggedCount", state.flagged);
  if (state.flagged > 0) flaggedEl.classList.add("flagged");
  // A paragraph the daemon never answered for was not analyzed, and neither was one
  // the language gate refused — both are counted apart from the analyzed number.
  const unavailable = state.unavailable ?? 0;
  const analyzed = state.scored - (state.unsupported ?? 0) - unavailable;
  statusEl.replaceChildren(
    document.createTextNode(tn("popupAnalyzed", analyzed)),
    flaggedEl,
    document.createTextNode(state.unsupported ? t("popupNotEnglish", state.unsupported) : ""),
    document.createTextNode(unavailable ? t("popupUnavailable", unavailable) : ""),
  );
}

/** Is the local daemon scoring right now? Down → say so, offer Retry. */
async function refreshBackend(tabId: number | undefined, probe = false): Promise<void> {
  try {
    const s = (await browser.runtime.sendMessage({
      action: ACTIONS.GET_BACKEND_STATUS,
      probe,
    })) as BackendStatus | undefined;
    if (!s) throw new Error("no status");
    const b = document.createElement("b");
    backendEl.classList.toggle("down", s.active !== "server");
    if (s.active === "server" && s.model) {
      b.textContent = s.model.id;
      backendEl.replaceChildren(t("popupModel"), b, t("popupLocal") + (s.server.device ? " · " + s.server.device : ""));
    } else {
      // A daemon that answers with another contract major is there — it needs updating,
      // and telling the user to start it would send them down the wrong path.
      const mismatch = s.server.reason === "contract";
      b.textContent = mismatch ? t("popupDaemonMismatch") : t("popupDaemonDown");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn";
      retry.dataset.variant = "outline";
      retry.dataset.size = "xs";
      retry.textContent = t("popupRetry");
      retry.addEventListener("click", () => {
        retry.disabled = true;
        void refreshBackend(tabId, true).then(() => {
          sendToTab(tabId, { action: ACTIONS.RETRY_BACKEND });
          setTimeout(() => void refreshStatus(tabId), 800);
        });
      });
      backendEl.replaceChildren(b, mismatch ? t("popupRunUpdate") : t("popupRunStart"), retry);
    }
  } catch {
    backendEl.textContent = "";
  }
}

/**
 * Paint "This site" from the rule that actually decides this page: the switch shows that
 * rule's state (or the global default when no rule covers the host), and the line under it
 * names the site the rule belongs to — "on zhihu.com" on a zhuanlan.zhihu.com tab.
 */
async function refreshSite(host: string): Promise<void> {
  const globalDefault = await settings.enabled.getValue();
  if (!host) {
    siteEl.checked = globalDefault;
    siteHostEl.textContent = t("popupSiteUnavailable");
    siteHostEl.title = "";
    return;
  }
  const rule = await effectiveRule(host);
  siteEl.checked = rule ? rule.mode === "on" : globalDefault;
  siteHostEl.textContent = siteLine(host, rule);
  siteHostEl.title = host;
}

async function refreshStatus(tabId: number | undefined): Promise<void> {
  if (tabId == null) {
    setStatusText(t("popupNoTab"));
    return;
  }
  try {
    const state = (await browser.tabs.sendMessage(tabId, {
      action: ACTIONS.GET_TAB_STATE,
    })) as TabState | undefined;
    if (!state) throw new Error("no state");
    if (state.pdf) readPdfEl.hidden = false;
    if (state.enabled) showCounts(state);
    else setStatusText(t("popupOff"));
  } catch {
    setStatusText(t("popupUnsupportedPage"));
  }
}

async function init(): Promise<void> {
  localizePage();
  followSystemTheme();
  const tab = await activeTab();
  const host = hostOf(tab?.url);

  enabledEl.checked = await settings.enabled.getValue();
  highlightsEl.checked = await settings.showHighlights.getValue();
  markStyleEl.value = await settings.markStyle.getValue();
  checkSeg(displayModeEls, await settings.displayMode.getValue());
  checkSeg(scopeEls, await settings.analysisScope.getValue());
  siteEl.disabled = !host;
  await refreshSite(host);

  enabledEl.addEventListener("change", async () => {
    await settings.enabled.setValue(enabledEl.checked);
    await refreshSite(host); // a host with no rule of its own follows the new default
    sendToTab(tab?.id, { action: ACTIONS.SET_ENABLED, value: siteEl.checked });
    setTimeout(() => void refreshStatus(tab?.id), 400);
  });

  siteEl.addEventListener("change", async () => {
    if (!host) return;
    const want = siteEl.checked;
    const write = switchWrite(
      host,
      await effectiveRule(host),
      await settings.enabled.getValue(),
      want,
    );
    if (write.kind === "clear") await clearSiteOverride(write.host);
    else await setSiteOverride(write.host, write.mode);
    await refreshSite(host); // the line now names wherever the rule ended up
    sendToTab(tab?.id, { action: ACTIONS.SET_ENABLED, value: want });
    setTimeout(() => void refreshStatus(tab?.id), 400);
  });

  highlightsEl.addEventListener("change", () => {
    // The content script watches this setting and re-derives text marks live.
    void settings.showHighlights.setValue(highlightsEl.checked);
  });

  markStyleEl.addEventListener("change", () => {
    void settings.markStyle.setValue(
      markStyleEl.value as "both" | "underline" | "tint",
    );
  });

  bindSeg(displayModeEls, (v) => void settings.displayMode.setValue(v as "all" | "flagged"));
  bindSeg(scopeEls, (v) => void settings.analysisScope.setValue(v as "page" | "main"));

  // Chrome's PDF tab answers GET_TAB_STATE with pdf:true; Firefox's built-in viewer runs
  // no content script at all, so there the tab URL is the only evidence there is.
  if (looksLikePdfUrl(tab?.url)) readPdfEl.hidden = false;
  readPdfEl.addEventListener("click", () => {
    void browser.runtime.sendMessage({
      action: ACTIONS.OPEN_PDF_READER,
      url: tab?.url,
      tabId: tab?.id,
    });
    window.close();
  });

  rescanEl.addEventListener("click", () => {
    sendToTab(tab?.id, { action: ACTIONS.RESCAN });
    setStatusText(t("popupRescanning"));
    setTimeout(() => void refreshStatus(tab?.id), 1500);
  });

  gearEl.addEventListener("click", () => {
    void browser.runtime.openOptionsPage();
  });

  void refreshStatus(tab?.id);
  void refreshBackend(tab?.id);
}

void init();
