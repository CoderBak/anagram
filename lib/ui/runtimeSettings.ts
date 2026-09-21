// One panel shared by first-run setup and Options. Mounting only reads status; the backend
// owns the automatic first-run benchmark, and later runs require a button click.
import { settings } from "../settings/settings";
import { t, type MessageKey } from "../i18n";
import {
  requestRuntime, runtimeReady, runtimeBusy, runtimePollMs, canApplyRuntime,
  type RuntimeReply, type RuntimeSnapshot, type RuntimeAction,
} from "../backend/runtimeClient";
import "./runtimeSettings.css";

export function runtimeStateLabel(s: RuntimeSnapshot): string {
  if (runtimeBusy(s)) return t(s.benchmark.status === "running" || s.state === "benchmarking" ? "runtimeBenchmarking" : s.selected_id ? "runtimeLoading" : "runtimePreparing");
  if (s.state === "error") return t("runtimeFailed");
  return t(runtimeReady(s) ? "runtimeReady" : "runtimeChoose");
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

function metric(value: number | null | undefined, unit: "ms" | "rate" | "bytes"): string {
  if (value == null) return t("runtimeNotAvailable");
  if (unit === "bytes") return `${(value / 1024 ** 2).toLocaleString(undefined, { maximumFractionDigits: 0 })} MiB`;
  const amount = value.toLocaleString(undefined, { maximumFractionDigits: unit === "ms" ? 1 : 2 });
  return unit === "ms" ? `${amount} ms` : t("runtimeRate", amount);
}

const phaseKeys: Record<string, MessageKey> = {
  discovery: "runtimePhaseDiscovery", awaiting_selection: "runtimeChoose", ready: "runtimeReady", error: "runtimePhaseFailed",
  loading: "runtimePhaseLoad", load: "runtimePhaseLoad", warmup: "runtimePhaseWarmup",
  warming: "runtimePhaseWarmup", measuring: "runtimePhaseMeasure", measurement: "runtimePhaseMeasure",
  complete: "runtimePhaseComplete", completed: "runtimePhaseComplete", cancelled: "runtimePhaseCancelled",
  failed: "runtimePhaseFailed", idle: "runtimePhaseIdle",
};

export function mountRuntimeSettings(host: HTMLElement, onUpdate?: (reply: RuntimeReply) => void): { refresh(): void; destroy(): void } {
  host.classList.add("runtime-settings");
  const title = element("h3", t("runtimeTitle"));
  const summary = element("p", t("runtimeChecking"), "runtime-status");
  summary.setAttribute("role", "status");
  const note = element("p", t("runtimeFirstRun"));
  const timing = element("p");
  const active = element("p");
  const error = element("p", "", "runtime-error");
  error.setAttribute("role", "alert");
  const errorDetails = element("details", undefined, "runtime-error-details"); errorDetails.hidden = true;
  const errorDetailText = element("pre");
  errorDetails.append(element("summary", t("componentTechnicalDetails")), errorDetailText);
  const tableWrap = element("div", undefined, "runtime-table-scroll");
  tableWrap.tabIndex = 0;
  tableWrap.setAttribute("role", "region");
  tableWrap.setAttribute("aria-label", t("runtimeResults"));
  const actions = element("div", undefined, "runtime-actions");
  const button = (key: MessageKey): HTMLButtonElement => {
    const b = element("button", t(key), "btn");
    b.type = "button";
    b.dataset.variant = "outline";
    b.dataset.size = "sm";
    return b;
  };
  const apply = button("runtimeApply");
  const rerun = button("runtimeRerun");
  const cancel = button("runtimeCancel");
  const refresh = button("runtimeRefresh");
  actions.append(apply, rerun, cancel, refresh);
  const quality = element("p", t("runtimeQualityNote"));
  host.replaceChildren(title, summary, note, timing, active, error, errorDetails, tableWrap, actions, quality);

  let snapshot: RuntimeSnapshot | undefined;
  let choice: string | null = null;
  let tableSignature = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let destroyed = false;
  let generation = 0;
  let controller: AbortController | undefined;
  let actionError = "";
  let actionDetail = "";
  let cancelRequested = false;

  function buttons(): void {
    const busy = snapshot ? runtimeBusy(snapshot) : false;
    apply.disabled = pending || !snapshot || !canApplyRuntime(snapshot, choice);
    rerun.disabled = pending || !snapshot || busy;
    cancel.disabled = pending || cancelRequested || snapshot?.benchmark.status !== "running";
    cancel.hidden = snapshot?.benchmark.status !== "running";
    apply.hidden = rerun.hidden = !snapshot;
    refresh.disabled = pending;
  }

  function buildTable(s: RuntimeSnapshot): void {
    const signature = JSON.stringify([s.candidates, s.benchmark.results, s.active_id, s.selected_id, s.recommended_id, runtimeBusy(s)]);
    if (signature === tableSignature) return; // retain focus and radio state during progress ticks
    tableSignature = signature;
    const table = element("table");
    table.append(element("caption", t("runtimeResults")));
    const heading = element("tr");
    for (const key of ["runtimeConfiguration", "runtimeLatency", "runtimeThroughput", "runtimeResources", "runtimeQuality"] as const) {
      const th = element("th", t(key)); th.scope = "col"; heading.append(th);
    }
    const head = element("thead"); head.append(heading); table.append(head);
    const body = element("tbody");
    for (const c of s.candidates) {
      const row = element("tr"); row.dataset.active = String(c.id === s.active_id);
      const cell = element("td");
      const label = element("label");
      const input = element("input"); input.type = "radio"; input.name = "runtime-candidate"; input.value = c.id;
      input.checked = choice === c.id; input.disabled = !c.available || runtimeBusy(s);
      input.addEventListener("change", () => { choice = c.id; actionError = actionDetail = ""; error.hidden = errorDetails.hidden = true; buttons(); });
      const name = element("span", c.label);
      name.append(element("span", `${c.device} · ${c.runtime} · ${c.precision}`, "runtime-detail"));
      const tags = [c.id === s.active_id ? t("runtimeActive") : "", c.id === s.selected_id && c.id !== s.active_id ? t("runtimeSelected") : "", c.id === s.recommended_id ? t("runtimeRecommended") : ""].filter(Boolean);
      if (tags.length) name.append(element("span", tags.join(" · "), "runtime-detail"));
      if (!c.available) name.append(element("span", c.reason || t("runtimeUnavailable"), "runtime-detail"));
      const results = s.benchmark.results.filter((r) => r.candidate_id === c.id);
      const failed = results.find((r) => r.status === "error");
      if (failed) name.append(element("span", failed.error || t("runtimeTestFailed"), "runtime-detail"));
      label.append(input, name); cell.append(label); row.append(cell);
      const good = results.filter((r) => r.status === "ok");
      const single = good.find((r) => r.batch_size === 1);
      const batched = good.find((r) => r.batch_size === 8);
      const maximum = (key: "peak_rss_bytes" | "accelerator_bytes"): number | undefined => {
        const values = good.map((r) => r[key]).filter((n): n is number => n != null);
        return values.length ? Math.max(...values) : undefined;
      };
      const latency = element("td", metric(single?.latency_ms, "ms"), "runtime-metric");
      if (single) latency.append(element("span", t("runtimeLoadWarmup", metric(single.load_ms, "ms"), metric(single.warmup_ms, "ms")), "runtime-detail"));
      const throughput = element("td", metric(batched?.throughput_per_s, "rate"), "runtime-metric");
      if (batched) throughput.append(element("span", t("runtimeBatch", batched.batch_size ?? 8, batched.samples ?? 0), "runtime-detail"));
      const resources = element("td", undefined, "runtime-metric");
      for (const [key, value] of [["runtimeRam", maximum("peak_rss_bytes")], ["runtimeAccelerator", maximum("accelerator_bytes")]] as const) {
        const resource = element("div", undefined, "runtime-resource");
        resource.append(element("span", t(key), "runtime-detail"), element("span", metric(value, "bytes")));
        resources.append(resource);
      }
      row.append(latency, throughput, resources);
      const q = element("td", t("runtimeNotEvaluated"));
      if (c.experimental || /int8/i.test(c.precision)) q.append(element("span", t("runtimeExperimental"), "runtime-detail"));
      row.append(q); body.append(row);
    }
    table.append(body); tableWrap.replaceChildren(table);
  }

  function paint(reply: RuntimeReply): void {
    if (reply.kind !== "ok") {
      snapshot = undefined;
      summary.textContent = t(reply.kind === "unsupported" ? "runtimeLegacy" : reply.kind === "invalid" ? "runtimeInvalid" : "runtimeUnreachable");
      timing.hidden = active.hidden = tableWrap.hidden = quality.hidden = true;
      note.hidden = true;
      error.textContent = actionError; error.hidden = !actionError;
      errorDetailText.textContent = actionDetail; errorDetails.hidden = !actionDetail;
      buttons(); onUpdate?.(reply); return;
    }
    snapshot = reply.snapshot;
    const s = snapshot;
    if (s.benchmark.status !== "running") cancelRequested = false;
    if (choice && !s.candidates.some((c) => c.id === choice && c.available)) choice = null;
    if (choice === null && s.selected_id) choice = s.selected_id;
    // The recommendation is a draft choice, never a configuration write. A reader must
    // still press Apply, and later snapshots must never replace their own radio choice.
    if (choice === null && !runtimeBusy(s) && s.recommended_id && s.candidates.some((c) => c.id === s.recommended_id && c.available)) choice = s.recommended_id;
    summary.textContent = cancelRequested ? t("runtimeCancelling") : runtimeStateLabel(s);
    note.hidden = false;
    note.textContent = t(s.needs_selection ? "runtimeFirstRun" : "runtimeRerunNote");
    timing.hidden = false;
    const phase = phaseKeys[s.benchmark.phase] ? t(phaseKeys[s.benchmark.phase]) : s.benchmark.phase;
    const current = s.candidates.find((c) => c.id === s.benchmark.current_id)?.label;
    timing.textContent = t("runtimeProgress", phase || t("runtimePhaseIdle"), s.benchmark.completed, s.benchmark.total,
      s.benchmark.measurement_s.toFixed(1), s.benchmark.budget_s, s.benchmark.elapsed_s.toFixed(1)) + (current ? ` · ${current}` : "");
    active.hidden = false;
    const activeLabel = s.candidates.find((c) => c.id === s.active_id)?.label;
    const selectedLabel = s.candidates.find((c) => c.id === s.selected_id)?.label;
    active.textContent = activeLabel ? t("runtimeUsing", activeLabel) : t("runtimeNoActive");
    if (selectedLabel && s.selected_id !== s.active_id) active.textContent += ` ${t("runtimePending", selectedLabel)}`;
    error.textContent = actionError || (s.error ? t("runtimeTestFailed") : s.benchmark.status === "cancelled" ? t("runtimeCancelled") : s.benchmark.status === "failed" ? t("runtimeTestFailed") : "");
    error.hidden = !error.textContent;
    errorDetailText.textContent = actionDetail || s.error || ""; errorDetails.hidden = !errorDetailText.textContent;
    tableWrap.hidden = s.candidates.length === 0; quality.hidden = false;
    buildTable(s); buttons(); onUpdate?.(reply);
  }

  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer);
    if (!destroyed && document.visibilityState === "visible") timer = setTimeout(() => void poll(), runtimePollMs(snapshot));
  }

  async function poll(action?: RuntimeAction): Promise<void> {
    if (destroyed || pending || (!action && document.visibilityState !== "visible")) return;
    pending = true; buttons();
    const seq = generation;
    const requestedId = choice;
    const ac = new AbortController(); controller = ac;
    try {
      const url = await settings.serverUrl.getValue();
      if (seq !== generation || ac.signal.aborted) return;
      const reply = await requestRuntime(url, action, action === "config" ? requestedId ?? undefined : undefined, ac.signal);
      if (seq !== generation || ac.signal.aborted || destroyed) return;
      if (reply.kind === "rejected") {
        if (action === "cancel") cancelRequested = false;
        actionError = t("runtimeActionFailed"); actionDetail = reply.message ?? "";
        error.textContent = actionError; error.hidden = false;
        errorDetailText.textContent = actionDetail; errorDetails.hidden = !actionDetail;
      } else {
        if (action && reply.kind !== "ok") { actionError = t("runtimeActionFailed"); cancelRequested = false; }
        paint(reply);
      }
    } catch {
      if (seq === generation && !ac.signal.aborted && !destroyed) paint({ kind: "unavailable" });
    } finally {
      pending = false; controller = undefined; buttons(); schedule();
    }
  }

  function run(action?: RuntimeAction): void {
    if (pending) return;
    if (timer !== undefined) clearTimeout(timer);
    actionError = actionDetail = "";
    void poll(action);
  }
  apply.addEventListener("click", () => { if (snapshot && canApplyRuntime(snapshot, choice)) run("config"); });
  rerun.addEventListener("click", () => run("benchmark"));
  cancel.addEventListener("click", () => { cancelRequested = true; run("cancel"); });
  refresh.addEventListener("click", () => run());
  const visibility = (): void => {
    if (document.visibilityState === "visible") run();
    else { if (timer !== undefined) clearTimeout(timer); controller?.abort(); }
  };
  document.addEventListener("visibilitychange", visibility);
  const unwatch = settings.serverUrl.watch(() => {
    generation++; controller?.abort(); snapshot = undefined; choice = null; tableSignature = ""; cancelRequested = false;
    summary.textContent = t("runtimeChecking");
    tableWrap.hidden = timing.hidden = active.hidden = true; buttons();
    onUpdate?.({ kind: "unavailable" });
    if (!pending) run();
  });
  buttons(); void poll();
  return {
    refresh: () => run(),
    destroy() { destroyed = true; generation++; controller?.abort(); if (timer !== undefined) clearTimeout(timer); unwatch(); document.removeEventListener("visibilitychange", visibility); },
  };
}
