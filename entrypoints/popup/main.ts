// entrypoints/popup/main.ts — popup logic.
// Global on/off, per-site on/off (siteOverrides keyed on the active tab's hostname),
// display mode / mark-text / marking-style / analysis-scope controls (all applied
// live via settings watches in the content script), scored + flagged status line
// (GET_TAB_STATE), Rescan, and a gear to the full options page.
import { browser } from "#imports";
import {
  settings,
  enabledForSite,
  setSiteOverride,
} from "../../lib/settings/settings";
import { ACTIONS } from "../../lib/messaging/protocol";
import type { ControlMessage, TabState } from "../../lib/messaging/protocol";

const enabledEl = document.getElementById("enabled") as HTMLInputElement;
const siteEl = document.getElementById("siteEnabled") as HTMLInputElement;
const siteHostEl = document.getElementById("siteHost") as HTMLElement;
const highlightsEl = document.getElementById("highlights") as HTMLInputElement;
const markStyleEl = document.getElementById("markStyle") as HTMLSelectElement;
const rescanEl = document.getElementById("rescan") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;
const gearEl = document.getElementById("gear") as HTMLButtonElement;
// Segmented controls are radio groups (keyboard: arrow keys within the group).
const displayModeEls = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="displayMode"]'),
);
const scopeEls = Array.from(
  document.querySelectorAll<HTMLInputElement>('input[name="analysisScope"]'),
);

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

function checkSeg(els: HTMLInputElement[], value: string): void {
  for (const el of els) el.checked = el.value === value;
}

function setStatusText(text: string): void {
  statusEl.textContent = text;
}

function showCounts(state: TabState): void {
  const flaggedEl = document.createElement("span");
  flaggedEl.textContent = `${state.flagged} flagged`;
  if (state.flagged > 0) flaggedEl.classList.add("flagged");
  statusEl.replaceChildren(
    document.createTextNode(
      `${state.scored} paragraph${state.scored === 1 ? "" : "s"} analyzed · `,
    ),
    flaggedEl,
  );
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

  for (const el of displayModeEls) {
    el.addEventListener("change", () => {
      if (el.checked) {
        void settings.displayMode.setValue(el.value as "all" | "flagged");
      }
    });
  }

  for (const el of scopeEls) {
    el.addEventListener("change", () => {
      if (el.checked) {
        void settings.analysisScope.setValue(el.value as "page" | "main");
      }
    });
  }

  rescanEl.addEventListener("click", () => {
    sendToTab(tab?.id, { action: ACTIONS.RESCAN });
    setStatusText("Rescanning…");
    setTimeout(() => void refreshStatus(tab?.id), 1500);
  });

  gearEl.addEventListener("click", () => {
    void browser.runtime.openOptionsPage();
  });

  void refreshStatus(tab?.id);
}

void init();
