import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { localizePage } from "../../lib/ui/localize";
import { followSystemTheme } from "../../lib/ui/theme";
import { t, tn } from "../../lib/i18n";
import { CONTRACT_VERSION, type ModelInfo, type ScoreResult } from "../../lib/contract";
import { countWords } from "../../lib/dom/text";
import { readMinWords } from "../../lib/settings/settings";
import { shortTextNote } from "../../lib/render/coverage";
import { hasLookalikes } from "../../lib/dom/lookalikes";
import { readInWindows, unitVerdict, type WindowVerdict } from "../../lib/capture/windows";
import { requestScores, requestTokenCounts } from "../../lib/messaging/client";
import { modelDim } from "../../lib/backend/router";
import { cancelDocumentSession } from "../../lib/access/session";
import { band, bandLabel, BUCKET_BANDS, isNoVerdict } from "../../lib/render/band";
import { formatScore } from "../../lib/render/score";
import { bandColorRules, levelOf } from "../../lib/render/scale";

localizePage(); followSystemTheme();
// The four words' colours are the chips' and the marks' own.
const bandRules = document.createElement("style");
bandRules.textContent = bandColorRules("", "html.dark");
document.head.append(bandRules);
const input = document.getElementById("text") as HTMLTextAreaElement;
const fileInput = document.getElementById("file") as HTMLInputElement;
const analyze = document.getElementById("analyze") as HTMLButtonElement;
const status = document.getElementById("status")!;
const results = document.getElementById("results")!;
const list = document.getElementById("windows")!;
const includeText = document.getElementById("includeText") as HTMLInputElement;
const wordCount = document.getElementById("words")!;
let generation = 0;
let report: {text: string; windows: WindowVerdict[]; model: ModelInfo | null; coverage: string} | undefined;

