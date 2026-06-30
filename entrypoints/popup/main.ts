// entrypoints/popup/main.ts — popup logic (spec §4.9).
// Global on/off (settings.enabled), per-site on/off (siteOverrides keyed on the active
// tab's hostname), and a Rescan button. Renders from the active tab's state and sends
// SET_ENABLED / RESCAN actions straight to the active tab's content script.
import { browser } from "#imports";
import {
  settings,
  enabledForSite,
  setSiteOverride,
} from "../../lib/settings/settings";
import { ACTIONS } from "../../lib/messaging/protocol";
import type { ControlMessage } from "../../lib/messaging/protocol";

const enabledEl = document.getElementById("enabled") as HTMLInputElement;
const siteEl = document.getElementById("siteEnabled") as HTMLInputElement;
const rescanEl = document.getElementById("rescan") as HTMLButtonElement;

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

async function init(): Promise<void> {
  const tab = await activeTab();
  const host = hostOf(tab?.url);

  enabledEl.checked = await settings.enabled.getValue();
  siteEl.checked = host ? await enabledForSite(host) : enabledEl.checked;
  siteEl.disabled = !host;

  enabledEl.addEventListener("change", async () => {
    await settings.enabled.setValue(enabledEl.checked);
    const effective = host ? await enabledForSite(host) : enabledEl.checked;
    siteEl.checked = effective;
    sendToTab(tab?.id, { action: ACTIONS.SET_ENABLED, value: effective });
  });

  siteEl.addEventListener("change", async () => {
    if (!host) return;
    await setSiteOverride(host, siteEl.checked ? "on" : "off");
    sendToTab(tab?.id, { action: ACTIONS.SET_ENABLED, value: siteEl.checked });
  });

  rescanEl.addEventListener("click", () => {
    sendToTab(tab?.id, { action: ACTIONS.RESCAN });
  });
}

void init();
