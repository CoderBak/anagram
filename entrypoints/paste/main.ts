import {sentenceReadout} from "../../lib/render/dist";
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { bindDisclosure } from "../../lib/ui/disclosure";
import { localizePage } from "../../lib/ui/localize";
import { followSystemTheme } from "../../lib/ui/theme";
import { t, tn } from "../../lib/i18n";
import { CONTRACT_VERSION, modelDim, type ModelInfo, type ScoreResult } from "../../lib/contract";
import { detectorWordCount } from "../../lib/webengine/detectorScore";
import { countWords, detectorText, MAX_UNIT_TEXT_CHARS, MIN_WORDS } from "../../lib/dom/text";
import { settings } from "../../lib/settings/settings";
import { shortTextNote } from "../../lib/render/coverage";
import { hasLookalikes } from "../../lib/dom/lookalikes";
import { readParagraphs } from "../../lib/capture/readParagraphs";
import { meanVerdict, unitVerdict, type UnitVerdict } from "../../lib/capture/windows";
import { groupPassages } from "../../lib/plan/passages";
import { ACTIONS, type BackendStatus } from "../../lib/messaging/protocol";
import { groupBlocks } from "../../lib/plan/group";
import { requestScores, requestTokenCounts } from "../../lib/messaging/client";
import { cancelDocumentSession, sendDocumentMessage } from "../../lib/access/session";
import { resultBands, resultLevel, band, bandLabel, BUCKET_BANDS, flagFromOf, isFlaggedBand, isNoVerdict, type FlagFrom } from "../../lib/render/band";
import { formatScore } from "../../lib/render/score";
import { adoptBandColorRules } from "../../lib/render/scale";

localizePage(); followSystemTheme();
adoptBandColorRules();
const input = document.getElementById("text") as HTMLTextAreaElement;
input.maxLength = MAX_UNIT_TEXT_CHARS;
const fileInput = document.getElementById("file") as HTMLInputElement;
const pick = document.getElementById("pick") as HTMLButtonElement;
const analyze = document.getElementById("analyze") as HTMLButtonElement;
const edit = document.getElementById("edit") as HTMLButtonElement;
const status = document.getElementById("status")!;
const results = document.getElementById("results")!;
const reading = document.getElementById("reading")!;
const includeText = document.getElementById("includeText") as HTMLInputElement;
const clear = document.getElementById("clear") as HTMLButtonElement;
const wordCount = document.getElementById("words")!;
const scoreToggle = document.getElementById("scoreToggle") as HTMLButtonElement;
const scoreDetails = document.getElementById("scoreDetails")!;
bindDisclosure(scoreToggle, scoreDetails);
let generation = 0;
let minimumWords = MIN_WORDS;
let sentenceDetector = true;
const readStatus = async () => await sendDocumentMessage({ action: ACTIONS.GET_BACKEND_STATUS }) as BackendStatus | undefined;

/** A paragraph of the text: blank lines part them, as in CommonMark; a single line break is a
 *  line wrapped inside one (a text pasted from an e-mail or a PDF). */
interface Paragraph { text: string; words: number }
/** A paragraph as read: alone, or with the short ones beside it (the unit it is part of). */
interface Read { paragraphs: Paragraph[]; text: string; verdict: UnitVerdict | null }
let report: {reads: Read[]; whole: ScoreResult | null; model: ModelInfo | null; coverage: string} | undefined;

function paragraphsOf(text: string): Paragraph[] {
  return text.split(/\n[ \t]*\n\s*/u).map((p) => p.trim()).filter((p) => p !== "").map((p) => ({ text: p, words: countWords(p) }));
}

const copyStatus = document.getElementById("copyStatus")!;

