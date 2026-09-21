import { browser } from "#imports";
import { t, messageLocale, type MessageKey } from "../i18n";
import { requestComponent, finishNativeUninstall, type ComponentSnapshot } from "../backend/nativeClient";
import { runtimeReady } from "../backend/runtimeClient";
import { mountRuntimeSettings } from "./runtimeSettings";
import { installationCommand } from "./installationCommand";
import "./componentSettings.css";

export type ComponentReply = Awaited<ReturnType<typeof requestComponent>>;
type Operation = "models.download" | "models.pause" | "models.delete" | "engine.stop" | "engine.resume" | "engine.settings" | "component.update" | "component.uninstall";
const stateKeys: Record<ComponentSnapshot["state"], MessageKey> = {
  starting: "componentStarting", needs_models: "componentNeedsModels", downloading: "componentDownloading",
  paused: "componentPaused", loading: "componentLoading", benchmarking: "runtimeBenchmarking",
  awaiting_selection: "runtimeChoose", ready: "runtimeReady", idle: "componentIdle", stopped: "componentStopped",
  updating: "componentUpdating", uninstalling: "componentUninstalling", error: "componentNeedsAttention",
};
const preparationKeys: Record<NonNullable<ComponentSnapshot["download"]["phase"]>, MessageKey> = {
  detecting: "componentDetectingDevices", verifying: "componentVerifyingModels",
  downloading: "componentDownloading", complete: "componentModelsPrepared",
};

export function componentStateLabel(s: ComponentSnapshot): string {
  if (s.error?.code === "busy") return t("componentInUse");
  if (s.operation?.name === "uninstall" && s.operation.status === "scheduled") return t("componentCleanupScheduled");
  if (s.operation?.name === "update" && s.operation.status === "scheduled") return t("componentUpdateScheduled");
  if (s.operation?.status === "running") return t(s.operation.name === "delete_models" ? "componentDeleting" : s.operation.name === "uninstall" ? "componentUninstalling" : "componentUpdating");
  if (s.state === "downloading" && s.download.phase) return t(preparationKeys[s.download.phase]);
  return t(stateKeys[s.state]);
}

export function componentConnectionLabel(reply: ComponentReply): string {
  return reply.kind === "ok" ? componentStateLabel(reply.snapshot) : t(reply.code === "busy" ? "componentInUse" : "componentNotConnected");
}

export function componentReady(s: ComponentSnapshot): boolean {
  return !componentBusy(s) && s.runtime !== null &&
    ((s.state === "ready" && runtimeReady(s.runtime)) || (s.state === "idle" && !s.runtime.needs_selection && s.runtime.selected_id !== null));
}

export function componentBusy(s: ComponentSnapshot): boolean {
  return s.operation?.status === "running" || s.operation?.status === "scheduled" || ["starting", "downloading", "loading", "benchmarking", "updating", "uninstalling"].includes(s.state);
}

function bytes(n: number): string {
  const gib = n / 1024 ** 3;
  return gib >= 1 ? `${gib.toLocaleString(undefined, { maximumFractionDigits: 2 })} GiB` : `${(n / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB`;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}

/** Pages read the same native lifecycle. First download/benchmark belongs to the
 * component's persisted first-run state, never to a page mount or a polling tick. */
