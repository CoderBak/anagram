// The local-engine panel shared by the setup page and Settings: one status line, a
// progress bar while models download, one contextual button, and two folds (Manage,
// Advanced). Mounting only reads status; downloads and benchmarks belong to the engine.
import { browser } from "#imports";
import { t, tn, messageLocale, type MessageKey } from "../i18n";
import { requestComponent, finishNativeUninstall, type ComponentSnapshot } from "../backend/nativeClient";
import { runtimeReady } from "../backend/runtimeClient";
import { mountRuntimeSettings, formatBytes } from "./runtimeSettings";
import { installationCommand } from "./installationCommand";
import "./componentSettings.css";

export type ComponentReply = Awaited<ReturnType<typeof requestComponent>>;
type Operation = "models.download" | "models.pause" | "models.delete" | "engine.stop" | "engine.resume" | "engine.settings" | "component.update" | "component.uninstall";
const stateKeys: Record<ComponentSnapshot["state"], MessageKey> = {
  starting: "componentStarting", needs_models: "componentNeedsModels", downloading: "componentDownloading",
  paused: "componentPaused", loading: "componentStarting", benchmarking: "runtimeBenchmarking",
  ready: "componentReady", idle: "componentReady", stopped: "componentStopped",
  updating: "componentUpdating", uninstalling: "componentRemoving", error: "componentNeedsAttention",
};

export function componentStateLabel(s: ComponentSnapshot): string {
  if (s.error?.code === "busy") return t("componentInUse");
  if (s.operation?.status === "scheduled") return t("componentSystemWindow");
  if (s.operation?.status === "running") return t(s.operation.name === "update" ? "componentUpdating" : "componentRemoving");
  if (s.state === "downloading" && s.download.phase === "verifying") return t("componentVerifyingModels");
  return t(stateKeys[s.state]);
}

export function componentConnectionLabel(reply: ComponentReply): string {
  return reply.kind === "ok" ? componentStateLabel(reply.snapshot) : t(reply.code === "busy" ? "componentInUse" : "componentNotInstalled");
}

/** An idle-unload option: "Never", or how many minutes the model stays loaded unused. */
export function idleUnloadLabel(seconds: number): string {
  return seconds ? tn("componentIdleMinutes", seconds / 60) : t("componentIdleNever");
}

export function componentReady(s: ComponentSnapshot): boolean {
  return !componentBusy(s) && s.runtime !== null &&
    ((s.state === "ready" && runtimeReady(s.runtime)) || (s.state === "idle" && s.runtime.selected_id !== null));
}