function clearResult(): void {
  copyStatus.textContent = "";
  report = undefined;
  scoreDetails.hidden = true;
  scoreToggle.setAttribute("aria-expanded", "false");
  includeText.checked = false;
  results.hidden = edit.hidden = true;
  input.hidden = analyze.hidden = false;
  reading.replaceChildren();
}
function countShown(): void {
  clear.hidden = input.value.length === 0 && !status.textContent;
  const n = sentenceDetector ? detectorWordCount(input.value) : countWords(input.value);
  analyze.disabled = n < minimumWords;
  wordCount.textContent = n === 0 ? t("pasteMinimum", minimumWords)
    : n < minimumWords ? t("pasteProgress", n, minimumWords) : tn("pasteWords", n);
}
function readout(r: ScoreResult): string {
  const label = bandLabel(band(r));
  const summary = isNoVerdict(band(r)) ? label : `${label}, ${formatScore(r.score)}, ${r.probs.map((p, i) => `${bandLabel(resultBands(r)[i]!)} ${Math.round(p * 100)}%`).join(" / ")}`;
  return r.sentenceLabels?.length ? summary + ". " + t("detectorSentences")+" — "+sentenceReadout(r.sentenceLabels) : summary;
}
function cancel(): void { ++generation; cancelDocumentSession(); }
input.addEventListener("input", () => { cancel(); clearResult(); status.textContent = ""; countShown(); });
pick.addEventListener("click", () => fileInput.click());
document.getElementById("settings")!.addEventListener("click", () => void browser.runtime.openOptionsPage());
function clearDraft(): void {
  cancel(); input.value = ""; fileInput.value = ""; status.textContent = ""; clearResult(); countShown();
}
edit.addEventListener("click", () => {
  ++generation; // Abandon a pending file read. The draft and its cached verdict still match.
  clearResult();
  countShown();
  status.textContent = "";
  input.focus();
});
clear.addEventListener("click", () => { clearDraft(); input.focus(); });
window.addEventListener("pagehide", clearDraft);
fileInput.addEventListener("change", async () => {
  const file = fileInput.files?.[0]; if (!file) return;
  fileInput.value = ""; // The same file can be picked again after it has been corrected.
  const seq = ++generation;
  analyze.disabled = true;
  clear.hidden = false;
  try {
    if (file.size > 1024 ** 2) { status.textContent = t("pasteTooLarge"); return; }
    status.textContent = "";
    const text = new TextDecoder("utf-8", {fatal: true}).decode(await file.arrayBuffer());
    if (seq !== generation) return;
    if (text.length > MAX_UNIT_TEXT_CHARS) { status.textContent = t("pasteTooLarge"); return; }
    cancelDocumentSession();
    clearResult();
    input.value = text;
    status.textContent = "";
    if (document.activeElement === pick) input.focus();
  } catch {
    if (seq === generation) status.textContent = t("pasteFileFailed");
  } finally {
    if (seq === generation) countShown();
  }
});

