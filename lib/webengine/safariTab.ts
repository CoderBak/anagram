// Safari has no offscreen document. A visible extension tab owns the GPU worker while
// the background service worker sleeps. Only this module creates or removes that tab.
import { browser } from "#imports";
import type { Browser } from "wxt/browser";
import { type NativePort } from "../backend/portTransport";
import { ENGINE_PORT, ENGINE_READY, ENGINE_FAILED } from "./protocol";
import { engineTierChoice } from "./tierStore";
import { tierQuery } from "./tier";

const START_TIMEOUT_MS = 20_000;
const CHANNEL = /^[a-f0-9-]{36}$/;
type Tab = Browser.tabs.Tab;

function managedUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const page = new URL(browser.runtime.getURL("/engine.html"));
    return url.protocol === page.protocol && url.host === page.host && url.pathname === page.pathname &&
      CHANNEL.test(url.searchParams.get("channel") ?? "") ? url : null;
  } catch { return null; }
}

async function engineTabs(): Promise<Tab[]> {
  // Own extension pages are readable without requesting access to browsing history.
  return (await browser.tabs.query({})).filter((tab) => managedUrl(tab.pendingUrl ?? tab.url));
}

let creating: Promise<{ tabId: number; channel: string }> | null = null;

function loaded(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(updated);
      browser.tabs.onRemoved.removeListener(removed);
      if (error) reject(error); else resolve();
    };
    const updated = (id: number, change: { status?: string; url?: string }): void => {
      if (id !== tabId) return;
      if (change.url && !managedUrl(change.url)) finish(new Error("The engine tab navigated away"));
      else if (change.status === "complete") finish();
    };
    const removed = (id: number): void => { if (id === tabId) finish(new Error("The engine tab was closed")); };
    const timer = setTimeout(() => finish(new Error("The engine tab did not load")), START_TIMEOUT_MS);
    browser.tabs.onUpdated.addListener(updated);
    browser.tabs.onRemoved.addListener(removed);
    void browser.tabs.get(tabId).then((tab) => {
      if (!managedUrl(tab.pendingUrl ?? tab.url)) finish(new Error("The engine tab is unavailable"));
      else if (tab.status === "complete" && !tab.pendingUrl) finish();
    }, () => finish(new Error("The engine tab was closed")));
  });
}

/** Concurrent requests and background restarts reuse the same tab, without stealing focus. */
async function ensureTab(): Promise<{ tabId: number; channel: string }> {
  return creating ??= (async () => {
    const tier = tierQuery(await engineTierChoice.getValue().catch(() => null));
    const desired = new URL(browser.runtime.getURL("/engine.html") + tier);
    const tabs = await engineTabs();
    let tab = tabs.find((candidate) => {
      const url = managedUrl(candidate.pendingUrl ?? candidate.url)!;
      url.searchParams.delete("channel");
      return url.href === desired.href;
    });
    if (!tab) {
      desired.searchParams.set("channel", crypto.randomUUID());
      tab = await browser.tabs.create({ url: desired.href, active: false, pinned: true });
    } else if (tab.discarded && tab.id !== undefined) {
      tab = await browser.tabs.update(tab.id, { url: tab.url });
    }
    if (!tab || tab.id === undefined) throw new Error("Safari did not create the engine tab");
    await loaded(tab.id);
    const current = await browser.tabs.get(tab.id);
    const channel = managedUrl(current.url)?.searchParams.get("channel");
    if (!channel) throw new Error("The engine tab navigated away");
    return { tabId: tab.id, channel };
  })().finally(() => { creating = null; });
}

/** A handshake prevents queued model requests from being lost while the tab starts. */
export function safariEnginePort(): NativePort {
  let port: ReturnType<typeof browser.runtime.connect> | null = null;
  let ended = false;
  let ready = false;
  const queue: unknown[] = [];
  const messages = new Set<(value: unknown) => void>();
  const disconnects = new Set<() => void>();
  const stop = (reason?: string): void => {
    if (ended) return;
    ended = true;
    clearTimeout(timer);
    queue.length = 0;
    const old = port; port = null;
    try { old?.disconnect(); } catch { /* already gone */ }
    if (reason) {
      out.error = { message: reason };
      console.error("Anagram Safari engine:", reason);
      for (const fn of disconnects) fn();
    }
  };
  const timer = setTimeout(() => stop("Safari's engine tab did not answer"), START_TIMEOUT_MS);
  const out: NativePort = {
    postMessage(message) {
      if (ended) throw new Error("Engine tab disconnected");
      if (ready && port) port.postMessage(message); else queue.push(message);
    },
    disconnect: () => stop(),
    onMessage: { addListener: (fn) => { messages.add(fn); } },
    onDisconnect: { addListener: (fn) => { disconnects.add(fn); } },
  };
  void ensureTab().then(({ tabId, channel }) => {
    if (ended) return;
    const connected = browser.runtime.connect({ name: `${ENGINE_PORT}:${channel}:${tabId}` });
    port = connected;
    connected.onDisconnect.addListener(() => stop(browser.runtime.lastError?.message ??
      (connected as { error?: { message?: string } }).error?.message ?? "Safari's engine tab disconnected"));
    connected.onMessage.addListener((message: unknown) => {
      if (ended) return;
      const control = message as { type?: unknown; message?: unknown } | null;
      if (control?.type === ENGINE_FAILED) {
        stop(typeof control.message === "string" ? control.message.slice(0, 2000) : "Safari's engine worker failed");
        return;
      }
      if (!ready) {
        if (control?.type !== ENGINE_READY) return;
        ready = true;
        clearTimeout(timer);
        try { for (const pending of queue.splice(0)) connected.postMessage(pending); }
        catch { stop("Safari's engine tab disconnected"); }
      } else {
        for (const fn of messages) fn(message);
      }
    });
  }).catch((error: unknown) => stop(`Safari engine unavailable: ${error instanceof Error ? error.message : String(error)}`));
  return out;
}

export async function safariEngineRunning(): Promise<boolean> {
  try { return (await engineTabs()).some((tab) => !tab.discarded); } catch { return false; }
}

export async function closeSafariEngine(): Promise<void> {
  await creating?.catch(() => undefined);
  for (const tab of await engineTabs()) {
    if (tab.id !== undefined) await browser.tabs.remove(tab.id).catch(() => undefined);
  }
}