export function componentBusy(s: ComponentSnapshot): boolean {
  return s.operation?.status === "running" || s.operation?.status === "scheduled" || ["starting", "downloading", "loading", "benchmarking", "updating", "uninstalling"].includes(s.state);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

export function mountComponentSettings(host: HTMLElement, onUpdate?: (reply: ComponentReply) => void): { refresh(): void; destroy(): void } {
  host.classList.add("component-settings");
  const makeButton = (key: MessageKey, handler: () => void, variant = "outline"): HTMLButtonElement => {
    const button = element("button", t(key), "btn"); button.type = "button"; button.dataset.variant = variant; button.dataset.size = "sm";
    button.addEventListener("click", handler); return button;
  };
  const summary = element("p", t("componentStarting"), "component-status"); summary.setAttribute("role", "status");

  // A pending extension update, when the browser has one.
  const extensionUpdate = element("div", undefined, "component-update"); extensionUpdate.hidden = true;
  const extensionUpdateText = element("p"); extensionUpdateText.setAttribute("role", "status");
  extensionUpdate.append(extensionUpdateText, makeButton("componentReloadExtension", () => browser.runtime.reload()));

  // Not installed: the one-sentence instruction, the command, Copy and View script.
  const install = element("section", undefined, "component-install"); install.id = "install"; install.hidden = true;
  const intro = element("p", t("componentInstallIntro"));
  const releaseNotice = element("p", t("componentUnreleased"), "component-notice");
  releaseNotice.hidden = import.meta.env.VITE_ANAGRAM_RELEASE_BUILD === "1";
  const commandBox = element("pre", undefined, "component-command");
  const command = element("code"); command.id = "install-cmd"; commandBox.append(command);
  const copied = element("p"); copied.setAttribute("role", "status"); copied.hidden = true;
  const copy = makeButton("componentCopyInstall", () => {
    void navigator.clipboard.writeText(command.textContent ?? "").then(() => {
      copied.textContent = t("copied"); copied.hidden = false;
    }, () => { copied.textContent = t("componentCopyFailed"); copied.hidden = false; });
  }, "primary"); copy.id = "install-copy"; copy.disabled = true; delete copy.dataset.variant;
  const script = element("a", t("componentViewScript"), "btn"); script.dataset.variant = "ghost"; script.dataset.size = "sm";
  script.target = "_blank"; script.rel = "noopener noreferrer"; script.hidden = true;
  const installActions = element("div", undefined, "component-actions"); installActions.append(copy, script);
  install.append(intro, releaseNotice, commandBox, installActions, copied);

  const progress = element("progress"); progress.hidden = true; progress.setAttribute("aria-label", t("componentDownloading"));
  const error = element("p", undefined, "component-error"); error.setAttribute("role", "alert"); error.hidden = true;
  const details = element("details", undefined, "component-details"); details.hidden = true;
  const detailsText = element("pre"); details.append(element("summary", t("componentDetails")), detailsText);

  // The one contextual button, and the receipt-flow button after an uninstall.
  const actions = element("div", undefined, "component-actions");
  let primaryOp: Operation | "status" | undefined;
  const primary = makeButton("panelRetry", () => { if (primaryOp === "models.pause") pausing = true; run(primaryOp === "status" ? undefined : primaryOp); });
  primary.id = "component-primary"; primary.hidden = true;
  const finishRemoval = makeButton("componentRemoveExtension", () => void finishUninstall()); finishRemoval.hidden = true;
  actions.append(primary, finishRemoval);

  const manage = element("details", undefined, "component-fold"); manage.id = "manage"; manage.hidden = true;
  const storage = element("p");
  const manageActions = element("div", undefined, "component-actions");
  const update = makeButton("componentUpdate", () => run("component.update"));
  const stop = makeButton("componentStop", () => run("engine.stop"));
  const removeModels = makeButton("componentDeleteModels", () => confirm("models.delete"));
  const uninstall = makeButton("componentUninstall", () => confirm("component.uninstall"));
  manageActions.append(update, stop, removeModels, uninstall);
  manage.append(element("summary", t("componentManage")), storage, manageActions);

  const advanced = element("details", undefined, "component-fold"); advanced.id = "advanced"; advanced.hidden = true;
  const idleField = element("div", undefined, "field"); idleField.dataset.orientation = "horizontal"; idleField.hidden = true;
  const idleLabel = element("label", t("componentIdleSetting")); idleLabel.htmlFor = "idleUnload";
  const idleSelect = element("select"); idleSelect.id = "idleUnload";
  for (const seconds of [300, 60, 900, 0]) {
    const option = element("option", idleUnloadLabel(seconds));
    option.value = String(seconds); idleSelect.append(option);
  }
  idleSelect.addEventListener("change", () => run("engine.settings"));
  idleField.append(idleLabel, idleSelect);
  const runtimeHost = element("div"); runtimeHost.id = "runtimeSettings"; runtimeHost.hidden = true;
  advanced.append(element("summary", t("componentAdvanced")), idleField, runtimeHost);

  const dialog = element("dialog", undefined, "component-dialog");
  const dialogTitle = element("h3"); dialogTitle.id = "component-confirm-title";
  const dialogText = element("p"); dialogText.id = "component-confirm-text";
  dialog.setAttribute("aria-labelledby", dialogTitle.id); dialog.setAttribute("aria-describedby", dialogText.id);
  const dialogActions = element("div", undefined, "component-actions");
  const cancelConfirm = makeButton("buttonCancel", () => dialog.close());
  const acceptConfirm = makeButton("buttonCancel", () => {
    const op = confirming; dialog.close();
    if (op && snapshot && !pending && !componentBusy(snapshot)) run(op);
  });
  dialogActions.append(cancelConfirm, acceptConfirm); dialog.append(dialogTitle, dialogText, dialogActions);
  host.replaceChildren(summary, extensionUpdate, install, progress, error, details, actions, manage, advanced, dialog);

  let snapshot: ComponentSnapshot | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let runtimePanel: ReturnType<typeof mountRuntimeSettings> | undefined;
  let destroyed = false, pending = false, everConnected = false, pausing = false, retryable = false;
  let actionError = "", actionDetail = "";
  let awaitingUninstall = false, awaitingUpdate = false, removingExtension = false, scheduledCleanup = false, scheduledUpdate = false;
  let completedUninstallReceipt: string | null = null;
  let attemptedReceipt: string | null = null;
  let confirming: "models.delete" | "component.uninstall" | undefined;

  const paintExtensionUpdate = (value: unknown): void => {
    if (destroyed) return;
    const version = typeof value === "string" && value.length <= 100 && value !== browser.runtime.getManifest().version ? value : "";
    extensionUpdate.hidden = !version;
    extensionUpdateText.textContent = version ? t("componentExtensionUpdate", version) : "";
  };
  const updateAvailable = (value: { version: string }): void => paintExtensionUpdate(value.version);
  const storageChanged = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
    if (area === "local" && "extensionUpdatePending" in changes) paintExtensionUpdate(changes.extensionUpdatePending.newValue);
  };
  browser.runtime.onUpdateAvailable.addListener(updateAvailable);
  browser.storage.onChanged.addListener(storageChanged);
  void browser.storage.local.get("extensionUpdatePending").then((value) => paintExtensionUpdate(value.extensionUpdatePending)).catch(() => undefined);

  void browser.runtime.getPlatformInfo().then((platform) => {
    const instruction = installationCommand(platform.os, import.meta.env.BROWSER === "firefox" ? "firefox" : "chrome",
      browser.runtime.id, browser.runtime.getManifest().version, messageLocale() === "zh-CN" ? "zh_CN" : "en");
    if (destroyed) return;
    if (!instruction) { intro.textContent = t("componentUnsupportedPlatform"); commandBox.hidden = installActions.hidden = releaseNotice.hidden = true; return; }
    intro.textContent = t(instruction.platform === "windows" ? "componentInstallIntroWindows" : "componentInstallIntro");
    command.textContent = instruction.command; script.href = instruction.scriptUrl; script.hidden = false;
    copy.disabled = import.meta.env.VITE_ANAGRAM_RELEASE_BUILD !== "1";
  }).catch(() => { intro.textContent = t("componentUnsupportedPlatform"); commandBox.hidden = installActions.hidden = releaseNotice.hidden = true; });

  function confirm(op: "models.delete" | "component.uninstall"): void {
    if (!snapshot || pending || componentBusy(snapshot)) return;
    confirming = op;
    const deleting = op === "models.delete";
    dialogTitle.textContent = t(deleting ? "componentDeleteModels" : "componentUninstall");
    dialogText.textContent = t(deleting ? "componentDeleteConfirm" : "componentUninstallConfirm", formatBytes(snapshot.storage.models_bytes), snapshot.home);
    acceptConfirm.textContent = t(deleting ? "componentDeleteModels" : "componentUninstall");
    dialog.showModal(); cancelConfirm.focus();
  }

  /** The one thing to do about the current state, or nothing. */
  function primaryAction(s: ComponentSnapshot | undefined): [MessageKey, Operation | "status"] | null {
    if (!s) return retryable ? ["panelRetry", "status"] : null;
    if (s.error?.code === "busy" || s.operation?.status === "running" || s.operation?.status === "scheduled") return null;
    if (s.download.status === "running") return ["componentPauseDownload", "models.pause"];
    if (s.download.status === "paused") return ["componentResumeDownload", "models.download"];
    if (s.download.status === "failed") return ["panelRetry", "models.download"];
    if (s.state === "needs_models") return ["componentDownloadModels", "models.download"];
    if (s.state === "stopped") return ["componentResume", "engine.resume"];
    if (s.state === "error") return ["panelRetry", "engine.resume"];
    return null;
  }

  function buttons(): void {
    const s = snapshot, busy = s ? componentBusy(s) || s.error?.code === "busy" : false;
    const terminal = completedUninstallReceipt !== null;
    const action = terminal ? null : primaryAction(s);
    primary.hidden = !action;
    if (action) { primary.textContent = t(action[0]); primaryOp = action[1]; }
    primary.disabled = pending || (primaryOp === "models.pause" && pausing);
    idleSelect.disabled = pending || busy || !s;
    manage.hidden = advanced.hidden = !s || terminal;
    stop.hidden = !s || !["loading", "benchmarking", "ready", "idle"].includes(s.state);
    update.disabled = uninstall.disabled = pending || busy;
    removeModels.disabled = pending || busy || !s || s.storage.models_bytes === 0;
    stop.disabled = pending || s?.error?.code === "busy" || s?.operation?.status === "running" || s?.operation?.status === "scheduled";
    finishRemoval.hidden = !terminal; finishRemoval.disabled = removingExtension;
  }

  function showRuntime(s?: ComponentSnapshot): void {
    const show = !!s?.runtime && ["loading", "benchmarking", "ready", "idle", "error"].includes(s.state) && !completedUninstallReceipt;
    runtimeHost.hidden = !show;
    if (show && !runtimePanel) runtimePanel = mountRuntimeSettings(runtimeHost);
    else if (!show && runtimePanel) { runtimePanel.destroy(); runtimePanel = undefined; runtimeHost.replaceChildren(); }
  }

  function paint(reply: ComponentReply): void {
    if (reply.kind !== "ok") {
      snapshot = undefined;
      const inUse = reply.code === "busy";
      retryable = !inUse && (everConnected || reply.kind === "invalid" || !!actionError);
      summary.textContent = t(scheduledCleanup || scheduledUpdate ? "componentSystemWindow" : awaitingUninstall ? "componentRemoving" : awaitingUpdate ? "componentUpdating" : inUse ? "componentInUse" : reply.kind === "invalid" || everConnected ? "componentNeedsAttention" : "componentNotInstalled");
      install.hidden = everConnected || awaitingUninstall || inUse;
      progress.hidden = idleField.hidden = true;
      error.textContent = actionError; error.hidden = !actionError;
      // A host that was never reached is simply not installed; its transport message is noise.
      detailsText.textContent = actionDetail || (everConnected || reply.kind === "invalid" ? reply.message ?? "" : "");
      details.hidden = !detailsText.textContent;
      showRuntime(); buttons(); onUpdate?.(reply); return;
    }
    const s = reply.snapshot; snapshot = s; everConnected = true;
    if (s.download.status !== "running") pausing = false;
    if (s.operation?.name === "uninstall" && s.operation.status === "completed" && s.operation.receipt) completedUninstallReceipt = s.operation.receipt;
    if (s.operation?.name === "uninstall" && s.operation.status === "scheduled") scheduledCleanup = true;
    scheduledUpdate = s.operation?.name === "update" && s.operation.status === "scheduled";
    if (s.operation?.status === "failed") awaitingUninstall = awaitingUpdate = scheduledCleanup = scheduledUpdate = false;
    if (awaitingUpdate && s.operation?.name !== "update" && !["updating", "stopped"].includes(s.state)) awaitingUpdate = false;
    const downloading = ["running", "paused", "failed"].includes(s.download.status);
    let label = completedUninstallReceipt ? t("componentCleanupDone") : componentStateLabel(s);
    if (downloading && s.download.total_bytes > 0 && !completedUninstallReceipt) label += ` · ${t("componentDownloadBytes", formatBytes(s.download.bytes_received), formatBytes(s.download.total_bytes))}`;
    summary.textContent = label;
    install.hidden = true;
    storage.textContent = t("componentStorage", formatBytes(s.storage.models_bytes));
    idleField.hidden = !s.settings;
    if (s.settings) {
      const value = String(s.settings.idle_unload_s);
      if (![...idleSelect.options].some((o) => o.value === value)) {
        const option = element("option", idleUnloadLabel(s.settings.idle_unload_s)); option.value = value; idleSelect.append(option);
      }
      idleSelect.value = value;
    }
    progress.hidden = !downloading || !!completedUninstallReceipt;
    if (s.download.total_bytes > 0) { progress.max = s.download.total_bytes; progress.value = Math.min(s.download.bytes_received, s.download.total_bytes); }
    else progress.removeAttribute("value");
    error.textContent = actionError || (s.error || s.download.error ? t("componentFailed") : "");
    error.hidden = !error.textContent;
    detailsText.textContent = actionDetail || s.error?.message || s.download.error || ""; details.hidden = !detailsText.textContent;
    showRuntime(s); buttons(); onUpdate?.(reply);
    if (completedUninstallReceipt && attemptedReceipt !== completedUninstallReceipt) void finishUninstall();
  }

  async function finishUninstall(): Promise<void> {
    const receipt = completedUninstallReceipt;
    if (!receipt || removingExtension) return;
    removingExtension = true; attemptedReceipt = receipt; buttons();
    try {
      const result = await finishNativeUninstall(receipt);
      if (!result.ok) { actionError = t("componentExtensionRemovalFailed"); actionDetail = result.error ?? ""; }
    } catch { actionError = t("componentExtensionRemovalFailed"); }
    finally {
      removingExtension = false;
      error.textContent = actionError; error.hidden = !actionError; buttons();
    }
  }

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    if (!destroyed && document.visibilityState === "visible" && !completedUninstallReceipt) {
      const ms = snapshot && componentBusy(snapshot) ? 1_000 : snapshot && componentReady(snapshot) ? 15_000 : 3_000;
      timer = setTimeout(() => void poll(), ms);
    }
  }

  async function poll(op?: Operation): Promise<void> {
    if (destroyed || pending || (!op && document.visibilityState !== "visible")) return;
    pending = true; buttons();
    const ac = new AbortController(); controller = ac;
    try {
      const payload = op === "engine.settings" ? {idle_unload_s: Number(idleSelect.value)} : op === "models.delete" || op === "component.uninstall" ? {confirm: true} : undefined;
      const reply = await requestComponent(op ?? "status", payload, ac.signal);
      if (destroyed || ac.signal.aborted) return;
      if (reply.kind === "rejected" && op) {
        pausing = false; awaitingUpdate = awaitingUninstall = false;
        actionError = t("componentFailed"); actionDetail = reply.message ?? "";
        error.textContent = actionError; error.hidden = false; detailsText.textContent = actionDetail; details.hidden = !actionDetail;
      } else {
        if (op && reply.kind !== "ok") { actionError = t("componentFailed"); pausing = false; }
        paint(reply);
      }
    } catch { if (!destroyed && !ac.signal.aborted) paint({ kind: "unavailable" }); }
    finally { pending = false; controller = undefined; buttons(); schedule(); }
  }

  function run(op?: Operation): void {
    if (pending || destroyed) return;
    if (timer !== undefined) clearTimeout(timer);
    actionError = actionDetail = "";
    if (op === "component.uninstall") awaitingUninstall = true;
    if (op === "component.update") awaitingUpdate = true;
    void poll(op);
  }
  const visibility = (): void => {
    if (document.visibilityState === "visible") run();
    else { if (timer !== undefined) clearTimeout(timer); controller?.abort(); }
  };
  document.addEventListener("visibilitychange", visibility);
  buttons(); void poll();
  return { refresh: () => run(), destroy() {
    destroyed = true; controller?.abort(); if (timer !== undefined) clearTimeout(timer);
    runtimePanel?.destroy(); if (dialog.open) dialog.close(); document.removeEventListener("visibilitychange", visibility);
    browser.runtime.onUpdateAvailable.removeListener(updateAvailable); browser.storage.onChanged.removeListener(storageChanged);
  } };
}
