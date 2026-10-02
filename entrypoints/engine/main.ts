// entrypoints/engine/main.ts — one engine worker, reached by the background's port.
//
// Chrome creates an offscreen document; Safari creates a pinned extension tab. The
// background connects a private runtime port to it. Every message on that port is a
// native-host request for the worker; every reply goes back on the port it came from.
// The document stays across the background's sleeps, so the model stays
// loaded across the background's own sleeps; the engine lets it go itself when idle.
import { browser } from "#imports";
import { EngineHost } from "../../lib/webengine/host";
import { ENGINE_PORT, ENGINE_READY, ENGINE_FAILED } from "../../lib/webengine/protocol";
import { WORKER_URL, workerInit } from "../../lib/webengine/assets";
import { tierFromQuery } from "../../lib/webengine/tier";
import { IS_SAFARI } from "../../lib/surface";
import { engineOwner } from "../../lib/webengine/owner";
import { mountSafariEnginePage } from "../../lib/ui/safariEnginePage";

// The tier the background chose is in the address it created this document at.
const host = new EngineHost({ workerUrl: WORKER_URL(), init: workerInit(tierFromQuery(location.search)) });
const owners = new Map<string, { postMessage(message: unknown): void; disconnect(): void }>();
const connections = new Set<{ postMessage(message: unknown): void; disconnect(): void }>();
const channel = new URLSearchParams(location.search).get("channel");
// A duplicated/restored tab can have the same channel URL. Its tab ID prevents two
// documents from accepting the same request stream and writing the model concurrently.
const safariPortName = IS_SAFARI
  ? browser.tabs.getCurrent().then((tab) => channel && tab?.id !== undefined ? `${ENGINE_PORT}:${channel}:${tab.id}` : null).catch(() => null)
  : null;
if (IS_SAFARI) mountSafariEnginePage();

host.onMessage.addListener((reply) => {
  const id = (reply as { id?: unknown })?.id;
  if (typeof id !== "string") return;
  const port = owners.get(id);
  owners.delete(id);
  try { port?.postMessage(reply); } catch { /* the port closed */ }
});
host.onDisconnect.addListener(() => {
  // The worker failed: every port learns it at once, and reconnects to a fresh worker.
  const message = host.error?.message ?? "The engine worker disconnected";
  if (IS_SAFARI) console.error("Anagram Safari engine:", message);
  for (const port of connections) {
    try {
      if (IS_SAFARI) port.postMessage({ type: ENGINE_FAILED, message });
      else port.disconnect();
    } catch { try { port.disconnect(); } catch { /* gone */ } }
  }
  connections.clear();
  owners.clear();
});

browser.runtime.onConnect.addListener((port) => {
  if (!engineOwner(port.sender, browser.runtime.id, browser.runtime.getURL("/"))) {
    if (IS_SAFARI && port.name.startsWith(ENGINE_PORT + ":")) {
      console.error("Anagram Safari engine: rejected connection sender", port.sender);
      port.disconnect();
    }
    return;
  }
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    connections.delete(port);
    for (const [id, owner] of owners) if (owner === port) owners.delete(id);
  });
  const accept = (name: string | null): void => {
    if (disconnected || !name || port.name !== name) return;
    connections.add(port);
    port.onMessage.addListener((message: unknown) => {
      const id = (message as { id?: unknown })?.id;
      if (typeof id === "string") owners.set(id, port);
      try { host.postMessage(message); }
      catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        if (IS_SAFARI) {
          console.error("Anagram Safari engine:", detail);
          port.postMessage({ type: ENGINE_FAILED, message: detail.slice(0, 2000) });
        } else port.disconnect();
      }
    });
    if (IS_SAFARI) {
      try { port.postMessage({ type: ENGINE_READY }); } catch { connections.delete(port); }
    }
  };
  if (safariPortName) void safariPortName.then(accept);
  else accept(ENGINE_PORT);
});

window.addEventListener("pagehide", () => host.disconnect());
