import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { localizePage } from "../../lib/ui/localize";
import { followSystemTheme } from "../../lib/ui/theme";
import { t, tn } from "../../lib/i18n";
import { CONTRACT_VERSION, type ModelInfo, type ScoreResult } from "../../lib/contract";
import { countWords } from "../../lib/dom/text";
import { readMinWords, settings } from "../../lib/settings/settings";
import { shortTextNote } from "../../lib/render/coverage";
import { hasLookalikes } from "../../lib/dom/lookalikes";
import { meanVerdict, readInWindows, unitVerdict, type UnitVerdict } from "../../lib/capture/windows";
import { groupBlocks } from "../../lib/plan/group";
import { requestScores, requestTokenCounts } from "../../lib/messaging/client";
import { modelDim } from "../../lib/backend/router";
import { cancelDocumentSession } from "../../lib/access/session";
import { band, bandLabel, BUCKET_BANDS, flagFromOf, isFlagged, isNoVerdict, type FlagFrom } from "../../lib/render/band";
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
const reading = document.getElementById("reading")!;
const includeText = document.getElementById("includeText") as HTMLInputElement;
const wordCount = document.getElementById("words")!;
let generation = 0;

/** A paragraph of the text: blank lines part them, as in CommonMark; a single line break is a
 *  line wrapped inside one (a text pasted from an e-mail or a PDF). */
interface Paragraph { text: string; words: number }
/** A paragraph as read: alone, or with the short ones beside it (the unit it is part of). */
interface Read { paragraphs: Paragraph[]; text: string; verdict: UnitVerdict | null }
let report: {reads: Read[]; whole: ScoreResult | null; model: ModelInfo | null; coverage: string} | undefined;

function paragraphsOf(text: string): Paragraph[] {
  return text.split(/\n[ \t]*\n\s*/u).map((p) => p.trim()).filter((p) => p !== "").map((p) => ({ text: p, words: countWords(p) }));
}