function clearResult(): void { report = undefined; results.hidden = true; list.replaceChildren(); }
function countShown(): void {
  const n = countWords(input.value);
  wordCount.textContent = n > 0 ? tn("pasteWords", n) : "";
}
function readout(r: ScoreResult): string {
  const label = bandLabel(band(r));
  return isNoVerdict(band(r)) ? label : `${label}, ${formatScore(r.score)}, ${r.probs.map((p, i) => `${bandLabel(BUCKET_BANDS[i]!)} ${Math.round(p * 100)}%`).join(" / ")}`;
}
function cancel(): void { ++generation; cancelDocumentSession(); analyze.disabled = false; }
input.addEventListener("input", () => { cancel(); clearResult(); status.textContent = ""; countShown(); });
document.getElementById("pick")!.addEventListener("click", () => fileInput.click());
document.getElementById("settings")!.addEventListener("click", () => void browser.runtime.openOptionsPage());
document.getElementById("clear")!.addEventListener("click", () => {
  cancel(); input.value = ""; fileInput.value = ""; status.textContent = ""; clearResult(); countShown(); input.focus();
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
    input.value = text; status.textContent = ""; countShown();
  } catch { if (seq === generation) status.textContent = t("pasteFileFailed"); }
});
analyze.addEventListener("click", async () => {
  const text = input.value.trim();
  const seq = ++generation; clearResult();
  if (text.length > 200_000) { status.textContent = t("pasteTooLarge"); return; }
  const words = countWords(text);
  const floor = await readMinWords();
  if (seq !== generation) return;
  if (words < floor) { status.textContent = t("pasteShort", floor); return; }
  analyze.disabled = true; status.textContent = t("pasteBusy");
  let producing: ModelInfo | null = null;
  let uncounted = false;
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
    }, async (texts) => {
      const reply = await requestTokenCounts(texts);
      uncounted = reply.counts === null;
      return reply.counts;
    });
    if (seq !== generation) return;
    // A text whose words went uncounted was not read: the same failure as a score that was not.
    if (uncounted) throw new Error("unavailable");
    const read = windows.get("paste"); if (!read?.length) throw new Error("incomplete");
    const scored = read.filter((w) => !w.result.unsupported && !w.result.degraded);
    const coverage = t("pasteCoverage", scored.length, read.length,
      read.filter((w) => w.result.unsupported).length, read.filter((w) => w.result.degraded).length,
      read.filter((w) => w.result.truncated).length) +
      (shortTextNote(words) ? `, ${shortTextNote(words)}` : "") +
      (hasLookalikes(text) ? `, ${t("coverageLookalikes").trim()}` : "");
    document.getElementById("coverage")!.textContent = coverage;
    showVerdict(unitVerdict("paste", text.length, read).result);
    for (const window of read) {
      const item = document.createElement("li");
      const head = document.createElement("div"); head.className = "head";
      head.append(...wordAndScore(window.result));
      const passage = document.createElement("p"); passage.textContent = text.slice(window.start, window.end);
      item.className = colourOf(window.result);
      item.append(head, passage); list.append(item);
    }
    // One pass is the text above and the verdict again: listed only where there are several.
    list.hidden = read.length < 2;
    report = {text, windows: read, model: producing, coverage}; results.hidden = false; status.textContent = "";
  } catch { if (seq === generation) status.textContent = t("pasteFailed"); }
  finally { if (seq === generation) analyze.disabled = false; }
});
/** The class carrying a verdict's colour (--c), or none where there is no verdict. */
function colourOf(r: ScoreResult): string {
  return isNoVerdict(band(r)) ? "" : `b${levelOf(r.score)}`;
}
/** A verdict's chip and its word. */
function wordAndScore(r: ScoreResult): HTMLElement[] {
  const word = document.createElement("span"); word.textContent = bandLabel(band(r));
  if (isNoVerdict(band(r))) return [word];
  const chip = document.createElement("span"); chip.className = `chip ${colourOf(r)}`;
  chip.textContent = formatScore(r.score);
  return [chip, word];
}
/** The whole text's verdict: its word and score, then how the four words shared it. */
function showVerdict(r: ScoreResult): void {
  document.getElementById("summary")!.textContent = bandLabel(band(r));
  const score = document.getElementById("score")!;
  score.className = `chip ${colourOf(r)}`;
  score.textContent = isNoVerdict(band(r)) ? "" : formatScore(r.score);
  const mix = document.getElementById("mix")!, legend = document.getElementById("legend")!;
  mix.hidden = legend.hidden = isNoVerdict(band(r));
  mix.replaceChildren(...r.probs.map((p, i) => {
    const part = document.createElement("span"); part.className = `b${i}`; part.style.flex = String(p);
    return part;
  }));
  legend.replaceChildren(...r.probs.map((p, i) => {
    const row = document.createElement("li"); row.className = `b${i}`;
    const dot = document.createElement("span"); dot.className = "dot";
    const label = document.createElement("span"); label.className = "lbl"; label.textContent = bandLabel(BUCKET_BANDS[i]!);
    const share = document.createElement("span"); share.className = "n"; share.textContent = `${Math.round(p * 100)}%`;
    row.append(dot, label, share);
    return row;
  }));
}
document.getElementById("copy")!.addEventListener("click", async () => {
  if (!report) return;
  const lines = [t("reportPrivateTitle"), `Anagram ${browser.runtime.getManifest().version}, contract ${CONTRACT_VERSION}`, report.coverage, t("reportCaveat"), t("reportEstimate")];
  if (report.model) lines.push(JSON.stringify(report.model));
  report.windows.forEach((w, index) => {
    lines.push(`${index + 1}. ${readout(w.result)}${w.result.truncated ? `, ${t("reportUnread")}` : ""}`);
    if (includeText.checked) lines.push(report!.text.slice(w.start, w.end));
  });
  try { await navigator.clipboard.writeText(lines.join("\n\n")); status.textContent = t("copied"); }
  catch { status.textContent = t("reportCopyFailed"); }
});
countShown();