analyze.addEventListener("click", async () => {
  const text = input.value.trim();
  const seq = ++generation; clearResult();
  if (text.length > MAX_UNIT_TEXT_CHARS) { status.textContent = t("pasteTooLarge"); return; }
  analyze.disabled = true; status.textContent = t("pasteBusy");
  const paragraphs = paragraphsOf(text);
  let producing: ModelInfo | null = null;
  let uncounted = false;
  try {
    const backendStatus = await readStatus();
    if (seq !== generation) return;
    const model = backendStatus?.model;
    const floor = backendStatus?.server?.minWords ?? MIN_WORDS;
    minimumWords = floor;
    sentenceDetector = !model || model.id === "none" || model.calibration === "anagram-detector/1";
    const words = sentenceDetector ? detectorWordCount(text, floor) : countWords(text);
    if (words < floor) { status.textContent = t("pasteShort", floor); return; }
    const blocks = sentenceDetector ? paragraphs.map(p => {
      const text = detectorText(p.text);
      return { text, sourceChars: p.text.length, words: detectorWordCount(text, floor) };
    }) : paragraphs;
    const plan = sentenceDetector
      ? await groupPassages(blocks, floor, async texts => {
          if (seq !== generation) throw new Error("cancelled");
          return (await requestTokenCounts(texts, model?.id === "none" ? undefined : model ?? undefined)).counts;
        })
      : groupBlocks(paragraphs.map(p => ({ words: p.words, chars: p.text.length })), floor);
    if (!plan) throw new Error("unavailable");
    const groups = plan.filter(group => group.reduce((n, i) => n + blocks[i]!.words, 0) >= floor);
    const grouped = new Set(groups.flat());
    const units = groups.map((group, k) => ({ id: `p${k}`, text: group.map(i => paragraphs[i]!.text).join("\n\n"), order: k }));
    const windows = await readParagraphs(units, async (blocks) => {
      const out = new Map<string, ScoreResult>();
      for (let offset = 0; offset < blocks.length; offset += 4) {
        if (seq !== generation) throw new Error("cancelled");
        const response = await requestScores({v: CONTRACT_VERSION, session: `paste-${seq}`, priority: "viewport", blocks: blocks.slice(offset, offset + 4)});
        if (seq !== generation || response.backend !== "up" || !response.model) throw new Error("unavailable");
        const model = response.model;
        if (producing && modelDim(model) !== modelDim(producing)) throw new Error("model_changed");
        if (backendStatus?.model?.calibration === "anagram-detector/1" && modelDim(model) !== modelDim(backendStatus.model)) throw new Error("model_changed");
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
    const verdicts = new Map<number, UnitVerdict>();
    units.forEach((unit, k) => {
      const read = windows.get(unit.id);
      if (!read?.length) throw new Error("incomplete");
      verdicts.set(k, unitVerdict(unit.id, unit.text.length, read, unit.text));
    });
    // Every paragraph in reading order, each with the unit it was read in; one too short to be
    // read with anything stands alone, with no verdict.
    const reads: Read[] = [];
    for (let i = 0; i < paragraphs.length; i++) {
      const k = groups.findIndex((g) => g[0] === i);
      if (k >= 0) {
        const members = groups[k]!.map((m) => paragraphs[m]!);
        reads.push({ paragraphs: members, text: units[k]!.text, verdict: verdicts.get(k)! });
      } else if (!grouped.has(i)) reads.push({ paragraphs: [paragraphs[i]!], text: paragraphs[i]!.text, verdict: null });
    }
    const whole = meanVerdict("paste", reads.flatMap((r) => (r.verdict ? [{ result: r.verdict.result, chars: r.text.length }] : [])));
    const coverage = coverageLine(reads, text);
    report = {reads, whole, model: producing, coverage};
    await show(report);
    if (seq !== generation) return;
    input.hidden = analyze.hidden = true;
    results.hidden = edit.hidden = false;
    document.getElementById("readingTitle")!.hidden = paragraphs.length === 1;
    status.textContent = "";
    if (document.activeElement === document.body || document.activeElement === analyze) document.getElementById("summary")!.focus({ preventScroll: true });
  } catch { if (seq === generation) status.textContent = t("pasteFailed"); }
  finally { if (seq === generation) countShown(); }
});

/** How much of the text was read: the paragraphs with a verdict of all of them, and why the
 *  others have none (too short to read, another language, the engine failed them). */
function unitWarning(read: Read): string {
  return read.verdict && read.verdict.result.probs.length!==3 && !isNoVerdict(band(read.verdict.result))
    ? shortTextNote(read.paragraphs.reduce((sum, p) => sum + p.words, 0)).trim() : "";
}

function coverageLine(reads: readonly Read[], text: string): string {
  const count = (test: (r: Read) => boolean): number => reads.filter(test).reduce((n, r) => n + r.paragraphs.length, 0);
  const all = count(() => true);
  const scored = count((r) => !!r.verdict && !isNoVerdict(band(r.verdict.result)));
  const parts = [scored === 1 && all === 1 ? t("pasteOneRead") : t("pasteCoverageRead", scored, all)];
  const short = count((r) => !r.verdict);
  const foreign = count((r) => !!r.verdict?.result.unsupported);
  const failed = count((r) => !!r.verdict?.result.degraded);
  if (short) parts.push(t("pasteCoverageShort", short));
  if (foreign) parts.push(t("pasteCoverageForeign", foreign));
  if (failed) parts.push(t("pasteCoverageFailed", failed));
  const warning = reads.map(unitWarning).find(Boolean);
  if (warning) parts.push(warning);
  if (hasLookalikes(text)) parts.push(t("coverageLookalikes").trim());
  return parts.join(", ");
}

/** The class carrying a verdict's colour (--c), or none where there is no verdict. */
function colourOf(r: ScoreResult): string {
  return isNoVerdict(band(r)) ? "" : `b${resultLevel(r)}`;
}
/** A verdict's chip, its readout as its name. */
function chipOf(r: ScoreResult): HTMLElement {
  const chip = document.createElement("span"); chip.className = `chip ${colourOf(r)}`;
  chip.textContent = formatScore(r.score);
  chip.title = readout(r);
  chip.setAttribute("role", "img"); chip.setAttribute("aria-label", readout(r));
  return chip;
}

let paintRevision = 0;
async function show({reads, whole, coverage}: NonNullable<typeof report>): Promise<void> {
  const revision = ++paintRevision;
  const [flagFrom, underlines, scope] = await Promise.all([
    settings.flagFrom.getValue().then(flagFromOf).catch((): FlagFrom => "heavy"),
    settings.showHighlights.getValue().catch(() => true),
    settings.underlineScope.getValue().catch(() => "flagged" as const),
  ]);
  if (reads !== report?.reads || revision !== paintRevision) return;
  showWhole(whole);
  const coverageEl = document.getElementById("coverage")!;
  coverageEl.textContent = coverage;
  coverageEl.hidden = coverage === t("pasteOneRead");
  const onlyResult = reads.length === 1 && reads[0]!.paragraphs.length === 1 ? reads[0]!.verdict?.result : undefined;
  const sameScore = onlyResult && whole && band(onlyResult) === band(whole) && formatScore(onlyResult.score) === formatScore(whole.score);
  const headlineScore = document.getElementById("score")!;
  if (sameScore) {
    headlineScore.title = readout(onlyResult);
    headlineScore.setAttribute("role", "img");
    headlineScore.setAttribute("aria-label", headlineScore.title);
  } else {
    headlineScore.removeAttribute("title");
    headlineScore.removeAttribute("role");
    headlineScore.removeAttribute("aria-label");
  }
  // Paragraphs in one scoring unit are joined by two newlines. Keep those offsets when painting the stretches.
  reading.replaceChildren(...reads.map((read) => {
    const block = document.createElement("div");
    block.className = "read";
    const r = read.verdict?.result;
    if (!r || isNoVerdict(band(r))) block.classList.add("unread");
    else block.classList.add(colourOf(r));
    const stretches = underlines ? (read.verdict?.stretches ?? []).filter(({result}) =>
      !isNoVerdict(band(result)) && (scope === "all" || isFlaggedBand(band(result), flagFrom))) : [];
    let offset = 0;
    let next = 0;
    read.paragraphs.forEach((paragraph, i) => {
      const p = document.createElement("p");
      const end = offset + paragraph.text.length;
      let cursor = offset;
      while (next < stretches.length) {
        const stretch = stretches[next]!;
        if (stretch.start >= end) break;
        if (stretch.end > cursor) {
          const start = Math.max(cursor, stretch.start);
          p.append(read.text.slice(cursor, start));
          const mark = document.createElement("span");
          mark.className = `marked ${colourOf(stretch.result)}`;
          mark.title = bandLabel(band(stretch.result));
          cursor = Math.min(end, stretch.end);
          mark.textContent = read.text.slice(start, cursor);
          p.append(mark);
        }
        if (stretch.end > end) break;
        next++;
      }
      p.append(read.text.slice(cursor, end));
      offset = end + 2;
      if (r && !sameScore && i === read.paragraphs.length - 1) {
        p.append(" ");
        if (isNoVerdict(band(r))) {
          const word = document.createElement("span"); word.className = "note"; word.textContent = bandLabel(band(r));
          p.append(word);
        } else {
          p.append(chipOf(r));
          const warning = unitWarning(read);
          if (warning && reads.length > 1) {
            const note = document.createElement("span");
            note.className = "note";
            note.textContent = " " + warning;
            p.append(note);
          }
          if (read.paragraphs.length > 1) {
            const times = document.createElement("span"); times.className = "note"; times.textContent = `×${read.paragraphs.length}`;
            p.append(times);
          }
        }
      }
      block.append(p);
    });
    return block;
  }));
}

function refreshMarks(): void {
  if (report) void show(report);
}
settings.flagFrom.watch(refreshMarks);
settings.showHighlights.watch(refreshMarks);
settings.underlineScope.watch(refreshMarks);

function scoreExplanation(r: ScoreResult): string {
  return t(r.probs.length === 3 ? "reportEstimate" : "reportLegacyEstimate");
}

/** The class shares behind the headline score, in model order. */
function showWhole(r: ScoreResult | null): void {
  document.getElementById("summary")!.textContent = r ? bandLabel(band(r)) : t("pasteNothingRead");
  const score = document.getElementById("score")!;
  score.className = r ? `chip ${colourOf(r)}` : "chip";
  score.textContent = r ? formatScore(r.score) : "";
  scoreToggle.hidden = !r;
  document.getElementById("estimate")!.textContent = r ? scoreExplanation(r) : "";
  const mix = document.getElementById("mix")!, legend = document.getElementById("legend")!;
  const shares = r?.probs ?? [];
  const bands = r ? resultBands(r) : [];
  const colours = bands.map((b) => b === "assisted" ? 1 : BUCKET_BANDS.indexOf(b));
  mix.replaceChildren(...shares.flatMap((n, i) => {
    if (n === 0) return [];
    const part = document.createElement("span"); part.className = `b${colours[i]}`; part.style.flex = String(n);
    return part;
  }));
  legend.replaceChildren(...shares.map((n, i) => {
    const row = document.createElement("li"); row.className = `b${colours[i]}`;
    const dot = document.createElement("span"); dot.className = "dot";
    const label = document.createElement("span"); label.className = "lbl"; label.textContent = bandLabel(bands[i]!);
    const share = document.createElement("span"); share.className = "n"; share.textContent = `${Math.round(n * 100)}%`;
    row.append(dot, label, share);
    return row;
  }));
}

document.getElementById("copy")!.addEventListener("click", async () => {
  const currentReport = report;
  if (!report) return;
  const lines = [t("reportPrivateTitle"), `Anagram ${browser.runtime.getManifest().version}, contract ${CONTRACT_VERSION}`, report.coverage, t("reportCaveat")];
  if (report.whole) lines.push(scoreExplanation(report.whole));
  if (report.model) lines.push(JSON.stringify(report.model));
  if (report.whole) lines.push(readout(report.whole));
  report.reads.forEach((read, index) => {
    const r = read.verdict?.result;
    lines.push(`${index + 1}. ${r ? readout(r) : t("pasteTooShortToRead")}${r?.truncated ? ` (${t("reportUnread")})` : ""}${read.paragraphs.length > 1 ? ` (×${read.paragraphs.length})` : ""}`);
    if (includeText.checked) lines.push(read.text);
  });
  try {
    await navigator.clipboard.writeText(lines.join("\n\n"));
    if (report === currentReport) copyStatus.textContent = t("copied");
  } catch {
    if (report === currentReport) copyStatus.textContent = t("reportCopyFailed");
  }
});
void readStatus().then(s => {
  if (generation === 0 && s?.model) {
    sentenceDetector = s.model.calibration === "anagram-detector/1";
    minimumWords = s.server?.minWords ?? MIN_WORDS;
    countShown();
  }
}, () => undefined);
countShown();
