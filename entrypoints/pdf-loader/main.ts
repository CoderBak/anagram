import { browser } from "#imports";
import { SOURCE_LOADER_PORT, SOURCE_CAP, SOURCE_TIMEOUT } from "../../lib/pdf/sourceTransfer";
import { hasPdfSourceAccess } from "../../lib/pdf/sourceAccess";
import { loaderConnectPolicy, readAuthorizedPdf, readFailure } from "../../lib/pdf/loader";
import type { HandoffFailure } from "../../lib/pdf/handoff";

// Only the exact iframe created by the live reader receives this separate DOM proof.
const ticket = new URL(location.href).searchParams.get("ticket") ?? "";
if (window.parent !== window && /^[a-f0-9]{32}$/.test(ticket)) {
  const target = location.origin === "null" ? "*" : location.origin;
  const authorize = (event: MessageEvent) => {
    if (event.source !== window.parent || event.origin !== location.origin || event.data?.kind !== "anagram-pdf-loader-authorize" ||
        event.data?.ticket !== ticket || typeof event.data.proof !== "string" || !/^[a-f0-9]{32}$/.test(event.data.proof)) return;
    window.removeEventListener("message", authorize);
    const port = browser.runtime.connect({name: SOURCE_LOADER_PORT});
    const stopped = new AbortController(); let started = false;
    const stop = () => stopped.abort(), timer = setTimeout(stop, SOURCE_TIMEOUT);
    port.onDisconnect.addListener(stop);
    window.addEventListener("pagehide", () => { clearTimeout(timer); stop(); port.disconnect(); }, {once: true});
    const reply = (result: Uint8Array | HandoffFailure) => {
      if (stopped.signal.aborted) return;
      if (typeof result !== "string") window.parent.postMessage({kind: "anagram-pdf-loaded", ticket, bytes: result.buffer}, target, [result.buffer]);
      else window.parent.postMessage({kind: "anagram-pdf-loaded", ticket, error: result}, target);
    };
    port.onMessage.addListener((value) => {
      if (started) { stop(); return; } started = true;
      void (async () => {
        if (!value || Object.keys(value).length !== 2 || typeof value.source !== "string" || value.cap !== SOURCE_CAP) { reply("read"); return; }
        const policy = loaderConnectPolicy(value.source);
        if (!policy || !await hasPdfSourceAccess(value.source) || stopped.signal.aborted) { reply("read"); return; }
        const meta = document.createElement("meta"); meta.httpEquiv = "Content-Security-Policy"; meta.content = policy; document.head.append(meta);
        reply(await readAuthorizedPdf(value.source, stopped.signal, value.cap));
      })().catch((error) => reply(readFailure(error)));
    });
    port.postMessage({ticket, proof: event.data.proof});
  };
  window.addEventListener("message", authorize);
  window.parent.postMessage({kind: "anagram-pdf-loader-ready", ticket}, target);
}
