// The in-browser engine's panel, in place of lib/ui/componentSettings.ts when that engine is
// the one in use (lib/ui/engineCard.ts), so this exports the same names with the same types.
// There is nothing to install and no command: the download starts when the engine is picked,
// or by itself on a device with no choice (lib/webengine/autoSetup.ts), and one button asks
// the engine for `models.download` when it did not: the browser asks sites to save data or
// has too little room, which the panel says, or the person cancelled, paused or deleted. Hugging Face answers the engine's requests
// with CORS headers, so no host permission is asked for. The rest is the
// engine's `status`, told in plain words (lib/backend/engineSetup.ts): progress with speed
// and time left, Pause, Resume and Cancel, what stopped a download and how to fix it, and
// once it is ready, whether the model runs on the graphics card or the processor.
// Benchmarks, updates and uninstalling belong to the local engine and are not here.
// The setup page keeps it to a status line and the bar; Settings' row (`settings`) says the
// status in words and puts Delete model files and the idle unload beside the engine switch.
import { browser } from "#imports";
import { t, tn, type MessageKey } from "../i18n";
import { formatSize, timeLeft } from "./size";
import { progressBar } from "./progressBar";
import { requestComponent, type ComponentReply, type ComponentSnapshot } from "../backend/nativeClient";
import { percentOf, roomShort, setupStage, type SetupStage } from "../backend/engineSetup";
import { pinnedFiles } from "../webengine/pin";
import { ACTIONS, type BackendStatus } from "../messaging/protocol";
export { formatSize, timeLeft } from "./size";
import "./componentSettings.css";
import "./inBrowserEngine.css";

type Operation = "models.download" | "models.pause" | "models.delete" | "engine.resume" | "engine.settings";
/** Every byte setup downloads at FP32: the pinned files. The engine says its own total (the FP16
 *  tier's is half), which is what the panel shows once it has answered. */
const DOWNLOAD_BYTES = pinnedFiles().reduce((n, f) => n + f.size_bytes, 0);

const stageKeys: Record<SetupStage["stage"], MessageKey> = {
  needed: "engineNotSetUp", downloading: "engineDownloading", paused: "enginePaused", failed: "engineSetupFailed",
  loading: "engineLoading", ready: "componentReady", stopped: "componentStopped", error: "componentNeedsAttention",
};

export function componentReady(s: ComponentSnapshot): boolean {
  return s.state === "ready" || s.state === "idle";
}

