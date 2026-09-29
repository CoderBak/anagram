// entrypoints/engine/main.ts — the offscreen document: one engine worker, reached by port.
//
// The background (lib/webengine/client.ts) creates this document with chrome.offscreen
// and connects a runtime port named ENGINE_PORT to it. Every message on such a port is a
// native-host request for the worker; every reply goes back on the port it came from.
// The document has no UI and stays for the extension's lifetime, so the model stays
// loaded across the background's own sleeps; the engine lets it go itself when idle.
import { browser } from "#imports";
import { EngineHost } from "../../lib/webengine/host";
import { ENGINE_PORT } from "../../lib/webengine/protocol";
import { WORKER_URL, workerInit } from "../../lib/webengine/assets";
import { tierFromQuery } from "../../lib/webengine/tier";

// The tier the background chose is in the address it created this document at.
const host = new EngineHost({ workerUrl: WORKER_URL(), init: workerInit(tierFromQuery(location.search)) });
const owners = new Map<string, { postMessage(message: unknown): void; disconnect(): void }>();

host.onMessage.addListener((reply) => {
  const id = (reply as { id?: unknown })?.id;
  if (typeof id !== "string") return;
  const port = owners.get(id);
  owners.delete(id);
  try { port?.postMessage(reply); } catch { /* the port closed */ }
});
host.onDisconnect.addListener(() => {
  // The worker failed: every port learns it at once, and reconnects to a fresh worker.
  for (const port of new Set(owners.values())) { try { port.disconnect(); } catch { /* gone */ } }
  owners.clear();
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== ENGINE_PORT || port.sender?.id !== browser.runtime.id) return;
  port.onMessage.addListener((message: unknown) => {
    const id = (message as { id?: unknown })?.id;
    if (typeof id === "string") owners.set(id, port);
    host.postMessage(message);
  });
  port.onDisconnect.addListener(() => {
    for (const [id, owner] of owners) if (owner === port) owners.delete(id);
  });
});
