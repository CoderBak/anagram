// The engine panel of the oneclick flavor, in place of lib/ui/componentSettings.ts: the
// setup page and Settings import either as "#flavor/engine-panel" (scripts/flavor.mjs), so
// this exports the same names with the same types. There is no install command: a status
// line read from the in-browser engine through the same contract `status` operation the
// local engine answers. A placeholder until the engine's download and progress UI lands.
import { t, type MessageKey } from "../i18n";
import { requestComponent, type ComponentReply, type ComponentSnapshot } from "../backend/nativeClient";
import "./componentSettings.css";

const stateKeys: Record<ComponentSnapshot["state"], MessageKey> = {
  starting: "componentStarting", needs_models: "componentNeedsModels", downloading: "componentDownloading",
  paused: "componentPaused", loading: "componentStarting", benchmarking: "runtimeBenchmarking",
  ready: "componentReady", idle: "componentReady", stopped: "componentStopped",
  updating: "componentUpdating", uninstalling: "componentRemoving", error: "componentNeedsAttention",
};

export function componentReady(s: ComponentSnapshot): boolean {
  return s.state === "ready" || s.state === "idle";
}

export function componentConnectionLabel(reply: ComponentReply): string {
  return reply.kind === "ok" ? t(stateKeys[reply.snapshot.state]) : t("engineInBrowserNotReady");
}

export function mountComponentSettings(host: HTMLElement, onUpdate?: (reply: ComponentReply) => void): { refresh(): void; destroy(): void } {
  host.classList.add("component-settings");
  host.dataset.engine = "in-browser";
  const summary = document.createElement("p");
  summary.className = "component-status"; summary.setAttribute("role", "status");
  summary.textContent = t("componentStarting");
  const intro = document.createElement("p");
  intro.textContent = t("engineInBrowserIntro");
  host.replaceChildren(summary, intro);

  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let destroyed = false;
  async function poll(): Promise<void> {
    if (timer !== undefined) clearTimeout(timer);
    controller?.abort();
    if (destroyed || document.visibilityState !== "visible") return;
    const ac = new AbortController(); controller = ac;
    const reply = await requestComponent("status", {}, ac.signal);
    if (destroyed || ac.signal.aborted) return;
    summary.textContent = componentConnectionLabel(reply);
    onUpdate?.(reply);
    timer = setTimeout(() => void poll(), reply.kind === "ok" && componentReady(reply.snapshot) ? 15_000 : 3_000);
  }
  const visibility = (): void => void poll();
  document.addEventListener("visibilitychange", visibility);
  void poll();
  return { refresh: () => void poll(), destroy() {
    destroyed = true; controller?.abort(); if (timer !== undefined) clearTimeout(timer);
    document.removeEventListener("visibilitychange", visibility);
  } };
}