export function componentConnectionLabel(reply: ComponentReply): string {
  return reply.kind === "ok" ? t(stageKeys[setupStage(reply.snapshot).stage]) : t("componentNeedsAttention");
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

/** Download speed over the last few seconds of polls, in bytes per second, or null before there is one. */
class Speedometer {
  private samples: Array<{ at: number; bytes: number }> = [];
  add(bytes: number): void {
    const at = performance.now();
    const last = this.samples[this.samples.length - 1];
    if (last && bytes < last.bytes) this.samples = [];
    this.samples.push({ at, bytes });
    while (this.samples.length > 2 && at - this.samples[0]!.at > 8_000) this.samples.shift();
  }
  reset(): void { this.samples = []; }
  get perSecond(): number | null {
    const first = this.samples[0], last = this.samples[this.samples.length - 1];
    if (!first || !last || last.at - first.at < 1_500 || last.bytes <= first.bytes) return null;
    return ((last.bytes - first.bytes) * 1000) / (last.at - first.at);
  }
}

export function mountComponentSettings(host: HTMLElement, onUpdate?: (reply: ComponentReply, crashed?: boolean) => void, options: { crashAction?: HTMLButtonElement; settings?: boolean; extra?: HTMLElement[] } = {}): { refresh(): void; destroy(): void } {
  const inSettings = options.settings === true;
  host.classList.add("component-settings");
  host.dataset.engine = "in-browser";
  const makeButton = (key: MessageKey, handler: () => void, variant?: string): HTMLButtonElement => {
    const button = element("button", t(key), "btn"); button.type = "button"; button.dataset.size = "sm";
    if (variant) button.dataset.variant = variant;
    button.addEventListener("click", handler); return button;
  };

  const summary = element("p", t("componentStarting"), "component-status"); summary.setAttribute("role", "status");
  const note = element("p", t("engineSaveData"), "engine-note"); note.hidden = true;
  // The FP16 tier is in use: said once, whatever the stage.
  const lighter = element("p", t("engineLighter"), "engine-note engine-lighter"); lighter.hidden = true;

  // The bar, its percentage and the buttons for the thing to do now share one row. One button
  // follows the stage (its label and act change, so keyboard focus stays on it from Set up to
  // Pause to Resume), and Cancel sits beside it while a download exists.
  const bar = progressBar(); bar.el.hidden = true;
  const percent = element("span", "", "engine-percent"); percent.hidden = true;
  const actions = element("div", undefined, "component-actions");
  let primaryAct: (() => void) | undefined;
  const primary = makeButton("engineSetUp", () => primaryAct?.());
  primary.id = "component-primary"; primary.hidden = true;
  const cancel = makeButton("engineCancelDownload", () => confirm("cancel"), "outline"); cancel.id = "engine-cancel"; cancel.hidden = true;
  actions.append(primary, cancel);
  const barRow = element("div", undefined, "engine-bar-row"); barRow.append(bar.el, percent, actions);
  // "880 MB of 1.4 GB, about 3 min left, 15 MB/s", then a short note of where the files come from.
  const progressText = element("p", undefined, "engine-progress"); progressText.id = "engine-progress"; progressText.hidden = true;
  const progressLine = element("span"); progressLine.className = "engine-line";
  const source = element("span", "", "engine-source"); source.id = "engine-source"; source.hidden = true;
  progressText.append(progressLine, source);
  bar.el.setAttribute("aria-describedby", progressText.id);
  const keepOpen = element("p", t("engineKeepOpen"), "engine-note engine-keepopen"); keepOpen.hidden = true;
  const where = element("p", "", "engine-where"); where.hidden = true;
  const error = element("p", undefined, "component-error"); error.setAttribute("role", "alert"); error.hidden = true;
  const details = element("p", undefined, "component-details"); details.hidden = true;

  // Settings: Delete model files, the idle unload and the engine switch, in one line.
  const controls = element("div", undefined, "component-inline"); controls.hidden = true;
  const idleLabel = element("label", t("componentIdleSetting")); idleLabel.htmlFor = "idleUnload";
  const idleSelect = element("select", undefined, "select"); idleSelect.id = "idleUnload";
  for (const seconds of [300, 60, 900, 0]) {
    const option = element("option", seconds ? tn("componentIdleMinutes", seconds / 60) : t("componentIdleNever"));
    option.value = String(seconds); idleSelect.append(option);
  }
  idleSelect.addEventListener("change", () => run("engine.settings"));
  const idleField = element("span", undefined, "inline-field"); idleField.append(idleLabel, idleSelect);
  const removeModel = makeButton("componentDeleteModels", () => confirm("delete"), "outline"); removeModel.id = "engine-delete";
  controls.append(...(options.extra ?? []), removeModel, idleField);

  const dialog = element("dialog", undefined, "component-dialog");
  const dialogTitle = element("h3"); dialogTitle.id = "component-confirm-title";
  const dialogText = element("p"); dialogText.id = "component-confirm-text";
  dialog.setAttribute("aria-labelledby", dialogTitle.id); dialog.setAttribute("aria-describedby", dialogText.id);
  const dialogActions = element("div", undefined, "component-actions");
  const keep = makeButton("buttonCancel", () => dialog.close(), "outline");
  const accept = makeButton("componentDeleteModels", () => { dialog.close(); if (confirming) run("models.delete"); }); accept.id = "engine-confirm";
  dialogActions.append(keep, accept); dialog.append(dialogTitle, dialogText, dialogActions);
  host.replaceChildren(summary, note, lighter, barRow, progressText, keepOpen, where, error, details, controls, dialog);

  let snapshot: ComponentSnapshot | undefined;
  let stage: SetupStage | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let destroyed = false, pending = false, checking = false, everConnected = false, crashed = false;
  /** Setup cannot start: the browser's storage estimate leaves less room than the download needs. */
  let noRoom: number | null = null;
  /** Not set up: whether the browser asks sites to save data and the room was looked at, which
   *  is why a download did not start by itself (lib/webengine/autoSetup.ts). */
  let saveData = false, roomChecked = false;
  let actionError = "", actionDetail = "";
  let confirming: "cancel" | "delete" | undefined;
  /** An operation asked for while a status read was out: it goes as soon as that is back. */
  let queued: Operation | undefined;
  const speed = new Speedometer();

  /** What a download has put on disk so far: the engine counts its storage when a file
   *  completes, the download its bytes as they arrive. */
  /** What setup downloads on this device: the engine's own total, the FP32 files' before it says. */
  function downloadBytes(): number { return snapshot?.download.total_bytes || DOWNLOAD_BYTES; }

  function downloadedBytes(): number {
    return Math.max(snapshot?.storage.models_bytes ?? 0, stage && "received" in stage ? stage.received : 0);
  }

  function confirm(what: "cancel" | "delete"): void {
    if (!snapshot || pending) return;
    confirming = what;
    const bytes = what === "cancel" ? downloadedBytes() : snapshot.storage.models_bytes;
    dialogTitle.textContent = t(what === "cancel" ? "engineCancelDownload" : "componentDeleteModels");
    dialogText.textContent = what === "cancel" ? t("engineCancelConfirm", formatSize(bytes)) : t("engineDeleteConfirm", formatSize(bytes));
    keep.textContent = t(what === "cancel" ? "engineKeepDownloading" : "buttonCancel");
    accept.textContent = t(what === "cancel" ? "engineCancelDownload" : "componentDeleteModels");
    dialog.showModal(); keep.focus();
  }

  /** Set up, Resume and Retry: the room on disk first, then the download. */
  function download(): void {
    if (pending || checking) return;
    checking = true; paintButtons();
    void roomNeeded().then((room) => {
      checking = false;
      if (destroyed) return;
      noRoom = room;
      if (noRoom !== null) { actionError = actionDetail = ""; repaint(); return; }
      run("models.download");
    });
  }

  /** How much more room the download needs than the browser says it has, or null when it fits
   *  (or the browser gives no estimate). */
  async function roomNeeded(): Promise<number | null> {
    try {
      return roomShort(await navigator.storage.estimate(), Math.max(0, downloadBytes() - (snapshot?.storage.models_bytes ?? 0)));
    } catch { return null; }
  }

  /** Why the last download stopped, and what to do about it; empty when nothing did. */
  function failureText(s: SetupStage): string {
    if (noRoom !== null) return t("engineDiskFull", formatSize(noRoom));
    if (s.stage !== "failed") return "";
    switch (s.failure) {
      case "network": return t("engineNetworkLost");
      case "storage": return t("engineDiskFull", formatSize(Math.max(0, s.total - s.received)));
      case "server": return t("engineServerDown");
      case "damaged": return t("engineDamaged");
      default: return t("engineDownloadStopped");
    }
  }

  function setPrimary(key: MessageKey | null, act?: () => void, filled = true, ...subs: string[]): void {
    primary.hidden = key === null;
    primaryAct = act;
    if (key === null) return;
    primary.textContent = t(key, ...subs);
    if (filled) delete primary.dataset.variant; else primary.dataset.variant = "outline";
  }

  function paintButtons(): void {
    const s = stage;
    if (!everConnected || !s) setPrimary(everConnected || actionError ? "panelRetry" : null, retryEngine);
    else if (crashed) setPrimary("panelRetry", retryEngine);
    else switch (s.stage) {
      // A disk too full to start says "then click Retry" (engineDiskFull): the button then is Retry.
      case "needed": if (noRoom !== null) setPrimary("panelRetry", download); else setPrimary("engineSetUpButton", download, true, formatSize(downloadBytes())); break;
      case "downloading": setPrimary("componentPauseDownload", () => run("models.pause"), false); break;
      case "paused": setPrimary("componentResumeDownload", download); break;
      case "failed": setPrimary("panelRetry", download); break;
      case "stopped": setPrimary("componentResume", () => run("engine.resume")); break;
      case "error": if (snapshot?.error?.code === "cannot_run") setPrimary(null); else setPrimary("panelRetry", () => run("engine.resume")); break;
      default: setPrimary(null);
    }
    // A running download can always be cancelled; a stopped one once it left bytes on disk.
    const downloadOnDisk = !!s && (s.stage === "downloading" || ((s.stage === "paused" || s.stage === "failed") && downloadedBytes() > 0));
    cancel.hidden = crashed || !downloadOnDisk;
    const modelOnDisk = !!s && ["ready", "loading", "stopped", "error"].includes(s.stage) && (snapshot?.storage.models_bytes ?? 0) > 0;
    // Settings: Delete model files and the idle unload once a model is on disk; the engine
    // switch (`extra`) stays whatever the stage.
    removeModel.hidden = idleField.hidden = crashed || !modelOnDisk;
    controls.hidden = !inSettings;
    primary.disabled = cancel.disabled = removeModel.disabled = idleSelect.disabled = pending || checking;
    barRow.hidden = bar.el.hidden && primary.hidden && cancel.hidden;
  }

  /** What the status line says: the stage, and in Settings the engine and where it runs, in words. */
  function statusText(): string {
    if (crashed || !stage) return t("componentNeedsAttention");
    const label = t(stageKeys[stage.stage]);
    if (!inSettings) return label;
    const where = stage.stage === "ready" ? (stage.device === "cpu" ? t("engineWordsCpu") : stage.device === "gpu" ? t("engineWordsGpu") : "") : "";
    return [t("engineWordsBrowser"), where, label].filter(Boolean).join(t("listSeparator"));
  }

  function repaint(): void {
    if (destroyed) return;
    const s = stage;
    lighter.hidden = snapshot?.tier !== "fp16" || crashed || !s;
    note.hidden = !(s?.stage === "needed" && !crashed && saveData);
    const counting = s && (s.stage === "downloading" || s.stage === "paused" || s.stage === "failed") ? s : null;
    progressText.hidden = !counting || crashed;
    // While the model loads there is no count to show, only that something is happening.
    bar.el.hidden = (!counting && s?.stage !== "loading") || crashed;
    percent.hidden = !counting || crashed;
    const barState = counting?.stage === "paused" ? "paused" : counting?.stage === "failed" ? "failed" : "running";
    if (counting) {
      const total = counting.total || downloadBytes();
      bar.set(total > 0 ? Math.min(counting.received, total) / total : 0, barState, t("engineDownloading"));
      percent.textContent = `${percentOf(counting.received, total)}%`;
      const parts = [t("engineProgress", formatSize(counting.received), formatSize(total))];
      if (counting.stage === "downloading") {
        if (counting.mirror) parts.push(t("engineFromMirror", counting.mirror));
        if (counting.retrying) parts.push(t("engineRetrying"));
        else {
          const rate = speed.perSecond;
          if (rate) parts.push(timeLeft((total - counting.received) / rate), t("engineSpeed", formatSize(rate)));
        }
      }
      progressLine.textContent = parts.join(t("listSeparator"));
    } else bar.set(null, "running", t("engineLoading"));
    // Only while the download runs: paused, failed or done there is nothing to keep the browser open for.
    keepOpen.hidden = !(counting?.stage === "downloading") || crashed;
    const ready = s?.stage === "ready" && !crashed;
    where.hidden = !ready || inSettings;
    if (ready) {
      where.textContent = s.device === "cpu" ? t("engineOnCpu") : s.device === "gpu" ? t("engineOnGpu") : "";
      where.hidden = where.hidden || !where.textContent;
    }
    let problem = actionError;
    if (!problem && crashed) problem = t("componentEngineCrashed");
    // The lighter model failed here and the full one does not fit: the setup page's "cannot run".
    if (!problem && s?.stage === "error" && snapshot?.error?.code === "cannot_run") problem = t("engineCannotRun");
    if (!problem && s?.stage === "error" && snapshot?.error?.code === "webgpu_unavailable") problem = t("safariWebGpuRequired");
    if (!problem && s) problem = failureText(s) || (s.stage === "error" ? t("engineLoadFailed") : "");
    if (!problem && !s && everConnected) problem = t("engineUnavailable");
    error.textContent = problem; error.hidden = !problem;
    details.textContent = actionDetail || (s?.stage === "failed" ? snapshot?.download.error ?? "" : s?.stage === "error" ? snapshot?.error?.message ?? "" : "");
    details.hidden = !details.textContent;
    paintButtons();
  }

  function paint(reply: ComponentReply): void {
    if (reply.kind !== "ok") {
      snapshot = stage = undefined;
      summary.textContent = t("componentNeedsAttention");
      if (!actionError) { actionError = t("engineUnavailable"); actionDetail = reply.message ?? ""; }
      everConnected = true;
      repaint(); onUpdate?.(reply); return;
    }
    const s = reply.snapshot; snapshot = s; everConnected = true;
    stage = setupStage(s);
    if (stage.stage === "downloading") speed.add(stage.received); else speed.reset();
    if (stage.stage !== "needed" && stage.stage !== "paused" && stage.stage !== "failed") noRoom = null;
    if (stage.stage !== "needed") roomChecked = false;
    else if (!roomChecked) {
      // What kept the download from starting by itself, said beside Set up.
      roomChecked = true;
      saveData = (navigator as { connection?: { saveData?: boolean } }).connection?.saveData === true;
      void roomNeeded().then((room) => { if (!destroyed && stage?.stage === "needed" && room !== null) { noRoom = room; repaint(); } });
    }
    summary.textContent = statusText();
    if (s.settings) {
      const value = String(s.settings.idle_unload_s);
      if (![...idleSelect.options].some((o) => o.value === value)) {
        const option = element("option", s.settings.idle_unload_s ? tn("componentIdleMinutes", s.settings.idle_unload_s / 60) : t("componentIdleNever"));
        option.value = value; idleSelect.append(option);
      }
      idleSelect.value = value;
    }
    repaint(); onUpdate?.(reply);
  }

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    if (destroyed || document.visibilityState !== "visible") return;
    const busy = stage?.stage === "downloading" || stage?.stage === "loading";
    timer = setTimeout(() => void poll(), busy ? 1_000 : stage?.stage === "ready" ? 15_000 : 3_000);
  }

  async function poll(op?: Operation): Promise<void> {
    if (destroyed || pending || (!op && document.visibilityState !== "visible")) return;
    pending = true; paintButtons();
    const ac = new AbortController(); controller = ac;
    try {
      const payload = op === "engine.settings" ? { idle_unload_s: Number(idleSelect.value) } : op === "models.delete" ? { confirm: true } : undefined;
      const reply = await requestComponent(op ?? "status", payload, ac.signal);
      crashed = reply.kind === "ok" && (await engineCrashed());
      if (destroyed || ac.signal.aborted) return;
      if (op && reply.kind === "rejected") {
        // Refused, and the engine said why: its status is what it was, so read it again.
        actionError = t("componentFailed"); actionDetail = reply.message ?? "";
        const current = await requestComponent("status", {}, ac.signal);
        if (!destroyed && !ac.signal.aborted) paint(current);
      } else paint(reply);
    } catch { if (!destroyed && !ac.signal.aborted) paint({ kind: "unavailable" }); }
    finally {
      pending = false; controller = undefined; paintButtons();
      const next = queued; queued = undefined;
      if (next && !destroyed) run(next); else schedule();
    }
  }

  async function engineCrashed(): Promise<boolean> {
    try {
      const status = await browser.runtime.sendMessage({ action: ACTIONS.GET_BACKEND_STATUS }) as BackendStatus | undefined;
      return status?.server.code === "engine_crashed";
    } catch { return false; }
  }

  /** Retry: the worker may start the engine again (a probe is a Retry), then read it all again. */
  async function retryEngine(): Promise<void> {
    if (pending || destroyed) return;
    pending = true; paintButtons();
    try { await browser.runtime.sendMessage({ action: ACTIONS.GET_BACKEND_STATUS, probe: true }); } catch { /* the poll says */ }
    pending = false;
    run();
  }

  function run(op?: Operation): void {
    if (destroyed) return;
    // The confirmation's button stays live while the page reads the status: what it asked
    // for waits for the read instead of being dropped.
    if (pending) { if (op) queued = op; return; }
    if (timer !== undefined) clearTimeout(timer);
    actionError = actionDetail = "";
    if (op === "models.download" || op === "models.delete") speed.reset();
    void poll(op);
  }
  const visibility = (): void => {
    if (document.visibilityState === "visible") run();
    else { if (timer !== undefined) clearTimeout(timer); controller?.abort(); }
  };
  document.addEventListener("visibilitychange", visibility);
  paintButtons(); void poll();
  return { refresh: () => run(), destroy() {
    destroyed = true; controller?.abort(); if (timer !== undefined) clearTimeout(timer);
    if (dialog.open) dialog.close();
    document.removeEventListener("visibilitychange", visibility);
  } };
}
