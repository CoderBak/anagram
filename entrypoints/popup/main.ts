// entrypoints/popup/main.ts — popup logic.
// Global on/off, per-site on/off (siteOverrides keyed on the active tab's hostname),
// underline toggle (live via settings watch in the content script), scored-count
// status line (GET_TAB_STATE), Rescan, and a gear to the full options page.
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
const highlightsEl = document.getElementById("highlights") as HTMLInputElement;
const rescanEl = document.getElementById("rescan") as HTMLButtonElement;
const statusEl = document.getElementById("status") as HTMLElement;
const gearEl = document.getElementById("gear") as HTMLButtonElement;

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

async function refreshStatus(tabId: number | undefined): Promise<void> {
  if (tabId == null) {
    statusEl.textContent = "No active tab.";
    return;
  }
  try {
    const state = (await browser.tabs.sendMessage(tabId, {
      action: ACTIONS.GET_TAB_STATE,
    })) as TabState | undefined;
    if (!state) throw new Error("no state");
    statusEl.textContent = state.enabled
      ? `${state.scored} unit${state.scored === 1 ? "" : "s"} analyzed on this page.`
      : "Detection is off for this page.";
  } catch {
    statusEl.textContent = "Not available on this page.";
  }
}

async function init(): Promise<void> {
  const tab = await activeTab();
  const host = hostOf(tab?.url);

  enabledEl.checked = await settings.enabled.getValue();
  highlightsEl.checked = await settings.showHighlights.getValue();
  siteEl.checked = host ? await enabledForSite(host) : enabledEl.checked;
  siteEl.disabled = !host;

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
    // The content script watches this setting and re-derives underlines live.
    void settings.showHighlights.setValue(highlightsEl.checked);
  });

  rescanEl.addEventListener("click", () => {
    sendToTab(tab?.id, { action: ACTIONS.RESCAN });
    statusEl.textContent = "Rescanning…";
    setTimeout(() => void refreshStatus(tab?.id), 1500);
  });

  gearEl.addEventListener("click", () => {
    void browser.runtime.openOptionsPage();
  });

  void refreshStatus(tab?.id);
}

void init();
