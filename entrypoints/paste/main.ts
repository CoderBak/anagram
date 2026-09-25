import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { localizePage } from "../../lib/ui/localize";
import { followSystemTheme } from "../../lib/ui/theme";
import { t } from "../../lib/i18n";
import { CONTRACT_VERSION, type ModelInfo, type ScoreResult } from "../../lib/contract";
import { countWords, MIN_UNIT_WORDS } from "../../lib/dom/text";
import { readInWindows, unitVerdict, type WindowVerdict } from "../../lib/capture/windows";
import { requestScores, requestTokenCounts } from "../../lib/messaging/client";
import { modelDim } from "../../lib/backend/router";
import { cancelDocumentSession } from "../../lib/access/session";
import { band, bandLabel, BUCKET_BANDS, isNoVerdict } from "../../lib/render/band";
import { formatScore } from "../../lib/render/score";

localizePage(); followSystemTheme();
const input = document.getElementById("text") as HTMLTextAreaElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
const analyze = document.getElementById("analyze") as HTMLButtonElement;
const status = document.getElementById("status")!;
const results = document.getElementById("results")!;
const list = document.getElementById("windows")!;
const includeText = document.getElementById("includeText") as HTMLInputElement;
let generation = 0;
let report: {text: string; windows: WindowVerdict[]; model: ModelInfo | null; coverage: string} | undefined;

function clearResult(): void { report = undefined; results.hidden = true; list.replaceChildren(); }
function readout(r: ScoreResult): string {
  const label = bandLabel(band(r));
  return isNoVerdict(band(r)) ? label : `${label} · ${formatScore(r.score)} · ${r.probs.map((p, i) => `${bandLabel(BUCKET_BANDS[i])} ${Math.round(p * 100)}%`).join(" / ")}`;
}
function cancel(): void { ++generation; cancelDocumentSession(); analyze.disabled = false; }
input.addEventListener("input", () => { cancel(); clearResult(); status.textContent = ""; });
document.getElementById("settings")!.addEventListener("click", () => void browser.runtime.openOptionsPage());
document.getElementById("clear")!.addEventListener("click", () => {
  cancel(); input.value = ""; fileInput.value = ""; status.textContent = ""; clearResult(); input.focus();
});
fileInput.addEventListener("change", async () => {
  cancel(); const seq = generation;
  const file = fileInput.files?.[0]; if (!file) return;
  clearResult();
  if (file.size > 1024 ** 2) { status.textContent = t("pasteTooLarge"); return; }
  try {
    const text = new TextDecoder("utf-8", {fatal: true}).decode(await file.arrayBuffer());
    if (seq !== generation) return;
    if (text.length > 200_000) { status.textContent = t("pasteTooLarge"); return; }
    input.value = text; status.textContent = "";
  } catch { if (seq === generation) status.textContent = t("pasteFileFailed"); }
});
analyze.addEventListener("click", async () => {
  const text = input.value.trim();
  const seq = ++generation; clearResult();
  if (text.length > 200_000) { status.textContent = t("pasteTooLarge"); return; }
  if (countWords(text) < MIN_UNIT_WORDS) { status.textContent = t("pasteShort", MIN_UNIT_WORDS); return; }
  analyze.disabled = true; status.textContent = t("pasteBusy");
  let producing: ModelInfo | null = null;
  try {
    const windows = await readInWindows([{id: "paste", text, order: 0}], async (blocks) => {
      const out = new Map<string, ScoreResult>();
      for (let offset = 0; offset < blocks.length; offset += 4) {
        if (seq !== generation) throw new Error("cancelled");
        const response = await requestScores({v: CONTRACT_VERSION, session: `paste-${seq}`, priority: "viewport", blocks: blocks.slice(offset, offset + 4)});
        if (seq !== generation || response.backend !== "up" || !response.model) throw new Error("unavailable");
        const model = response.model;
        if (producing && modelDim(model) !== modelDim(producing)) throw new Error("model_changed");
        producing = model;
        for (const result of response.results) out.set(result.id, result);
      }
      return out;
    }, requestTokenCounts);
    if (seq !== generation) return;
    const read = windows.get("paste"); if (!read?.length) throw new Error("incomplete");
    const scored = read.filter((w) => !w.result.unsupported && !w.result.degraded);
    const coverage = t("pasteCoverage", scored.length, read.length,
      read.filter((w) => w.result.unsupported).length, read.filter((w) => w.result.degraded).length,
      read.filter((w) => w.result.truncated).length);
    document.getElementById("coverage")!.textContent = coverage;
    document.getElementById("summary")!.textContent = readout(unitVerdict("paste", text.length, read).result);
    for (const window of read) {
      const item = document.createElement("li");
      const result = document.createElement("p"); result.textContent = readout(window.result);
      const passage = document.createElement("p"); passage.textContent = text.slice(window.start, window.end);
      item.append(result, passage); list.append(item);
    }
    report = {text, windows: read, model: producing, coverage}; results.hidden = false; status.textContent = "";
  } catch { if (seq === generation) status.textContent = t("pasteFailed"); }
  finally { if (seq === generation) analyze.disabled = false; }
});
document.getElementById("copy")!.addEventListener("click", async () => {
  if (!report) return;
  const lines = [t("reportPrivateTitle"), `Anagram ${browser.runtime.getManifest().version} · contract ${CONTRACT_VERSION}`, report.coverage, t("reportEstimate")];
  if (report.model) lines.push(JSON.stringify(report.model));
  report.windows.forEach((w, index) => {
    lines.push(`${index + 1}. ${readout(w.result)}${w.result.truncated ? ` · ${t("reportUnread")}` : ""}`);
    if (includeText.checked) lines.push(report!.text.slice(w.start, w.end));
  });
  try { await navigator.clipboard.writeText(lines.join("\n\n")); status.textContent = t("copied"); }
  catch { status.textContent = t("reportCopyFailed"); }
});