export function mountComponentSettings(host: HTMLElement, onUpdate?: (reply: ComponentReply) => void): { refresh(): void; destroy(): void } {
  host.classList.add("component-settings");
  const summary = element("p", t("componentConnecting"), "component-status"); summary.setAttribute("role", "status");
  const note = element("p", t("componentConnectionNote"));
  const install = element("section", undefined, "component-install"); install.id = "install"; install.hidden = true;
  const intro = element("p", t("componentInstallIntro"));
  const footprint = element("p", t("componentInitialDownload"));
  const shell = element("p");
  const commandBox = element("pre", undefined, "component-command");
  const command = element("code"); command.id = "install-cmd"; commandBox.append(command);
  const installActions = element("div", undefined, "component-actions");
  const makeButton = (key: MessageKey, handler: () => void): HTMLButtonElement => {
    const button = element("button", t(key), "btn"); button.type = "button"; button.dataset.variant = "outline"; button.dataset.size = "sm";
    button.addEventListener("click", handler); return button;
  };
  const copied = element("p"); copied.setAttribute("role", "status"); copied.hidden = true;
  const copy = makeButton("componentCopyInstall", () => {
    void navigator.clipboard.writeText(command.textContent ?? "").then(() => {
      copied.textContent = t("copied"); copied.hidden = false;
    }, () => { copied.textContent = t("componentCopyFailed"); copied.hidden = false; });
  }); copy.id = "install-copy"; copy.disabled = true;
  const script = element("a", t("componentViewScript"), "btn"); script.dataset.variant = "ghost"; script.dataset.size = "sm";
  script.target = "_blank"; script.rel = "noopener noreferrer"; script.hidden = true;
  const releaseNotice = element("p", t("componentUnreleased"), "component-notice");
  releaseNotice.hidden = import.meta.env.VITE_ANAGRAM_RELEASE_BUILD === "1";
  installActions.append(copy, script);
  install.append(intro, footprint, shell, releaseNotice, commandBox, installActions, copied, element("p", t("componentAfterInstall")));

  const metadata = element("p", undefined, "component-path");
  const storage = element("p");
  const idleField = element("div", undefined, "field"); idleField.hidden = true;
  const idleLabel = element("label", t("componentIdleSetting")); idleLabel.htmlFor = "idleUnload";
  const idleSelect = element("select"); idleSelect.id = "idleUnload";
  for (const seconds of [300, 60, 900, 0]) {
    const option = element("option", seconds ? t("componentIdleMinutes", seconds / 60) : t("componentIdleNever"));
    option.value = String(seconds); idleSelect.append(option);
  }
  idleSelect.addEventListener("change", () => run("engine.settings"));
  idleField.append(idleLabel, idleSelect, element("p", t("componentIdleNote")));
  const download = element("div", undefined, "component-download");
  const downloadText = element("p"); downloadText.setAttribute("role", "status");
  const progress = element("progress"); progress.setAttribute("aria-label", t("componentDownloadProgress"));
  const file = element("p", undefined, "component-file");
  download.append(downloadText, progress, file, element("p", t("componentPreparationNote")));
  const plan = element("section", undefined, "component-plan"); plan.id = "downloadPlan"; plan.hidden = true;
  const planTitle = element("h3");
  const planDevices = element("p");
  const planSize = element("p");
  const planFiles = element("details", undefined, "component-details");
  const filesList = element("ul", undefined, "component-file");
  planFiles.append(element("summary", t("componentPlanFiles")), filesList);
  const expandedSize = element("p");
  const planActions = element("div", undefined, "component-actions");
  const expanded = makeButton("componentExpandedDownload", () => run("models.download", "expanded"));
  const recommended = makeButton("componentRecommendedDownload", () => run("models.download", "recommended"));
  planActions.append(expanded, recommended);
  plan.append(planTitle, planDevices, planSize, planFiles, expandedSize,
    element("p", t("componentExpandedNote")), planActions, element("p", t("componentRecommendedNote")));
  const error = element("p", undefined, "component-error"); error.setAttribute("role", "alert"); error.hidden = true;
  const details = element("details", undefined, "component-details"); details.hidden = true;
  const detailsText = element("pre"); details.append(element("summary", t("componentTechnicalDetails")), detailsText);
  const actions = element("div", undefined, "component-actions");
  const getModels = makeButton("componentDownloadModels", () => run("models.download"));
  const pause = makeButton("componentPauseDownload", () => { pausing = true; run("models.pause"); });
  const stop = makeButton("componentStop", () => run("engine.stop"));
  const resume = makeButton("componentResume", () => run("engine.resume"));
  const update = makeButton("componentUpdate", () => run("component.update"));
  const removeModels = makeButton("componentDeleteModels", () => confirm("models.delete"));
  const uninstall = makeButton("componentUninstall", () => confirm("component.uninstall"));
  const refresh = makeButton("componentRetryConnection", () => run());
  const finishRemoval = makeButton("componentRemoveExtension", () => void finishUninstall()); finishRemoval.hidden = true;
  actions.append(getModels, pause, stop, resume, update, removeModels, uninstall, refresh, finishRemoval);
  const runtimeHost = element("div"); runtimeHost.id = "runtimeSettings"; runtimeHost.hidden = true;
  const upgradeNote = element("p", t("componentUpgradeNote"));
  const extensionUpdate = element("section", undefined, "component-update"); extensionUpdate.hidden = true;
  const extensionUpdateText = element("p"); extensionUpdateText.setAttribute("role", "status");
  const reloadExtension = makeButton("componentReloadExtension", () => browser.runtime.reload());
  extensionUpdate.append(extensionUpdateText, reloadExtension);
  const dialog = element("dialog", undefined, "component-dialog");
  const dialogTitle = element("h3"); dialogTitle.id = "component-confirm-title";
  const dialogText = element("p"); dialogText.id = "component-confirm-text";
  dialog.setAttribute("aria-labelledby", dialogTitle.id); dialog.setAttribute("aria-describedby", dialogText.id);
  const dialogActions = element("div", undefined, "component-actions");
  const cancelConfirm = makeButton("componentKeepFiles", () => dialog.close());
  const acceptConfirm = makeButton("componentConfirm", () => {
    const op = confirming; dialog.close();
    if (op && snapshot && !pending && !componentBusy(snapshot)) run(op);
  });
  dialogActions.append(cancelConfirm, acceptConfirm); dialog.append(dialogTitle, dialogText, dialogActions);
  host.replaceChildren(summary, note, extensionUpdate, install, metadata, storage, plan, download, error, details, actions, idleField, runtimeHost, upgradeNote, dialog);

  let snapshot: ComponentSnapshot | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let controller: AbortController | undefined;
  let runtimePanel: ReturnType<typeof mountRuntimeSettings> | undefined;
  let destroyed = false, pending = false, everConnected = false, pausing = false;
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
    if (!instruction) { shell.textContent = t("componentUnsupportedPlatform"); commandBox.hidden = true; return; }
    shell.textContent = t(instruction.platform === "windows" ? "componentPowerShell" : "componentTerminal");
    command.textContent = instruction.command; script.href = instruction.scriptUrl; script.hidden = false;
    copy.disabled = import.meta.env.VITE_ANAGRAM_RELEASE_BUILD !== "1";
  }).catch(() => { shell.textContent = t("componentUnsupportedPlatform"); commandBox.hidden = true; });

  function confirm(op: "models.delete" | "component.uninstall"): void {
    if (!snapshot || pending || componentBusy(snapshot)) return;
    confirming = op;
    const deleting = op === "models.delete";
    dialogTitle.textContent = t(deleting ? "componentDeleteTitle" : "componentUninstallTitle");
    dialogText.textContent = t(deleting ? "componentDeleteConfirm" : "componentUninstallConfirm", bytes(snapshot.storage.models_bytes), snapshot.home);
    acceptConfirm.textContent = t(deleting ? "componentDeleteModels" : "componentUninstall");
    dialog.showModal(); cancelConfirm.focus();
  }

  function buttons(): void {
    const s = snapshot, busy = s ? componentBusy(s) || s.error?.code === "busy" : false;
    const terminal = completedUninstallReceipt !== null;
    getModels.hidden = !s || terminal || !(s.state === "needs_models" || s.state === "paused" || s.download.status === "failed");
    getModels.textContent = t(s?.download.status === "paused" ? "componentResumeDownload" : s?.download.status === "failed" ? "componentRetryDownload" : "componentDownloadModels");
    pause.hidden = !s || s.download.status !== "running";
    stop.hidden = !s || terminal || !["loading", "benchmarking", "awaiting_selection", "ready", "idle"].includes(s.state);
    resume.hidden = !s || terminal || !(s.state === "stopped" || s.state === "idle" || s.state === "error");
    idleSelect.disabled = pending || busy || !s;
    update.hidden = removeModels.hidden = uninstall.hidden = !s || terminal;
    getModels.disabled = update.disabled = uninstall.disabled = pending || busy;
    expanded.hidden = !s?.download.plan || terminal || s.download.plan.profile === "expanded" ||
      (s.download.plan.expanded_bytes !== undefined && s.download.plan.expanded_bytes <= s.download.plan.total_bytes);
    recommended.hidden = !s?.download.plan || terminal;
    expanded.disabled = recommended.disabled = pending || busy;
    removeModels.disabled = pending || busy || !s || s.storage.models_bytes === 0;
    pause.disabled = pending || pausing;
    stop.disabled = resume.disabled = pending || s?.error?.code === "busy" || s?.operation?.status === "running" || s?.operation?.status === "scheduled";
    refresh.disabled = pending; refresh.hidden = terminal;
    finishRemoval.hidden = !terminal; finishRemoval.disabled = removingExtension;
  }

  function showRuntime(s?: ComponentSnapshot): void {
    const show = !!s?.runtime && ["loading", "benchmarking", "awaiting_selection", "ready", "idle", "error"].includes(s.state) && !completedUninstallReceipt;
    runtimeHost.hidden = !show;
    if (show && !runtimePanel) runtimePanel = mountRuntimeSettings(runtimeHost);
    else if (!show && runtimePanel) { runtimePanel.destroy(); runtimePanel = undefined; runtimeHost.replaceChildren(); }
  }

  function paint(reply: ComponentReply): void {
    if (reply.kind !== "ok") {
      snapshot = undefined;
      const inUse = reply.code === "busy";
      summary.textContent = t(scheduledCleanup ? "componentCleanupScheduled" : scheduledUpdate ? "componentUpdateScheduled" : awaitingUninstall ? "componentWaitingCleanup" : awaitingUpdate ? "componentReconnecting" : inUse ? "componentInUse" : reply.kind === "invalid" ? "componentIncompatible" : everConnected ? "componentDisconnected" : "componentNotConnected");
      note.textContent = t(scheduledCleanup ? "componentSystemCleanupNote" : scheduledUpdate ? "componentSystemUpdateNote" : awaitingUninstall ? "componentCleanupUnconfirmed" : inUse ? "componentInUseNote" : everConnected ? "componentReconnectNote" : "componentConnectionNote");
      install.hidden = everConnected || awaitingUninstall || inUse;
      metadata.hidden = storage.hidden = plan.hidden = download.hidden = upgradeNote.hidden = idleField.hidden = true;
      error.textContent = actionError; error.hidden = !actionError;
      detailsText.textContent = actionDetail || reply.message || ""; details.hidden = !detailsText.textContent;
      showRuntime(); buttons(); onUpdate?.(reply); return;
    }
    const s = reply.snapshot; snapshot = s; everConnected = true;
    if (s.download.status !== "running") pausing = false;
    if (s.operation?.name === "uninstall" && s.operation.status === "completed" && s.operation.receipt) completedUninstallReceipt = s.operation.receipt;
    if (s.operation?.name === "uninstall" && s.operation.status === "scheduled") scheduledCleanup = true;
    if (s.operation?.name === "update") scheduledUpdate = s.operation.status === "scheduled";
    else scheduledUpdate = false;
    if (s.operation?.status === "failed") awaitingUninstall = awaitingUpdate = scheduledCleanup = scheduledUpdate = false;
    if (awaitingUpdate && s.operation?.name !== "update" && !["updating", "stopped"].includes(s.state)) awaitingUpdate = false;
    summary.textContent = t(completedUninstallReceipt ? "componentCleanupDone" : pausing ? "componentPausing" : "componentConnected");
    if (!completedUninstallReceipt && !pausing) summary.textContent = componentStateLabel(s);
    note.textContent = t(completedUninstallReceipt ? "componentRemovingExtension" : scheduledCleanup ? "componentSystemCleanupNote" : scheduledUpdate ? "componentSystemUpdateNote" : s.error?.code === "busy" ? "componentInUseNote" : "componentConnectedNote");
    install.hidden = true; metadata.hidden = storage.hidden = upgradeNote.hidden = false;
    metadata.textContent = t("componentLocation", s.version ?? t("componentUnknownVersion"), s.home);
    storage.textContent = t("componentStorage", bytes(s.storage.models_bytes));
    const preparation = s.download.plan;
    plan.hidden = !preparation || !!completedUninstallReceipt;
    if (preparation) {
      planTitle.textContent = t(preparation.profile === "recommended" ? "componentRecommendedPlan" : "componentExpandedPlan");
      planDevices.textContent = t("componentPlanDevices", preparation.devices.join(" · ") || t("runtimeNotAvailable"));
      planSize.textContent = t("componentPlanSize", bytes(preparation.total_bytes));
      filesList.replaceChildren(...preparation.files.map((name) => element("li", name)));
      expandedSize.hidden = preparation.expanded_bytes === undefined || preparation.profile === "expanded";
      expandedSize.textContent = preparation.expanded_bytes === undefined ? "" : t("componentExpandedSize", bytes(preparation.expanded_bytes));
    }
    idleField.hidden = !s.settings || !!completedUninstallReceipt;
    if (s.settings) {
      const value = String(s.settings.idle_unload_s);
      if (![...idleSelect.options].some((o) => o.value === value)) {
        const option = element("option", t("componentIdleMinutes", s.settings.idle_unload_s / 60)); option.value = value; idleSelect.append(option);
      }
      idleSelect.value = value;
    }
    download.hidden = !["running", "paused", "failed"].includes(s.download.status);
    downloadText.textContent = s.download.total_bytes ? t("componentDownloadBytes", bytes(s.download.bytes_received), bytes(s.download.total_bytes)) :
      s.download.phase === "detecting" ? t("componentDetectingDevices") : t("componentDownloadedBytes", bytes(s.download.bytes_received));
    if (s.download.phase && s.download.total_bytes > 0) downloadText.textContent = `${t(preparationKeys[s.download.phase])} · ${downloadText.textContent}`;
    if (s.download.total_bytes && s.download.total_bytes > 0) { progress.max = s.download.total_bytes; progress.value = Math.min(s.download.bytes_received, s.download.total_bytes); }
    else progress.removeAttribute("value");
    file.textContent = s.download.file ?? ""; file.hidden = !s.download.file;
    error.textContent = actionError || (s.error || s.download.error ? t(s.download.status === "failed" ? "componentDownloadFailed" : "componentOperationFailed") : "");
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

  async function poll(op?: Operation, profile?: "recommended" | "expanded"): Promise<void> {
    if (destroyed || pending || (!op && document.visibilityState !== "visible")) return;
    pending = true; buttons();
    const ac = new AbortController(); controller = ac;
    try {
      const payload = op === "models.download" && profile ? {profile} : op === "engine.settings" ? {idle_unload_s: Number(idleSelect.value)} : op === "models.delete" || op === "component.uninstall" ? {confirm: true} : undefined;
      const reply = await requestComponent(op ?? "status", payload, ac.signal);
      if (destroyed || ac.signal.aborted) return;
      if (reply.kind === "rejected" && op) {
        pausing = false; awaitingUpdate = awaitingUninstall = false;
        actionError = t("componentActionRejected"); actionDetail = reply.message ?? "";
        error.textContent = actionError; error.hidden = false; detailsText.textContent = actionDetail; details.hidden = !actionDetail;
      } else {
        if (op && reply.kind !== "ok") { actionError = t("componentActionUnconfirmed"); pausing = false; }
        paint(reply);
      }
    } catch { if (!destroyed && !ac.signal.aborted) paint({ kind: "unavailable" }); }
    finally { pending = false; controller = undefined; buttons(); schedule(); }
  }

  function run(op?: Operation, profile?: "recommended" | "expanded"): void {
    if (pending || destroyed) return;
    if (timer !== undefined) clearTimeout(timer);
    actionError = actionDetail = "";
    if (op === "component.uninstall") awaitingUninstall = true;
    if (op === "component.update") awaitingUpdate = true;
    void poll(op, profile);
  }
  const visibility = (): void => {
    if (document.visibilityState === "visible") run();
    else { if (timer !== undefined) clearTimeout(timer); controller?.abort(); }
  };
  document.addEventListener("visibilitychange", visibility);
  metadata.hidden = storage.hidden = download.hidden = upgradeNote.hidden = true;
  buttons(); void poll();
  return { refresh: () => run(), destroy() {
    destroyed = true; controller?.abort(); if (timer !== undefined) clearTimeout(timer);
    runtimePanel?.destroy(); if (dialog.open) dialog.close(); document.removeEventListener("visibilitychange", visibility);
    browser.runtime.onUpdateAvailable.removeListener(updateAvailable); browser.storage.onChanged.removeListener(storageChanged);
  } };
}
