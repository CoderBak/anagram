// entrypoints/popup/main.ts — popup logic.
// Global on/off, per-site on/off (siteOverrides keyed on the active tab's hostname),
// display mode / mark-text / marking-style / analysis-scope controls (all applied
// live via settings watches in the content script), scored + flagged status line
// (GET_TAB_STATE), Rescan, and a gear to the full options page.
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import {
  settings,
  enabledForSite,
  setSiteOverride,
} from "../../lib/settings/settings";
import { ACTIONS } from "../../lib/messaging/protocol";
import type { BackendStatus, ControlMessage, TabState } from "../../lib/messaging/protocol";

const enabledEl = document.getElementById("enabled") as HTMLInputElement;
const siteEl = document.getElementById("siteEnabled") as HTMLInputElement;
const siteHostEl = document.getElementById("siteHost") as HTMLElement;
const highlightsEl = document.getElementById("highlights") as HTMLInputElement;
const markStyleEl = document.getElementById("markStyle") as HTMLSelectElement;
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
  flaggedEl.textContent = `${state.flagged} flagged`;
  if (state.flagged > 0) flaggedEl.classList.add("flagged");
  const analyzed = state.scored - (state.unsupported ?? 0);
  statusEl.replaceChildren(
    document.createTextNode(`${analyzed} paragraph${analyzed === 1 ? "" : "s"} analyzed · `),
    flaggedEl,
    document.createTextNode(state.unsupported ? ` · ${state.unsupported} not English` : ""),
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
      backendEl.replaceChildren("Model: ", b, ` · local${s.server.device ? " · " + s.server.device : ""}`);
    } else {
      b.textContent = "Daemon not running";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "btn";
      retry.dataset.variant = "outline";
      retry.dataset.size = "xs";
      retry.textContent = "Retry";
      retry.addEventListener("click", () => {
        retry.disabled = true;
        void refreshBackend(tabId, true).then(() => {
          sendToTab(tabId, { action: ACTIONS.RETRY_BACKEND });
          setTimeout(() => void refreshStatus(tabId), 800);
        });
      });
      backendEl.replaceChildren(b, " — run: anagram start ", retry);
    }
  } catch {
    backendEl.textContent = "";
  }
}

async function refreshStatus(tabId: number | undefined): Promise<void> {
  if (tabId == null) {
    setStatusText("No active tab.");
    return;
  }
  try {
    const state = (await browser.tabs.sendMessage(tabId, {
      action: ACTIONS.GET_TAB_STATE,
    })) as TabState | undefined;
    if (!state) throw new Error("no state");
    if (state.enabled) showCounts(state);
    else setStatusText("Detection is off for this page.");
  } catch {
    setStatusText("Not available on this page.");
  }
}

async function init(): Promise<void> {
  followSystemTheme();
  const tab = await activeTab();
  const host = hostOf(tab?.url);

  enabledEl.checked = await settings.enabled.getValue();
  highlightsEl.checked = await settings.showHighlights.getValue();
  markStyleEl.value = await settings.markStyle.getValue();
  checkSeg(displayModeEls, await settings.displayMode.getValue());
  checkSeg(scopeEls, await settings.analysisScope.getValue());
  siteEl.checked = host ? await enabledForSite(host) : enabledEl.checked;
  siteEl.disabled = !host;
  siteHostEl.textContent = host ? `on ${host}` : "unavailable here";
  siteHostEl.title = host;

  enabledEl.addEventListener("change", async () => {
    await settings.enabled.setValue(enabledEl.checked);
    const effective = host ? await enabledForSite(host) : enabledEl.checked;
    siteEl.checked = effective;
    sendToTab(tab?.id, { action: ACTIONS.SET_ENABLED, value: effective });
    setTimeout(() => void refreshStatus(tab?.id), 400);
  });

  siteEl.addEventListener("change", async () => {
    if (!host) return;
    await setSiteOverride(host, siteEl.checked ? "on" : "off");
    sendToTab(tab?.id, { action: ACTIONS.SET_ENABLED, value: siteEl.checked });
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

  rescanEl.addEventListener("click", () => {
    sendToTab(tab?.id, { action: ACTIONS.RESCAN });
    setStatusText("Rescanning…");
    setTimeout(() => void refreshStatus(tab?.id), 1500);
  });

  gearEl.addEventListener("click", () => {
    void browser.runtime.openOptionsPage();
  });

  void refreshStatus(tab?.id);
  void refreshBackend(tab?.id);
}

void init();