function clearResult(): void { report = undefined; results.hidden = true; reading.replaceChildren(); }
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
  // The paragraphs are read as a page's are: each that clears the minimum length by itself,
  // short ones of one stretch together, a short one left over with the paragraph beside it
  // (lib/plan/group.ts) — the same units, so the same verdicts, as the page would give.
  const paragraphs = paragraphsOf(text);
  const groups = groupBlocks(paragraphs.map((p) => ({ words: p.words, chars: p.text.length })), floor);
  const grouped = new Set(groups.flat());
  const units = groups.map((group, k) => ({ id: `p${k}`, text: group.map((i) => paragraphs[i]!.text).join("\n\n"), order: k }));
  let producing: ModelInfo | null = null;
  let uncounted = false;
  try {
    const windows = await readInWindows(units, async (blocks) => {
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
    const verdicts = new Map<number, UnitVerdict>();
    units.forEach((unit, k) => {
      const read = windows.get(unit.id);
      if (!read?.length) throw new Error("incomplete");
      verdicts.set(k, unitVerdict(unit.id, unit.text.length, read));
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
    const coverage = coverageLine(reads, words, text);
    report = {reads, whole, model: producing, coverage};
    await show(report);
    results.hidden = false; status.textContent = "";
  } catch { if (seq === generation) status.textContent = t("pasteFailed"); }
  finally { if (seq === generation) analyze.disabled = false; }
});

/** How much of the text was read: the paragraphs with a verdict of all of them, and why the
 *  others have none (too short to read, another language, the engine failed them). */
function coverageLine(reads: readonly Read[], words: number, text: string): string {
  const count = (test: (r: Read) => boolean): number => reads.filter(test).reduce((n, r) => n + r.paragraphs.length, 0);
  const all = count(() => true);
  const scored = count((r) => !!r.verdict && !isNoVerdict(band(r.verdict.result)));
  const parts = [t("pasteCoverageRead", scored, all)];
  const short = count((r) => !r.verdict);
  const foreign = count((r) => !!r.verdict?.result.unsupported);
  const failed = count((r) => !!r.verdict?.result.degraded);
  if (short) parts.push(t("pasteCoverageShort", short));
  if (foreign) parts.push(t("pasteCoverageForeign", foreign));
  if (failed) parts.push(t("pasteCoverageFailed", failed));
  if (shortTextNote(words)) parts.push(shortTextNote(words).trim());
  if (hasLookalikes(text)) parts.push(t("coverageLookalikes").trim());
  return parts.join(", ");
}

/** The class carrying a verdict's colour (--c), or none where there is no verdict. */
function colourOf(r: ScoreResult): string {
  return isNoVerdict(band(r)) ? "" : `b${levelOf(r.score)}`;
}
/** A verdict's chip, its readout as its name. */
function chipOf(r: ScoreResult): HTMLElement {
  const chip = document.createElement("span"); chip.className = `chip ${colourOf(r)}`;
  chip.textContent = formatScore(r.score);
  chip.title = readout(r);
  chip.setAttribute("role", "img"); chip.setAttribute("aria-label", readout(r));
  return chip;
}

async function show({reads, whole, coverage}: NonNullable<typeof report>): Promise<void> {
  const [flagFrom, underlines, scope] = await Promise.all([
    settings.flagFrom.getValue().then(flagFromOf).catch((): FlagFrom => "heavy"),
    settings.showHighlights.getValue().catch(() => true),
    settings.underlineScope.getValue().catch(() => "flagged" as const),
  ]);
  showWhole(whole, reads);
  document.getElementById("coverage")!.textContent = coverage;
  // The text as it was given, a chip after each paragraph read; flagged ones underlined in
  // their word's colour, as on a page (Settings, Flag and Underlines).
  reading.replaceChildren(...reads.map((read) => {
    const block = document.createElement("div");
    block.className = "read";
    const r = read.verdict?.result;
    if (!r || isNoVerdict(band(r))) block.classList.add("unread");
    else {
      block.classList.add(colourOf(r));
      if (underlines && (scope === "all" || isFlagged(r, flagFrom))) block.classList.add("marked");
    }
    read.paragraphs.forEach((paragraph, i) => {
      const p = document.createElement("p");
      p.textContent = paragraph.text;
      if (r && i === read.paragraphs.length - 1) {
        p.append(" ");
        if (isNoVerdict(band(r))) {
          const word = document.createElement("span"); word.className = "note"; word.textContent = bandLabel(band(r));
          p.append(word);
        } else {
          p.append(chipOf(r));
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

/** The whole text's verdict, its word and score, and how much of the text read as each word:
 *  the share of the words in paragraphs of each word, as the toolbar menu shows a page's. */
function showWhole(r: ScoreResult | null, reads: readonly Read[]): void {
  document.getElementById("summary")!.textContent = r ? bandLabel(band(r)) : t("pasteNothingRead");
  const score = document.getElementById("score")!;
  score.className = r ? `chip ${colourOf(r)}` : "chip";
  score.textContent = r ? formatScore(r.score) : "";
  const shares = [0, 0, 0, 0];
  for (const read of reads) {
    const v = read.verdict?.result;
    if (!v || isNoVerdict(band(v))) continue;
    shares[levelOf(v.score)]! += read.paragraphs.reduce((n, p) => n + p.words, 0);
  }
  const total = shares.reduce((a, b) => a + b, 0);
  const mix = document.getElementById("mix")!, legend = document.getElementById("legend")!;
  mix.hidden = legend.hidden = total === 0;
  mix.replaceChildren(...shares.map((n, i) => {
    const part = document.createElement("span"); part.className = `b${i}`; part.style.flex = String(n);
    return part;
  }));
  legend.replaceChildren(...shares.map((n, i) => {
    const row = document.createElement("li"); row.className = `b${i}`;
    const dot = document.createElement("span"); dot.className = "dot";
    const label = document.createElement("span"); label.className = "lbl"; label.textContent = bandLabel(BUCKET_BANDS[i]!);
    const share = document.createElement("span"); share.className = "n"; share.textContent = `${total ? Math.round((n / total) * 100) : 0}%`;
    row.append(dot, label, share);
    return row;
  }));
}

document.getElementById("copy")!.addEventListener("click", async () => {
  if (!report) return;
  const lines = [t("reportPrivateTitle"), `Anagram ${browser.runtime.getManifest().version}, contract ${CONTRACT_VERSION}`, report.coverage, t("reportCaveat"), t("reportEstimate")];
  if (report.model) lines.push(JSON.stringify(report.model));
  if (report.whole) lines.push(readout(report.whole));
  report.reads.forEach((read, index) => {
    const r = read.verdict?.result;
    lines.push(`${index + 1}. ${r ? readout(r) : t("pasteTooShortToRead")}${r?.truncated ? `, ${t("reportUnread")}` : ""}${read.paragraphs.length > 1 ? ` (×${read.paragraphs.length})` : ""}`);
    if (includeText.checked) lines.push(read.text);
  });
  try { await navigator.clipboard.writeText(lines.join("\n\n")); status.textContent = t("copied"); }
  catch { status.textContent = t("reportCopyFailed"); }
});
countShown();
