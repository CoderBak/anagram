// The configuration list under Advanced: one radio row per candidate, Use selected, Run
// benchmark, Cancel. Mounting only reads status; a benchmark never changes the selection.
import { t } from "../i18n";
import {
  requestRuntime, runtimeBusy, runtimePollMs,
  type RuntimeReply, type RuntimeSnapshot, type RuntimeAction,
} from "../backend/runtimeClient";
import "./runtimeSettings.css";

/** "812 MB" / "1.4 GB": decimal units, one decimal for gigabytes. */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toLocaleString(undefined, { maximumFractionDigits: 1 })} GB`;
  return `${Math.round(n / 1e6).toLocaleString()} MB`;
}

function canApplyRuntime(s: RuntimeSnapshot, id: string | null): boolean {
  return !runtimeBusy(s) && id !== null && id !== s.selected_id && s.candidates.some((c) => c.id === id && c.available);
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, cls?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (cls) el.className = cls;
  return el;
}

const number = (value: number | null | undefined, digits: number): string =>
  value == null ? "–" : value.toLocaleString(undefined, { maximumFractionDigits: digits });

/** "42.5 ms · 50 texts/s · 2 GB" for a candidate with at least one finished result. */
function measuredLine(s: RuntimeSnapshot, id: string): string | null {
  const good = s.benchmark.results.filter((r) => r.candidate_id === id && r.status === "ok");
  if (good.length === 0) return null;
  const single = good.find((r) => r.batch_size === 1) ?? good[0];
  const batched = good.find((r) => r.batch_size !== 1) ?? good[0];
  const memory = good.map((r) => r.peak_rss_bytes).filter((n): n is number => n != null);
  return t("runtimeMeasured", number(single.latency_ms, 1), number(batched.throughput_per_s, 0), memory.length ? formatBytes(Math.max(...memory)) : "–");
}

export function mountRuntimeSettings(host: HTMLElement, onUpdate?: (reply: RuntimeReply) => void): { refresh(): void; destroy(): void } {
  host.classList.add("runtime-settings");
  const title = element("h3", t("runtimeTitle")); title.id = "runtime-title";
  const list = element("div", undefined, "runtime-list"); list.setAttribute("role", "radiogroup"); list.setAttribute("aria-labelledby", title.id);
  const status = element("p", "", "runtime-status"); status.setAttribute("role", "status"); status.hidden = true;
  const error = element("p", "", "runtime-error"); error.setAttribute("role", "alert"); error.hidden = true;
  const errorDetails = element("details", undefined, "runtime-error-details"); errorDetails.hidden = true;
  const errorDetailText = element("pre");
  errorDetails.append(element("summary", t("componentDetails")), errorDetailText);
  const actions = element("div", undefined, "runtime-actions");
  const button = (text: string): HTMLButtonElement => {
    const b = element("button", text, "btn"); b.type = "button"; b.dataset.variant = "outline"; b.dataset.size = "sm"; return b;
  };
  const apply = button(t("runtimeApply"));
  const benchmark = button(t("runtimeBenchmark"));
  const cancel = button(t("buttonCancel"));
  actions.append(apply, benchmark, cancel);
  host.replaceChildren(title, list, status, error, errorDetails, actions);

  let snapshot: RuntimeSnapshot | undefined;
  let choice: string | null = null;
  let listSignature = "";
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false, destroyed = false, cancelRequested = false;
  let generation = 0;
  let controller: AbortController | undefined;
  let actionError = "", actionDetail = "";

  function buttons(): void {
    const running = snapshot?.benchmark.status === "running";
    apply.disabled = pending || !snapshot || !canApplyRuntime(snapshot, choice);
    benchmark.disabled = pending || !snapshot || runtimeBusy(snapshot);
    cancel.hidden = !running;
    cancel.disabled = pending || cancelRequested;
    apply.hidden = benchmark.hidden = !snapshot;
  }

  function buildList(s: RuntimeSnapshot): void {
    const signature = JSON.stringify([s.candidates, s.benchmark.results, s.active_id, s.selected_id, s.recommended_id, s.fastest_id, runtimeBusy(s)]);
    if (signature === listSignature) return; // keeps focus and the radio choice across progress ticks
    listSignature = signature;
    const rows: HTMLElement[] = [];
    for (const c of s.candidates) {
      const row = element("label", undefined, "runtime-row"); row.dataset.active = String(c.id === s.active_id);
      const input = element("input"); input.type = "radio"; input.name = "runtime-candidate"; input.value = c.id;
      input.checked = choice === c.id; input.disabled = !c.available || runtimeBusy(s);
      input.addEventListener("change", () => { choice = c.id; actionError = actionDetail = ""; error.hidden = errorDetails.hidden = true; buttons(); });
      const body = element("span", undefined, "runtime-body");
      const name = element("span", c.label, "runtime-name");
      const tags = [c.id === s.active_id ? t("runtimeActive") : "", c.id === s.recommended_id ? t("runtimeRecommended") : "",
        c.id === s.fastest_id ? t("runtimeFastest") : "", c.experimental ? t("runtimeExperimental") : ""].filter(Boolean);
      for (const tag of tags) name.append(element("span", tag, "badge"));
      body.append(name, element("span", `${c.device} · ${c.runtime} · ${c.precision}`, "runtime-detail"));
      if (!c.available) body.append(element("span", c.reason || t("runtimeUnavailable"), "runtime-detail"));
      const failed = s.benchmark.results.find((r) => r.candidate_id === c.id && r.status === "error");
      if (failed) body.append(element("span", failed.error || t("runtimeFailed"), "runtime-detail runtime-failed"));
      const measured = measuredLine(s, c.id);
      if (measured) body.append(element("span", measured, "runtime-detail runtime-measured"));
      row.append(input, body); rows.push(row);
    }
    list.replaceChildren(...rows);
  }

  function paint(reply: RuntimeReply): void {
    if (reply.kind !== "ok") {
      snapshot = undefined; list.hidden = status.hidden = true;
      error.textContent = actionError || t("componentFailed"); error.hidden = false;
      errorDetailText.textContent = actionDetail || reply.message || ""; errorDetails.hidden = !errorDetailText.textContent;
      buttons(); onUpdate?.(reply); return;
    }
    const s = snapshot = reply.snapshot;
    if (s.benchmark.status !== "running") cancelRequested = false;
    if (choice && !s.candidates.some((c) => c.id === choice && c.available)) choice = null;
    if (choice === null) choice = s.selected_id ?? s.recommended_id;
    const running = s.benchmark.status === "running";
    status.hidden = !running;
    if (running) {
      const current = s.candidates.find((c) => c.id === s.benchmark.current_id)?.label;
      status.textContent = t("runtimeProgress", s.benchmark.completed, s.benchmark.total) + (current ? ` · ${current}` : "");
    }
    error.textContent = actionError || (s.error || s.benchmark.status === "failed" ? t("runtimeFailed") : "");
    error.hidden = !error.textContent;
    errorDetailText.textContent = actionDetail || s.error || ""; errorDetails.hidden = !errorDetailText.textContent;
    list.hidden = s.candidates.length === 0;
    buildList(s); buttons(); onUpdate?.(reply);
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
      const reply = await requestRuntime(action, action === "config" ? requestedId ?? undefined : undefined, ac.signal);
      if (seq !== generation || ac.signal.aborted || destroyed) return;
      if (reply.kind === "rejected") {
        if (action === "cancel") cancelRequested = false;
        actionError = t("componentFailed"); actionDetail = reply.message ?? "";
        error.textContent = actionError; error.hidden = false;
        errorDetailText.textContent = actionDetail; errorDetails.hidden = !actionDetail;
      } else {
        if (action && reply.kind !== "ok") { actionError = t("componentFailed"); cancelRequested = false; }
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
  benchmark.addEventListener("click", () => run("benchmark"));
  cancel.addEventListener("click", () => { cancelRequested = true; run("cancel"); });
  const visibility = (): void => {
    if (document.visibilityState === "visible") run();
    else { if (timer !== undefined) clearTimeout(timer); controller?.abort(); }
  };
  document.addEventListener("visibilitychange", visibility);
  buttons(); void poll();
  return {
    refresh: () => run(),
    destroy() { destroyed = true; generation++; controller?.abort(); if (timer !== undefined) clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); },
  };
}
