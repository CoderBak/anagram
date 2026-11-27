// entrypoints/stats/main.ts — the reading statistics page.
//
// Everything on it is read straight from the extension's own IndexedDB (lib/stats/store.ts),
// which this page, as an extension page, may open; nothing is asked of a server, and the
// export is a file this page hands the browser to save. The numbers are lib/stats/summary.ts's,
// under the lens chosen in "How it counts" (lib/stats/lens.ts): the totals Anagram kept, or,
// counted another way, the paragraphs it kept. The colours are the chips' own
// (lib/render/scale.ts). Every chart has its numbers beside it in text.
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { localizePage } from "../../lib/ui/localize";
import { messageLocale, t, type MessageKey } from "../../lib/i18n";
import { ACTIONS } from "../../lib/messaging/protocol";
import { bandLabel, BUCKET_BANDS, type Band } from "../../lib/render/band";
import { adoptBandColorRules } from "../../lib/render/scale";
import { settings } from "../../lib/settings/settings";
import { addDays, datesBetween, localDate, monthRange, bandOf, viewedWords, type PageKind, type Tally, type TotalRow, type UiEvent, type EventChunk, type UnitRow, type VisitRow } from "../../lib/stats/model";
import { placeLadder } from "../../lib/stats/coarsen";
import { configOf, DIMENSION_IDS, normalize, presetConfig, presetOf, PRESET_IDS, rank, retained, type Hashable, type Layers, type Preset, type RecordingConfig } from "../../lib/stats/config";
import { openStatsStore, type LogRange } from "../../lib/stats/store";
import { summarize, type Row } from "../../lib/stats/summary";
import { DEFAULT_LENS, headlineOf, isDefaultLens, needsParagraphs, sharesUnder, verdictBands, verdictDenominator, type Lens } from "../../lib/stats/lens";
import { buildExport, exportCsvFiles, exportJson, exportPlaceLinks, preview, type ExportFile } from "../../lib/stats/export";
import { zip } from "../../lib/stats/zip";
import { hmac } from "../../lib/stats/hash";
import { layerTable, presetHint, presetLabel, warningsOf } from "../../lib/stats/ui";
import { clearStatistics, readStatsConfig, saveStatsConfig, statsSecret } from "../../lib/stats/settings";
import { formatShare as percent, formatWords as words } from "../../lib/stats/format";

localizePage();
followSystemTheme();
{
  adoptBandColorRules();
}

const store = openStatsStore();
const locale = messageLocale();
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const noteUi = (kind: UiEvent): void => void browser.runtime.sendMessage({ action: ACTIONS.STATS_UI, kind }).catch(() => undefined);
noteUi("statsPage");

/** Sites listed by name, the rest counted; pages and visits listed, the rest in the export. */
const TOP_SITES = 10;
const MOST_ROWS = 200;

const KIND_KEY: Record<PageKind, MessageKey> = {
  feed: "statsKindFeed", article: "statsKindArticle", forum: "statsKindForum", document: "statsKindDocument", other: "statsKindOther",
};

// ---- numbers, dates, words ------------------------------------------------------------------

const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
const compact = new Intl.NumberFormat(locale, { notation: "compact", maximumFractionDigits: 1 });
const dateOf = (date: string): Date => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 12);
};
const dayFormat = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" });
const shortDay = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric" });
const timeFormat = new Intl.DateTimeFormat(locale, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
const monthFormat = new Intl.DateTimeFormat(locale, { year: "numeric", month: "long" });
function rangeText(from: string, to: string): string {
  return from === to ? dayFormat.format(dateOf(from)) : dayFormat.formatRange(dateOf(from), dateOf(to));
}
function duration(seconds: number): string {
  const unit = (n: number, u: string): string => new Intl.NumberFormat(locale, { style: "unit", unit: u, unitDisplay: "short", maximumFractionDigits: 1 }).format(n);
  if (seconds < 60) return unit(seconds, "second");
  if (seconds < 3600) return unit(Math.round(seconds / 60), "minute");
  return unit(Math.round(seconds / 360) / 10, "hour");
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Labels carry the value. The bar gives a visual comparison. */
function meter(share: number | null, className: string): HTMLElement {
  const track = el("span", className);
  track.setAttribute("aria-hidden", "true");
  const fill = el("i");
  fill.style.width = `${Math.min(1, Math.max(0, share ?? 0)) * 100}%`;
  track.append(fill);
  return track;
}

// ---- the lens ---------------------------------------------------------------------------------

let lens: Lens = { ...DEFAULT_LENS };
let displayedWeight: Lens["weight"] = "words";
const decimal = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
const quantity = (n: number, weight = displayedWeight): string => weight === "time" ? decimal.format(n) : words(n);
const weightColumn = (): MessageKey => displayedWeight === "words" ? "statsColWords" : displayedWeight === "paragraphs" ? "statsColParagraphs" : "statsColSeconds";
function amount(n: number, weight = displayedWeight): string {
  const unit = weight === "words" ? (n === 1 ? "statsOneWord" : "statsManyWords")
    : weight === "paragraphs" ? (n === 1 ? "statsOneParagraph" : "statsManyParagraphs")
    : (n === 1 ? "statsOneSecond" : "statsManySeconds");
  return t(unit, quantity(n, weight));
}
const shareWeight = (): Lens["weight"] => lens.estimator === "expected" ? displayedWeight : "paragraphs";
const scoredTitle = (weight: Lens["weight"]): MessageKey =>
  weight === "words" ? "statsKpiScored" : weight === "time" ? "statsScoredSeconds" : "statsScoredParagraphs";
const headlineCopy = {
  ai: { option: "statsLensAi", expected: "statsHeroLine", paragraphs: "statsHeroParagraphsAi", column: "statsColAi", top: "statsKpiTop" },
  assistedAndAi: { option: "statsLensAssistedAi", expected: "statsHeroLineAssisted", paragraphs: "statsHeroParagraphsAssisted", column: "statsColAssistedAi", top: "statsTopAssisted" },
  heavyAndAi: { option: "statsLensHeavyAi", expected: "statsHeroLineHeavy", paragraphs: "statsHeroParagraphsHeavy", column: "statsColHeavyAi", top: "statsTopHeavy" },
} as const satisfies Record<Lens["headline"], Record<"option" | "expected" | "paragraphs" | "column" | "top", MessageKey>>;
const LENS_KEY = "statsLens";
try { lens = { ...DEFAULT_LENS, ...JSON.parse(sessionStorage.getItem(LENS_KEY) ?? "{}") }; } catch { /* the default */ }
const lensSelects: { id: string; field: keyof Lens; options: [string | number, MessageKey, ...(string | number)[]][] }[] = [
  { id: "lensRead", field: "readMs", options: [[250, "statsSeconds", 0.25], [500, "statsSeconds", 0.5], [1000, "statsSeconds", 1], [2000, "statsSeconds", 2], [5000, "statsSeconds", 5], [10_000, "statsSeconds", 10], [30_000, "statsSeconds", 30]] },
  { id: "lensVisible", field: "visibility", options: [["band", "statsLensBand"], ["half", "statsLensHalf"], ["any", "statsLensAny"]] },
  { id: "lensOnce", field: "once", options: [["visit", "statsLensOnceVisit"], ["day", "statsLensOnceDay"], ["ever", "statsLensOnceEver"]] },
  { id: "lensEstimator", field: "estimator", options: [["expected", "statsLensExpected"], ["chip", "statsLensChip"], ["argmax", "statsLensArgmax"]] },
  { id: "lensWeight", field: "weight", options: [["words", "statsLensWords"], ["paragraphs", "statsLensParagraphs"], ["time", "statsLensTime"]] },
  { id: "lensHeadline", field: "headline", options: [] },
  { id: "lensMinWords", field: "minWords", options: [[50, "statsWordsN", 50], [75, "statsWordsN", 75], [100, "statsWordsN", 100], [150, "statsWordsN", 150]] },
];
for (const { id, field, options } of lensSelects) {
  const select = $<HTMLSelectElement>(id);
  for (const [value, key, ...subs] of options) select.add(new Option(t(key, ...(subs.map(String) as [])), String(value)));
  select.addEventListener("change", () => {
    const v = select.value;
    (lens as unknown as Record<string, unknown>)[field] = typeof DEFAULT_LENS[field] === "number" ? Number(v) : v;
    lensChanged();
  });
}
$<HTMLInputElement>("lensFocused").addEventListener("change", (e) => { lens.focusedOnly = (e.target as HTMLInputElement).checked; lensChanged(); });
$<HTMLInputElement>("lensFling").addEventListener("change", (e) => { lens.excludeFling = (e.target as HTMLInputElement).checked; lensChanged(); });
$("lensReset").addEventListener("click", () => { lens = { ...DEFAULT_LENS }; lensChanged(); });
function showLens(): void {
  for (const { id, field } of lensSelects) $<HTMLSelectElement>(id).value = String(lens[field]);
  $<HTMLInputElement>("lensFocused").checked = lens.focusedOnly;
  $<HTMLInputElement>("lensFling").checked = lens.excludeFling;
}
function saveLens(): void {
  try { sessionStorage.setItem(LENS_KEY, JSON.stringify(lens)); } catch { /* not kept */ }
}
function lensChanged(): void {
  saveLens();
  showLens();
  void render();
}
showLens();

// ---- the period ---------------------------------------------------------------------------

type Period = { kind: "today" } | { kind: "days"; days: 7 | 30 } | { kind: "month"; month: string } | { kind: "range"; from: string; to: string };
let period: Period = location.hash === "#today" ? { kind: "today" } : { kind: "days", days: 7 };

let previousRange: { period: Period; tableDay?: string } | null = null;

function bounds(p: Period, today: string): { from: string; to: string } {
  if (p.kind === "today") return { from: today, to: today };
  if (p.kind === "days") return { from: addDays(today, 1 - p.days), to: today };
  if (p.kind === "range") return { from: p.from, to: p.to };
  const { from, to } = monthRange(p.month);
  return { from, to: to > today ? today : to };
}

const presets = [...document.querySelectorAll<HTMLButtonElement>("#ranges > button")];
const monthEl = $<HTMLSelectElement>("month");
const fromEl = $<HTMLInputElement>("rangeFrom"), toEl = $<HTMLInputElement>("rangeTo");
function showPeriod(): void {
  const key = period.kind === "today" ? "today" : period.kind === "days" ? String(period.days) : "";
  for (const button of presets) button.setAttribute("aria-pressed", String(button.dataset.range === key));
  $("returnRange").hidden = previousRange === null;
}
presets.forEach((button, i) => {
  button.addEventListener("click", () => {
    previousRange = null;
    const range = button.dataset.range;
    period = range === "today" ? { kind: "today" } : { kind: "days", days: range === "7" ? 7 : 30 };
    void render();
  });
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const next = presets[(i + (event.key === "ArrowRight" ? 1 : presets.length - 1)) % presets.length]!;
    next.focus();
    next.click();
  });
});
$("returnRange").addEventListener("click", () => {
  if (!previousRange) return;
  const { period: range, tableDay } = previousRange;
  period = range;
  previousRange = null;
  void render().then(() => {
    if (document.activeElement !== document.body && document.activeElement !== $("returnRange")) return;
    const day = tableDay && $("trendTable").querySelector<HTMLButtonElement>(`button[value="${CSS.escape(tableDay)}"]`);
    if (day && day.getClientRects().length) { day.focus(); return; }
    const current = presets.find((button) => button.getAttribute("aria-pressed") === "true");
    (current ?? more.querySelector("summary")!).focus();
  });
});
// The date picker closes on a selection, a click elsewhere or Escape.
const more = $<HTMLDetailsElement>("more");
const closeMore = (): void => { more.open = false; };
document.addEventListener("click", (e) => { if (more.open && !more.contains(e.target as Node)) closeMore(); });
more.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !more.open) return;
  closeMore();
  more.querySelector("summary")!.focus();
});
// Initialize before the disclosure opens, so a deferred toggle cannot overwrite a date being edited.
more.querySelector("summary")!.addEventListener("click", () => {
  if (more.open) return;
  const { from, to } = bounds(period, localDate());
  fromEl.value = from < fromEl.min ? fromEl.min : from;
  toEl.value = to;
  monthEl.value = period.kind === "month" ? period.month : "";
});
monthEl.addEventListener("change", () => {
  previousRange = null;
  period = monthEl.value ? { kind: "month", month: monthEl.value } : { kind: "today" };
  closeMore();
  more.querySelector("summary")!.focus();
  void render();
});
$("rangeForm").addEventListener("submit", (event) => {
  event.preventDefault();
  previousRange = null;
  const [from, to] = [fromEl.value, toEl.value].sort() as [string, string];
  period = { kind: "range", from, to };
  closeMore();
  more.querySelector("summary")!.focus();
  void render();
});

/** The months there is anything for, newest first, as the picker's choices. */
function fillMonths(today: string, first: string): void {
  const keep = monthEl.value;
  for (const option of [...monthEl.options].slice(1)) option.remove();
  for (let month = today.slice(0, 7); month >= first.slice(0, 7); ) {
    monthEl.add(new Option(monthFormat.format(dateOf(`${month}-01`)), month));
    const [y, m] = month.split("-").map(Number) as [number, number];
    month = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
  }
  monthEl.value = keep;
  fromEl.min = toEl.min = first;
  fromEl.max = toEl.max = today;
}

// ---- the sections ----------------------------------------------------------------------------

interface StatsSeries { band: Band; slot: number; color: number }

function statsBands(tallies: Tally[]): StatsSeries[] {
  const hasAssistedSlot = (tally: Tally) => tally.expected.length > 4 || tally.units.length > 4 || (tally.argmax?.length ?? 0) > 4;
  const current = tallies.some(hasAssistedSlot);
  const legacy = tallies.some(tally => (tally.scored > 0 && !tally.missingProbabilities && !hasAssistedSlot(tally)) ||
    [tally.expected, tally.units, tally.argmax].some(values => values?.[1] || values?.[2]));
  const slots = current ? (legacy ? [0, 1, 2, 4, 3] : [0, 4, 3]) : [0, 1, 2, 3];
  return slots.map(slot => ({
    band: slot === 4 ? "assisted" : BUCKET_BANDS[slot]!,
    slot,
    // The current detector uses amber for AI-assisted. Distinguish the legacy light-edit series
    // when both occur in a range, including on individual days that used only one detector.
    color: slot === 4 ? 1 : slot === 1 && current ? 4 : slot,
  }));
}
function showHeadlineChoices(series: StatsSeries[]): void {
  const choices: Lens["headline"][] = ["ai"];
  if (series.some(({band}) => band === "assisted")) choices.push("assistedAndAi");
  if (series.some(({band}) => band === "heavy")) choices.push("heavyAndAi");
  const select = $<HTMLSelectElement>("lensHeadline");
  if (select.length !== choices.length || choices.some((value, i) => select.options[i]?.value !== value)) {
    select.replaceChildren(...choices.map(value => new Option(t(headlineCopy[value].option), value)));
  }
  if (!choices.includes(lens.headline)) {
    lens.headline = "ai";
    saveLens();
  }
  select.value = lens.headline;
}
function headline(total: Tally, compare: string, series: StatsSeries[]): void {
  const share = headlineOf(total, lens);
  $("heroShare").textContent = share === null ? t("statsHeroNone") : percent(share);
  const copy = headlineCopy[lens.headline];
  $("heroLine").textContent = t(lens.estimator === "expected" ? copy.expected : copy.paragraphs);
  const legend = $("heroLegend");
  const s = sharesUnder(total, lens);
  legend.hidden = s === null;
  legend.replaceChildren(...series.map(({band, slot, color}) => {
    const item = el("li", `b${color}`);
    const value = s ? s[slot] ?? 0 : null;
    item.append(el("span", "lbl", bandLabel(band)), meter(value, "track"), el("span", "n", percent(value)));
    return item;
  }));
  $("heroCompare").textContent = compare;
}

/** A table whose rows each carry their numbers, and under each row's name its bar. With `pick`,
 *  a row is a way into the page filtered to it (Enter or a click), the picked one marked. */
function bandTable(head: MessageKey, rows: { label: string; tally: Tally; key?: string }[], pick?: (key: string) => void, picked?: string | null): HTMLTableElement {
  const table = el("table", "table");
  const tr = table.createTHead().insertRow();
  tr.append(el("th", undefined, t(head)), el("th", "num", t(weightColumn())), el("th", "num", t(headlineCopy[lens.headline].column)));
  const largest = rows.reduce((high, row) => Math.max(high, viewedWords(row.tally)), 0);
  const body = table.createTBody();
  for (const row of rows) {
    const r = body.insertRow();
    const label = r.insertCell();
    label.className = "name";
    if (pick && row.key !== undefined) {
      const key = row.key;
      const button = el("button", "linkish site-pick", row.label);
      button.type = "button";
      button.value = key;
      button.setAttribute("aria-pressed", String(picked === key));
      label.append(button);
      r.className = "pick";
      if (picked === key) r.setAttribute("aria-current", "true");
      r.addEventListener("click", () => pick(key));
    } else {
      label.textContent = row.label;
    }
    const volume = viewedWords(row.tally);
    const cell = r.insertCell();
    cell.className = "num volume";
    const value = el("span", "volume-value");
    value.append(meter(largest ? volume / largest : 0, "volume-track"), el("span", undefined, quantity(volume)));
    cell.append(value);
    Object.assign(r.insertCell(), { className: "num", textContent: percent(headlineOf(row.tally, lens)) });
  }
  return table;
}

function empty(host: HTMLElement, key: MessageKey): void {
  host.replaceChildren(el("p", "empty", t(key)));
}

function selectDay(date: string, fromTable = false): void {
  previousRange = { period, tableDay: fromTable ? date : undefined };
  period = { kind: "range", from: date, to: date };
  $("trendTip").hidden = true;
  void render().then(() => {
    const focused = document.activeElement;
    const hiddenDay = $("trendCard").contains(focused) && focused?.closest("[hidden]");
    if (focused === document.body || hiddenDay) $("returnRange").focus();
  });
}

let shareChart = false;
for (const button of [$("trendVolume"), $("trendShare")]) {
  button.addEventListener("click", () => {
    shareChart = button.id === "trendShare";
    $("trendVolume").setAttribute("aria-pressed", String(!shareChart));
    $("trendShare").setAttribute("aria-pressed", String(shareChart));
    $("trendTip").hidden = true;
    if (shown) trendChart(shown.trend, shown.from, shown.to, shown.series);
  });
}

/** The trend: a column a day, its four words stacked; each column says its numbers when
 *  pointed at, and the table under it says them all. */
function trendChart(days: { date: string; tally: Tally }[], from: string, to: string, series: StatsSeries[]): void {
  const host = $("trendChart");
  const W = Math.max(300, Math.round(host.clientWidth || 720)), H = 148, left = 38, right = 8, top = 8, bottom = 24;
  const plotW = W - left - right, plotH = H - top - bottom;
  const most = days.reduce((high, d) => Math.max(high, verdictDenominator(d.tally, lens)), 0);
  const step = shareChart ? 0.5 : niceStep(most / 2);
  const max = Math.max(step * 2, 1);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("class", "trend");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", shareChart ? t("statsTrendShareAria", rangeText(from, to))
    : t("statsTrendAria", rangeText(from, to), t(scoredTitle(shareWeight()))));
  const add = (parent: Element, tag: string, attrs: Record<string, string | number>, text?: string): SVGElement => {
    const node = document.createElementNS(ns, tag);
    for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
    if (text !== undefined) node.textContent = text;
    parent.append(node);
    return node;
  };
  for (const tick of [0, step, step * 2]) {
    const y = top + plotH - (tick / max) * plotH;
    add(svg, "line", { class: "rule", x1: left, x2: W - right, y1: y, y2: y });
    add(svg, "text", { x: left - 6, y: y + 4, "text-anchor": "end" }, shareChart ? percent(tick) : compact.format(tick));
  }
  const slot = plotW / days.length;
  const colW = Math.min(40, slot, Math.max(2, slot * 0.55));
  days.forEach((d, i) => {
    const x = left + slot * i + (slot - colW) / 2;
    const col = add(svg, "g", { class: "col" });
    col.addEventListener("mouseenter", (e) => showTip(e as MouseEvent, d, series));
    col.addEventListener("mousemove", (e) => moveTip(e as MouseEvent));
    col.addEventListener("mouseleave", () => { $("trendTip").hidden = true; });
    // A day is a way in: the page for that day alone.
    col.addEventListener("click", () => selectDay(d.date));
    let y = top + plotH;
    const bands = shareChart ? sharesUnder(d.tally, lens) : verdictDenominator(d.tally, lens) > 0 ? verdictBands(d.tally, lens) : null;
    for (const {slot, color} of series) {
      const value = bands?.[slot] ?? 0;
      if (value <= 0) continue;
      const height = (value / max) * plotH;
      y -= height;
      add(col, "rect", { class: `seg b${color}`, x, y, width: colW, height });
    }
    add(col, "rect", { class: "hit", x: left + slot * i, y: top, width: slot, height: plotH });
  });
  // Measure the actual localized labels while the SVG is laid out. Place the last date
  // first so it stays visible even when the preceding tick would collide with it.
  host.replaceChildren(svg);
  const tickCount = Math.min(8, days.length);
  let nextLeft = W + 4;
  for (let tick = tickCount - 1; tick >= 0; tick--) {
    const i = Math.round(tick * (days.length - 1) / Math.max(1, tickCount - 1));
    const label = add(svg, "text", { y: H - 6, "text-anchor": "middle" }, shortDay.format(dateOf(days[i]!.date))) as SVGTextElement;
    const half = label.getComputedTextLength() / 2;
    const center = Math.min(W - half, Math.max(half, left + (i + 0.5) * slot));
    if (center + half + 4 > nextLeft) { label.remove(); continue; }
    label.setAttribute("x", String(center));
    nextLeft = center - half;
  }

}
function trendTable(days: { date: string; tally: Tally }[], series: StatsSeries[]): void {
  const table = el("table", "table");
  const head = table.createTHead().insertRow();
  for (const [text, cls] of [[t("statsColDate"), ""], [t(weightColumn()), "num"], [t("statsColScored"), "num"],
    ...series.map(({band}) => [bandLabel(band), "num"])] as [string, string][]) head.append(el("th", cls || undefined, text));
  const body = table.createTBody();
  for (const d of days) {
    const r = body.insertRow();
    const button = el("button", "linkish", dayFormat.format(dateOf(d.date)));
    button.type = "button";
    button.value = d.date;
    button.addEventListener("click", () => selectDay(d.date, true));
    r.insertCell().append(button);
    Object.assign(r.insertCell(), { className: "num", textContent: quantity(viewedWords(d.tally)) });
    Object.assign(r.insertCell(), { className: "num", textContent: quantity(d.tally.scored) });
    const s = sharesUnder(d.tally, lens);
    for (const {slot} of series) Object.assign(r.insertCell(), { className: "num", textContent: percent(s ? s[slot] ?? 0 : null) });
  }
  $("trendTable").replaceChildren(table);
}

/** The pointed-at day's numbers beside the pointer, inside its panel. */
function showTip(e: MouseEvent, d: { date: string; tally: Tally }, series: StatsSeries[]): void {
  const tip = $("trendTip");
  const s = sharesUnder(d.tally, lens);
  tip.replaceChildren(el("strong", undefined, dayFormat.format(dateOf(d.date))));
  if (!s) tip.append(el("span", undefined, t("statsNoVerdicts")));
  else tip.append(
    el("span", undefined, t("statsTrendTip", amount(verdictDenominator(d.tally, lens), shareWeight()), percent(headlineOf(d.tally, lens)), t(headlineCopy[lens.headline].column))),
    ...series.map(({band, slot, color}) => {
      const line = el("span", `tip-line b${color}`);
      line.append(el("span", "dot"), ` ${bandLabel(band)} ${percent(s[slot] ?? 0)}`);
      return line;
    }));
  tip.hidden = false;
  moveTip(e);
}
function moveTip(e: MouseEvent): void {
  const tip = $("trendTip"), card = $("trendCard").getBoundingClientRect();
  const x = Math.min(e.clientX - card.left + 12, card.width - tip.offsetWidth - 8);
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${e.clientY - card.top + 12}px`;
}

/** 1, 2 or 5 times a power of ten: the gridlines' step. */
function niceStep(x: number): number {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  return ([1, 2, 5, 10].find((m) => m * p >= x) ?? 10) * p;
}

function coverage(total: Tally): void {
  const viewed = viewedWords(total);
  $("scoringDetails").hidden = viewed === 0;
  $("coverageLine").textContent = viewed > 0 ? t("statsCoverageLine", quantity(total.scored), amount(viewed), percent(total.scored / viewed)) : "";
  const parts: [number, MessageKey][] = [
    [total.short, "statsCovShort"], [total.language, "statsCovLanguage"], [total.unavailable, "statsCovUnavailable"], [total.removed, "statsCovRemoved"],
  ];
  $("coverageList").replaceChildren(...parts.filter(([n]) => n > 0).map(([n, key]) =>
    el("li", undefined, t(key, amount(n)))));
}

function appendPageName(cell: HTMLTableCellElement, url: string | undefined, name: string): void {
  cell.className = "name";
  if (!url || !/^https?:\/\//.test(url)) { cell.textContent = name; return; }
  const link = el("a", undefined, name);
  link.href = url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = url;
  cell.append(link);
  if (siteFilter === null && name !== url && name !== link.host) cell.append(el("span", "page-host", link.host));
}

function historyTable(withReplay = false): HTMLTableElement {
  const table = el("table", "table history-table");
  const head = table.createTHead().insertRow();
  const columns: MessageKey[] = ["statsColOpened", "statsColPage", weightColumn(),
    headlineCopy[lens.headline].column, "statsColShown"];
  if (withReplay) columns.push("statsColReplay");
  columns.forEach((key, i) => {
    const th = el("th", i >= 2 && i <= 4 ? "num" : undefined, t(key));
    th.scope = "col";
    if (key === "statsColReplay") th.replaceChildren(el("span", "vh", t(key)));
    head.append(th);
  });
  return table;
}

function appendHistoryMeasures(row: HTMLTableRowElement, tally: Tally, seconds: number | undefined): void {
  const values: [MessageKey, string][] = [
    [weightColumn(), quantity(viewedWords(tally))],
    [headlineCopy[lens.headline].column, percent(headlineOf(tally, lens))],
    ["statsColShown", seconds ? duration(seconds) : "–"],
  ];
  for (const [key, value] of values) {
    const cell = row.insertCell();
    cell.className = "num";
    const label = el("span", "mobile-label", t(key));
    label.setAttribute("aria-hidden", "true");
    cell.append(label, el("span", "cell-value", value));
  }
}

function pagesTable(pages: Row[]): void {
  const host = $("pagesTable");
  if (pages.length === 0) { empty(host, "statsNoPages"); $("pagesMore").textContent = ""; return; }
  const table = historyTable();
  const body = table.createTBody();
  for (const p of pages.slice(0, MOST_ROWS)) {
    const r = body.insertRow();
    const [date, minute] = (p.start ?? "").split(" ");
    r.insertCell().textContent = date ? `${shortDay.format(dateOf(date))} ${minute ?? ""}`.trim() : "";
    appendPageName(r.insertCell(), p.url, p.title || p.url || t("statsLocalFile"));
    appendHistoryMeasures(r, p.tally, p.dwell);
  }
  host.replaceChildren(table);
  $("pagesMore").textContent = pages.length > MOST_ROWS ? t("statsMorePages", words(MOST_ROWS), words(pages.length)) : "";
}

const visitPanel = $("replay");
const timeline = $<HTMLDetailsElement>("visitTimeline");
interface SelectedVisit { visit: VisitRow; button: HTMLButtonElement; row: HTMLTableRowElement; units: UnitRow[] }
let selectedVisit: SelectedVisit | undefined;

function closeVisit(): void {
  if (!selectedVisit) return;
  selectedVisit.button.setAttribute("aria-expanded", "false");
  visitPanel.hidden = true;
  timeline.open = false;
  timeline.hidden = true;
  $("visitsCard").append(visitPanel);
  selectedVisit.row.remove();
  selectedVisit = undefined;
  $("replayTitle").textContent = $("timelineKey").textContent = $("visitStatus").textContent = "";
  $("visitFacts").replaceChildren();
  $("replayChart").replaceChildren();
}

function visitsTable(visits: Row[]): void {
  const openId = selectedVisit?.visit.id;
  const wasExpanded = timeline.open;
  closeVisit();
  const host = $("visitsTable");
  if (visits.length === 0) { empty(host, "statsNoVisits"); $("visitsMore").textContent = ""; return; }
  const table = historyTable(true);
  const body = table.createTBody();
  host.replaceChildren(table);
  for (const row of visits.slice(0, MOST_ROWS)) {
    const v = row.visit!;
    const r = body.insertRow();
    r.insertCell().textContent = timeFormat.format(new Date(v.start));
    appendPageName(r.insertCell(), v.url, v.title || v.url || v.site || t(KIND_KEY[v.kind]));
    appendHistoryMeasures(r, row.tally, Math.round(v.shown / 1000));
    const action = r.insertCell();
    action.className = "replay-action";
    const button = el("button", "linkish disclosure-action");
    button.append(el("span", "", t("statsReplay")));
    button.type = "button";
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", visitPanel.id);
    button.addEventListener("click", () => {
      if (selectedVisit?.button === button) closeVisit();
      else void openVisit(v, r, button);
    });
    action.append(button);
    if (v.id === openId) void openVisit(v, r, button, wasExpanded);
  }
  $("visitsMore").textContent = visits.length > MOST_ROWS ? t("statsMoreVisits", words(MOST_ROWS), words(visits.length)) : "";
}

function showVisitFacts(v: VisitRow, units: UnitRow[]): void {
  const facts = $("visitFacts");
  facts.replaceChildren();
  function fact(key: MessageKey, value: string): void {
    const pair = el("div");
    pair.append(el("dt", undefined, t(key)), el("dd", undefined, value));
    facts.append(pair);
  }
  // Zero is also the recorder's initial value before any page scroll.
  if (v.scroll && v.scroll.depth > 0) {
    const depth = new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(Math.min(1, v.scroll.depth));
    fact("statsVisitDepth", t("statsVisitDepthValue", depth));
  }
  // Read-only exposure rows can retain the read decision while dropping the sighting count.
  const sightingsKnown = units.length > 0 && units.every(({expo}) => expo && (expo.sightings > 0 || (expo.read === undefined && expo.readAt === undefined)));
  if (sightingsKnown && units.some(unit => unit.expo!.sightings > 0)) {
    fact("statsVisitVisible", words(units.filter(unit => unit.expo!.sightings > 0).length));
    fact("statsVisitReturned", words(units.filter(unit => unit.expo!.sightings > 1).length));
  }
}

async function openVisit(visit: VisitRow, anchor: HTMLTableRowElement, button: HTMLButtonElement, expand = false): Promise<void> {
  closeVisit();
  const row = el("tr", "visit-details-row");
  const cell = row.insertCell();
  cell.colSpan = anchor.cells.length;
  anchor.after(row);
  cell.append(visitPanel);
  const selection: SelectedVisit = {visit, button, row, units: []};
  selectedVisit = selection;
  button.setAttribute("aria-expanded", "true");
  $("replayTitle").textContent = t("statsReplayTitle", timeFormat.format(new Date(visit.start)), visit.title || visit.url || visit.site || t(KIND_KEY[visit.kind]));
  $("visitStatus").textContent = t("readerLoading");
  visitPanel.hidden = false;
  try {
    const [units, hasEvents] = await Promise.all([store.unitsOf(visit.id), store.hasEvents(visit.id)]);
    if (selectedVisit !== selection) return;
    selection.units = units;
    showVisitFacts(visit, units);
    $("visitStatus").textContent = !$("visitFacts").childElementCount && !hasEvents ? t("statsVisitNoFacts") : "";
    timeline.hidden = !hasEvents;
    timeline.open = hasEvents && expand;
  } catch {
    if (selectedVisit === selection) $("visitStatus").textContent = t("statsVisitLoadFailed");
  }
}

timeline.addEventListener("toggle", async () => {
  const selection = selectedVisit;
  if (!timeline.open || !selection || $("replayChart").querySelector("svg")) return;
  $("replayChart").textContent = t("readerLoading");
  try {
    const events = await store.events([selection.visit.id]);
    if (selection === selectedVisit && timeline.open) drawTimeline(selection.visit, selection.units, events);
  } catch {
    if (selection === selectedVisit) $("replayChart").textContent = t("statsVisitLoadFailed");
  }
});

/** Each lane shows when a passage was in view. The optional line follows main-page scrolling. */
function drawTimeline(v: VisitRow, units: UnitRow[], events: EventChunk[]): void {
  const spells: { n: number; start: number; end: number }[] = [];
  const scroll: { t: number; y: number; ph: number; vh: number }[] = [];
  const hasIntervals = events.some(chunk => chunk.streams.intervals?.kind.includes(0));
  const open = new Map<number, number>();
  for (const chunk of events) {
    const iv = chunk.streams.intervals;
    if (iv) for (let i = 0; i < iv.unit.length; i++) if (iv.kind[i] === 0) spells.push({ n: iv.unit[i]!, start: iv.start[i]!, end: iv.end[i]! });
    const st = chunk.streams.steps;
    if (st && !hasIntervals) {
      // From the steps: on screen from a step above nothing to the next at nothing.
      for (let i = 0; i < st.t.length; i++) {
        if (st.obs[i] !== 0) continue;
        const n = st.unit[i]!;
        if (st.ratio[i]! > 0 && !open.has(n)) open.set(n, st.t[i]!);
        else if (st.ratio[i] === 0 && open.has(n)) { spells.push({ n, start: open.get(n)!, end: st.t[i]! }); open.delete(n); }
      }
    }
    const sc = chunk.streams.scroll;
    if (sc) for (let i = 0; i < sc.t.length; i++) if (sc.box[i] === 0) scroll.push({ t: sc.t[i]!, y: sc.y[i]!, ph: sc.ph[i]!, vh: sc.vh[i]! });
  }
  const hasScroll = scroll.length > 1;
  if (!spells.length && !hasScroll) {
    $("replayChart").textContent = t("statsVisitNoTimeline");
    $("timelineKey").textContent = "";
    return;
  }
  $("timelineKey").textContent = [spells.length ? t("statsReplayNote") : "", hasScroll ? t("statsVisitScrollLine") : ""].filter(Boolean).join(" ");
  const byN = new Map(units.map((u) => [u.n, u]));
  const end = Math.max(1, v.end ? v.end - v.start : 0, spells.reduce((max, s) => Math.max(max, s.end), 0), scroll.reduce((max, s) => Math.max(max, s.t), 0));
  const ns = "http://www.w3.org/2000/svg";
  const rows = Math.max(1, units.reduce((max, u) => Math.max(max, u.n + 1), 0), spells.reduce((max, s) => Math.max(max, s.n + 1), 0));
  const W = Math.max(300, Math.round($("replayChart").clientWidth || 720)), laneH = Math.max(3, Math.min(10, 300 / rows)), left = 8, H = rows * laneH + 30;
  const x = (ms: number): number => left + (ms / end) * (W - left - 8);
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "replay");
  svg.setAttribute("role", "img");
  const seconds = Math.round(end / 1000);
  const clock = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  svg.setAttribute("aria-label", t("statsReplayAria", clock));
  const add = (tag: string, attrs: Record<string, string | number>, text?: string): void => {
    const node = document.createElementNS(ns, tag);
    for (const [k, val] of Object.entries(attrs)) node.setAttribute(k, String(val));
    if (text !== undefined) node.textContent = text;
    svg.append(node);
  };
  for (let n = 0; n < rows; n++) add("rect", { class: "lane", x: left, y: n * laneH, width: W - left - 8, height: Math.max(1, laneH - 1) });
  const colors = new Map(shown?.series.map(({slot, color}) => [slot, color]));
  for (const s of spells) {
    const u: UnitRow | undefined = byN.get(s.n);
    const p = u?.verdict?.p;
    const slot = u?.verdict?.band ?? (p ? bandOf(p) : undefined);
    const color = slot === undefined ? "unscored" : `b${colors.get(slot) ?? (slot === 4 ? 1 : slot)}`;
    add("rect", { class: `on ${color}`, x: x(s.start), y: s.n * laneH, width: Math.max(1, x(s.end) - x(s.start)), height: Math.max(1, laneH - 1) });
  }
  if (hasScroll) {
    const d = scroll.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)},${((s.y / Math.max(1, s.ph - s.vh)) * (rows * laneH)).toFixed(1)}`).join("");
    add("path", { class: "scroll", d });
  }
  add("text", { x: left, y: H - 6 }, "0:00");
  add("text", { x: W - 8, y: H - 6, "text-anchor": "end" }, clock);
  $("replayChart").replaceChildren(svg);

}

// Only breakdowns supported by the retained records appear in the switcher.
const recordTabs = [...document.querySelectorAll<HTMLButtonElement>("#recordTabs [role=tab]")];
let activeRecord = recordTabs[0]!;
function showRecord(tab: HTMLButtonElement): void {
  activeRecord = tab;
  for (const item of recordTabs) {
    const selected = item === tab;
    item.tabIndex = selected ? 0 : -1;
    item.setAttribute("aria-selected", String(selected));
    $(item.getAttribute("aria-controls")!).hidden = !selected;
  }
}
for (const tab of recordTabs) {
  tab.addEventListener("click", () => showRecord(tab));
  tab.addEventListener("keydown", (event) => {
    const available = recordTabs.filter((item) => !item.hidden);
    const index = available.indexOf(tab);
    let next: HTMLButtonElement;
    switch (event.key) {
      case "Home": next = available[0]!; break;
      case "End": next = available.at(-1)!; break;
      case "ArrowLeft": next = available[(index + available.length - 1) % available.length]!; break;
      case "ArrowRight": next = available[(index + 1) % available.length]!; break;
      default: return;
    }
    event.preventDefault();
    next.focus();
    showRecord(next);
  });
}
function updateRecordTabs(): void {
  const available = recordTabs.filter((tab) => !tab.hidden);
  $("records").hidden = available.length === 0;
  if (!available.length) return;
  const single = available.length === 1;
  $("recordTabs").hidden = single;
  $("recordsTitle").textContent = single ? available[0]!.textContent : t("statsRecords");
  const selected = activeRecord.hidden ? available[0]! : activeRecord;
  showRecord(selected);
  for (const item of available) $(item.getAttribute("aria-controls")!).setAttribute("aria-labelledby", single ? "recordsTitle" : item.id);
}

// ---- the whole page --------------------------------------------------------------------------

let config: RecordingConfig | null = null;
let shown: { series: StatsSeries[]; range: LogRange; from: string; to: string; trend: { date: string; tally: Tally }[] } | null = null;
let rendering = 0;
/** The site the page is narrowed to (a row of By site picked), or null. */
let siteFilter: string | null = null;

/** Whether a page's key (its address at some layer, or "file:" and its title) is on `site`. */
function onSite(page: TotalRow, site: string, sites: Set<string>, visitPages: Set<string>): boolean {
  if (page.key.startsWith("file:")) return site === "";
  if (page.siteHash !== undefined) return page.siteHash === site;
  if (page.hashed) return visitPages.has(page.key);
  const ladder = placeLadder(page.key);
  return !!ladder && (sites.has(ladder.host) ? ladder.host === site : ladder.domain === site);
}

/** What `range` holds of one site: its own totals as the day's, its pages (and their kinds), its
 *  visits and their paragraphs. */
function bySite(range: LogRange, site: string): LogRange {
  const visits = range.visits.filter((v) => v.site === site && (v.pageSite === undefined || v.pageSite === site));
  const ids = new Set(visits.map((v) => v.id));
  const totals: TotalRow[] = [];
  const siteKeys = new Map<string, Set<string>>();
  for (const t of range.totals) if (t.scope === "site") {
    const keys = siteKeys.get(t.date) ?? new Set<string>();
    keys.add(t.key); siteKeys.set(t.date, keys);
  }
  const pageKeys = new Set(visits.filter((v) => v.hashed?.includes("place") && v.url).map((v) => v.url!));
  for (const row of range.totals) {
    if (row.scope === "site" && row.key === site) totals.push({ date: row.date, scope: "day", key: "", tally: row.tally }, row);
    else if (row.scope === "page" && onSite(row, site, siteKeys.get(row.date) ?? new Set(), pageKeys)) {
      totals.push(row);
      if (row.kind) totals.push({ date: row.date, scope: "kind", key: row.kind, tally: row.tally });
    }
  }
  return { visits, units: range.units.filter((u) => ids.has(u.visit)), totals };
}
$("filterClear").addEventListener("click", () => {
  if (document.activeElement === $("filterClear")) more.querySelector("summary")!.focus();
  siteFilter = null;
  void render();
});

async function render(): Promise<void> {
  const ticket = ++rendering;
  const today = localDate();
  const { from, to } = bounds(period, today);
  const none = (): LogRange => ({ visits: [], units: [], totals: [] });
  const needUnits = needsParagraphs(lens);
  // A day is held against the thirty before it; a longer period against the one as long before it.
  const length = datesBetween(from, to).length;
  const [againstFrom, againstTo] = length === 1 ? [addDays(to, -29), to] : [addDays(from, -length), addDays(from, -1)];
  const narrow = (r: LogRange): LogRange => siteFilter === null ? r : bySite(r, siteFilter);
  const [all, recentAll, first, recording] = await Promise.all([
    store.read(from, to, { units: needUnits, byReadDate: needUnits }).catch(none),
    store.read(againstFrom, againstTo, { units: needUnits, byReadDate: needUnits }).catch(none),
    store.first().catch(() => null),
    readStatsConfig(),
  ]);
  if (ticket !== rendering) return;
  const range = narrow(all), recent = narrow(recentAll);
  config = recording;
  fillMonths(today, first ?? today);
  showPeriod();

  const preset = config.on ? presetOf(config) ?? "custom" : "off";
  // Off, the card below says so.
  $("levelLine").textContent = !config.on ? ""
    : retained(config.layers).detail ? t("statsRecordingLine", presetLabel(preset), integer.format(config.retention.detail))
    : t("statsRecordingTotals", presetLabel(preset));
  $("offCard").hidden = config.on;
  $("periodBar").hidden = $("content").hidden = !config.on && first === null;
  $("period").textContent = rangeText(from, to);
  $("filter").hidden = siteFilter === null;
  $("filterText").textContent = siteFilter === null ? "" : t("statsFilterSite", siteFilter || t("statsLocalFiles"));

  const summary = summarize(range, from, to, lens);
  // Categorical paragraph records can retain only the labels shared by both detectors.
  // The original daily histograms still identify which classes were available.
  const recordedDays = range.totals.filter(row => row.scope === "day").map(row => row.tally);
  const series = statsBands([...recordedDays, summary.total, ...summary.trend.map(day => day.tally)]);
  if (summary.total.scored > 0) showHeadlineChoices(series);
  else if (!$<HTMLSelectElement>("lensHeadline").length) {
    // With no dated verdicts yet, show the current detector’s labels.
    showHeadlineChoices(statsBands([{ ...summary.total, expected: [0, 0, 0, 0, 0] }]));
  }
  shown = { range, from, to, trend: summary.trend, series };
  $("trendTip").hidden = true;
  const total = summary.total;
  const nothing = viewedWords(total) === 0 && summary.visits.length === 0;
  $("emptyCard").hidden = !nothing;
  $("sections").hidden = nothing;
  $("export").hidden = $("clear").hidden = first === null;
  $("emptyText").textContent = t(first === null && config.on ? "statsAwaitingActivity" : "statsNothing");
  $("lensNote").textContent = isDefaultLens(lens) ? t("statsLensDefault")
    : summary.fromParagraphs ? t("statsLensApplied") : t(range.units.length ? "statsLensNeedsDetail" : "statsLensCannot");
  displayedWeight = summary.fromParagraphs ? lens.weight : "words";
  $("estimatorNote").textContent = t(lens.estimator === "chip" ? "statsChipNote" : lens.estimator === "argmax" ? "statsArgmaxNote"
    : displayedWeight === "words" ? "statsExpectedNote" : "statsWeightedNote");
  if (!isDefaultLens(lens) && !needUnits) $("lensNote").textContent = t("statsLensTotals");
  const detailNote = $("detailCoverage");
  detailNote.textContent = summary.omittedWords > 0 ? t("statsLensPartial", words(summary.omittedWords))
    : needUnits && !summary.fromParagraphs ? $("lensNote").textContent : "";
  detailNote.hidden = !detailNote.textContent;
  if (nothing) { closeVisit(); return; }

  // Against what came before: a share up or down by whole points, or about the same.
  const previous = summarize(recent, againstFrom, againstTo, lens);
  const before = headlineOf(previous.total, lens);
  const now = headlineOf(total, lens);
  let compare = "";
  if (previous.fromParagraphs === summary.fromParagraphs && before !== null && now !== null) {
    if (length === 1) compare = t(to === today ? "statsCompare30" : "statsCompareTrailing", percent(before));
    else {
      const points = Math.round((now - before) * 100);
      compare = points === 0 ? t("statsDeltaSame", String(length)) : t(points > 0 ? "statsDeltaUp" : "statsDeltaDown", String(Math.abs(points)), String(length));
    }
  }
  headline(total, compare, series);
  // The figures beside it: what was scored and on how much, and where the most AI was.
  $("scoredTitle").textContent = t(scoredTitle(displayedWeight));
  $("scoredFigure").textContent = quantity(total.scored);
  $("topTitle").textContent = t(headlineCopy[lens.headline].top);
  // How many pages and sites, each said only where it was kept.
  // A page read on several days has one row per day.
  const pageCount = new Set(summary.pages.map((page) => page.key)).size;
  $("scoredLine").textContent = [
    ...(pageCount ? [t(pageCount === 1 ? "statsOnePage" : "statsKpiPages", words(pageCount))] : []),
    // Narrowed to a site, that it is one goes without saying.
    ...(summary.sites.length && siteFilter === null ? [t(summary.sites.length === 1 ? "statsOneSite" : "statsKpiSites", words(summary.sites.length))] : []),
  ].join(" · ");
  // A site with too few words to say anything about is not the "most" of anything.
  const floor = Math.max(displayedWeight === "words" ? 200 : displayedWeight === "time" ? 2 : 1, total.scored * 0.05);
  // Among sites where there are several, else among kinds of page (one site: the filter's own).
  const candidates = [...(summary.sites.length > 1 ? summary.sites.map((r) => ({ label: r.key || t("statsLocalFiles"), tally: r.tally })) : []),
    ...(summary.sites.length > 1 ? [] : summary.kinds.map((k) => ({ label: t(KIND_KEY[k.kind]), tally: k.tally })))]
    .filter((c) => c.tally.scored >= floor && headlineOf(c.tally, lens) !== null);
  // Nothing to set side by side (one site, no kinds kept): the day with the most, over several.
  if (candidates.length === 0 && summary.trend.length > 1) {
    candidates.push(...summary.trend.map((d) => ({ label: dayFormat.format(dateOf(d.date)), tally: d.tally }))
      .filter((c) => c.tally.scored >= floor / 2 && headlineOf(c.tally, lens) !== null));
  }
  candidates.sort((a, b) => headlineOf(b.tally, lens)! - headlineOf(a.tally, lens)!);
  // The most of several that read alike is not worth naming.
  const spread = candidates.length > 1 ? headlineOf(candidates[0]!.tally, lens)! - headlineOf(candidates.at(-1)!.tally, lens)! : 0;
  const top = spread >= 0.01 ? candidates[0] : undefined;
  $("topDetail").hidden = !top;
  $("topFigure").textContent = top?.label ?? "";
  $("topLine").textContent = top ? t("statsKpiTopLine", percent(headlineOf(top.tally, lens)), amount(verdictDenominator(top.tally, lens), shareWeight())) : "";

  $("trendVolume").textContent = t(shareWeight() === "words" ? "statsChartWords" : shareWeight() === "time" ? "statsColSeconds" : "statsColParagraphs");
  const hasDailyVerdicts = summary.trend.some((day) => verdictDenominator(day.tally, lens) > 0);
  $("trendCard").hidden = from === to;
  $("plotControls").hidden = $("trendChart").hidden = from === to || !hasDailyVerdicts;
  $("trendUnavailable").hidden = hasDailyVerdicts;
  if (from !== to) {
    if (hasDailyVerdicts) trendChart(summary.trend, from, to, series);
    trendTable(summary.trend, series);
  }
  $("kindTab").hidden = summary.kinds.length === 0;
  $("kindTable").replaceChildren(bandTable("statsColKind", summary.kinds.map((k) => ({ label: t(KIND_KEY[k.kind]), tally: k.tally }))));
  // Narrowed to a site, the chip says which; By site lists every site still, the picked one marked.
  const sites = siteFilter === null ? summary.sites : summarize(all, from, to, lens).sites;
  $("siteTab").hidden = sites.length === 0;
  const pickSite = (key: string): void => {
    const restoreFocus = document.activeElement?.classList.contains("site-pick");
    siteFilter = siteFilter === key ? null : key;
    void render().then(() => {
      if (restoreFocus && document.activeElement === document.body) {
        $("siteTable").querySelector<HTMLButtonElement>(`button[value="${CSS.escape(key)}"]`)?.focus();
      }
    });
  };
  if (sites.length > 0) $("siteTable").replaceChildren(bandTable("statsColSite", sites.slice(0, TOP_SITES).map((r) => ({ label: r.key || t("statsLocalFiles"), tally: r.tally, key: r.key })), pickSite, siteFilter));
  $("siteMore").textContent = sites.length > TOP_SITES ? t("statsMoreSites", words(sites.length - TOP_SITES)) : "";
  coverage(total);
  $("pagesTab").hidden = summary.pages.length === 0;
  pagesTable(summary.pages);
  $("visitsTab").hidden = summary.visits.length === 0;
  visitsTable(summary.visits);
  updateRecordTabs();
}

// ---- turning it on ---------------------------------------------------------------------------

{
  // One menu of presets, and what the chosen one keeps: not every preset's at once.
  const select = $<HTMLSelectElement>("turnOnPreset");
  for (const p of PRESET_IDS) select.add(new Option(presetLabel(p), p));
  const warn = (): void => {
    const config2 = presetConfig(select.value as Preset);
    $("turnOnHint").textContent = presetHint(select.value as Preset);
    $("turnOnWarn").replaceChildren(...warningsOf(config2).map((key) => el("p", "warn", t(key))));
  };
  select.addEventListener("change", warn);
  warn();
  $("turnOn").addEventListener("click", () => void saveStatsConfig(presetConfig(select.value as Preset, config?.retention)).then(render));
}

// ---- export -----------------------------------------------------------------------------------

const exportDialog = $<HTMLDialogElement>("exportDialog");
const exportScope = $<HTMLSelectElement>("exportScope");
const exportSave = $<HTMLButtonElement>("exportSave");
let prepared: Awaited<ReturnType<typeof fileOf>> = null;
const exportPreset = $<HTMLSelectElement>("exportPreset");
let exportChoice: { layers: Layers; hashed: Hashable[] } | null = null;
const exportTable = layerTable("export-dim", (layers, hashed) => { exportChoice = { layers, hashed }; exportPreset.value = matchPreset(layers, hashed); void refreshPreview(); });
$("exportDims").append(exportTable.element);

function matchPreset(layers: Layers, hashed: Hashable[]): string {
  if (hashed.length) return "custom";
  return PRESET_IDS.find((p) => presetOf({ on: true, layers, hashed: [], retention: config!.retention }) === p) ?? "custom";
}
/** Each dimension at the coarser of `a` and `b`, normalized. */
function coarsest(a: Layers, b: Layers): Layers {
  const out = { ...a } as Record<string, string>;
  for (const d of DIMENSION_IDS) if (rank(d, b[d] as never) > rank(d, a[d] as never)) out[d] = b[d];
  return normalize({ on: true, layers: out as Layers, hashed: [], retention: config!.retention }).config.layers;
}

async function fileOf(): Promise<{ file: ExportFile; name: string } | null> {
  if (!shown || !exportChoice || !config) return null;
  const { from, to } = shown;
  const { layers, hashed } = exportChoice;
  const exportLens = { ...lens };
  const site = exportScope.value === "site" ? siteFilter : null;
  const link = (new FormData($<HTMLFormElement>("exportForm")).get("link") === "stable") ? "stable" : "file";
  // Older hashed page totals need visit history to match a site, independently of
  // whether visit rows are included in the exported file.
  const visits = rank("rows", layers.rows) <= rank("rows", "visit") || site !== null ||
    (rank("rows", layers.rows) <= rank("rows", "site") && shown.range.totals.some((row) => row.hashed));
  const units = rank("rows", layers.rows) <= rank("rows", "paragraph");
  const [all, tabs, contexts, calendar] = await Promise.all([
    store.read(from, to, { visits, units: units && site === null }),
    layers.rows === "event" && site === null ? store.tabs(from, to) : [],
    store.contexts(from, to),
    units && needsParagraphs(exportLens) ? store.read(from, to, { units: true, byReadDate: true }) : undefined,
  ]);
  const range = site === null ? all : bySite(all, site);
  const ids = new Set(range.visits.map((v) => v.id));
  if (site !== null) {
    if (units) range.units = (await Promise.all([...ids].map((id) => store.unitsOf(id)))).flat();
    range.visits = range.visits.map((v) => ({ ...v, referrer: undefined,
      previous: v.previous && ids.has(v.previous) ? v.previous : undefined,
      parent: v.parent && ids.has(v.parent) ? v.parent : undefined, opener: v.opener && ids.has(v.opener) ? v.opener : undefined }));
  }
  const [ev, tx, placeLinks] = await Promise.all([
    layers.rows === "event" ? store.events([...ids]) : [],
    units && layers.text === "full" ? store.texts([...new Set(range.units.flatMap((u) => u.hash ? [u.hash] : []))]) : [],
    exportPlaceLinks(store, range, layers),
  ]);
  const key = link === "stable"
    ? Uint8Array.from((hmac(await statsSecret(), "anagram export key").match(/../g) ?? []).map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(32));
  // The text dictionary's profile-wide first/last dates can include other sites.
  if (site !== null && tx.length) {
    const dates = new Map<string, { first: string; last: string }>();
    for (const u of range.units) {
      if (!u.hash) continue;
      const span = dates.get(u.hash) ?? { first: u.date, last: u.date };
      if (u.date < span.first) span.first = u.date;
      if (u.date > span.last) span.last = u.date;
      dates.set(u.hash, span);
    }
    for (const text of tx) Object.assign(text, dates.get(text.hash));
  }
  const lensRange = calendar && (site === null ? calendar : bySite(calendar, site));
  const file = buildExport({ lensRange, placeLinks, visits: range.visits, units: range.units, events: ev, texts: tx, totals: range.totals, tabs, contexts }, {
    from, to, layers, hashed, link, lens: exportLens, siteFiltered: site !== null,
    generatedAt: new Date().toISOString(), extensionVersion: browser.runtime.getManifest().version,
  }, key);
  return { file, name: `anagram-stats-${from}${from === to ? "" : `-to-${to}`}` };
}

let previewTicket = 0;
async function refreshPreview(): Promise<void> {
  const ticket = ++previewTicket;
  prepared = null;
  exportSave.disabled = true;
  const host = $("exportPreview");
  host.textContent = t("statsExportPreparing");
  const made = await fileOf().catch(() => null);
  if (ticket !== previewTicket) return;
  if (!made) { host.textContent = t("optSaveFailed"); return; }
  prepared = made;
  exportSave.disabled = false;
  const p = preview(made.file);
  host.replaceChildren(el("p", undefined, t("statsExportSize", sizeText(p.bytes), words(p.tables.reduce((n, x) => n + x.rows, 0)))));
  for (const table of p.tables) {
    const details = el("details", "table-view");
    details.append(el("summary", undefined, t(table.rows === 1 ? "statsExportOneRow" : "statsExportTable", table.name, words(table.rows))));
    const box = el("div", "table-container");
    const tbl = el("table", "table");
    const head = tbl.createTHead().insertRow();
    for (const c of table.columns.slice(0, 12)) head.append(el("th", undefined, c));
    const body = tbl.createTBody();
    for (const row of table.first) {
      const r = body.insertRow();
      for (const v of row.slice(0, 12)) r.insertCell().textContent = v === null ? "" : typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v).slice(0, 60);
    }
    box.append(tbl);
    details.append(box);
    host.append(details);
  }
}
function sizeText(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 ** 2 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function openExport(): void {
  if (!shown || !config) return;
  const cap = config.on ? config.layers : presetConfig("fullText").layers;
  exportPreset.replaceChildren(...[...PRESET_IDS, "custom" as const].map((p) => new Option(presetLabel(p), p)));
  const recorded = config.on ? config : presetConfig("daily");
  const start = { layers: { ...recorded.layers }, hashed: [...recorded.hashed] };
  // Saving quotations in the profile and putting them in a downloadable file are separate choices.
  if (start.layers.text === "full" || start.layers.text === "head") start.layers.text = "sketch";
  exportDialog.querySelector<HTMLInputElement>('input[name="link"][value="file"]')!.checked = true;
  exportChoice = start;
  exportTable.show(start.layers, start.hashed, cap);
  exportPreset.value = matchPreset(start.layers, start.hashed);
  $("exportRange").textContent = t("statsExportRange", rangeText(shown.from, shown.to));
  exportScope.replaceChildren(new Option(t("statsExportAllSites"), "all"));
  if (siteFilter !== null) exportScope.add(new Option(t("statsFilterSite", siteFilter || t("statsLocalFiles")), "site"));
  exportScope.value = siteFilter === null ? "all" : "site";
  $("exportScopeField").hidden = siteFilter === null;
  exportDialog.showModal();
  exportPreset.focus();
  void refreshPreview();
}
exportScope.addEventListener("change", () => void refreshPreview());
exportDialog.addEventListener("close", () => {
  previewTicket++;
  prepared = null;
  $("exportPreview").replaceChildren();
});
exportPreset.addEventListener("change", () => {
  if (!config || exportPreset.value === "custom") return;
  const cap = config.on ? config.layers : presetConfig("fullText").layers;
  const layers = coarsest(presetConfig(exportPreset.value as Preset).layers, cap);
  exportChoice = { layers, hashed: exportChoice?.hashed ?? [] };
  exportTable.show(layers, exportChoice.hashed, cap);
  void refreshPreview();
});
for (const input of document.querySelectorAll<HTMLInputElement>("#exportForm input[name=link]")) input.addEventListener("change", () => void refreshPreview());
$("export").addEventListener("click", () => { closeMore(); openExport(); });
$("exportCancel").addEventListener("click", () => exportDialog.close());
$("exportForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const format = String(new FormData(e.target as HTMLFormElement).get("format") ?? "json");
  const made = prepared;
  if (!made) return;
  try {
    noteUi("export");
    if (format === "csv") save(`${made.name}.zip`, "application/zip", zip(exportCsvFiles(made.file)));
    else if (format === "jsongz") save(`${made.name}.json.gz`, "application/gzip", await gzip(exportJson(made.file)));
    else save(`${made.name}.json`, "application/json", exportJson(made.file));
    exportDialog.close();
  } catch { $("exportPreview").textContent = t("optSaveFailed"); }
});

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Hand the browser a file to save: no request, no permission, nothing leaves the computer. */
function save(name: string, type: string, data: string | Uint8Array): void {
  const url = URL.createObjectURL(new Blob([data as BlobPart], { type }));
  const link = el("a");
  link.href = url;
  link.download = name;
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

// ---- clear --------------------------------------------------------------------------------------

const clearDialog = $<HTMLDialogElement>("clearDialog");
$("clear").addEventListener("click", () => { closeMore(); clearDialog.showModal(); $("clearCancel").focus(); });
$("clearCancel").addEventListener("click", () => clearDialog.close());
$("clearConfirm").addEventListener("click", () => {
  void clearStatistics(store).then(() => { clearDialog.close(); previousRange = null; period = { kind: "days", days: 7 }; return render(); });
});

// ---- keeping up ---------------------------------------------------------------------------------

settings.statsConfig.watch((value) => { if (exportDialog.open) exportDialog.close(); config = configOf(value); void render(); });
settings.statsClearedAt.watch(() => { if (exportDialog.open) exportDialog.close(); siteFilter = null; void render(); });
const chartHost = $("trendChart");
new ResizeObserver(() => {
  const svg = chartHost.querySelector("svg");
  const width = chartHost.clientWidth;
  if (!shown || !svg || !width || svg.viewBox.baseVal.width === Math.max(300, width)) return;
  $("trendTip").hidden = true;
  trendChart(shown.trend, shown.from, shown.to, shown.series);
}).observe(chartHost);
// What was read in other tabs meanwhile: shown when this page is looked at again.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void render(); });
void render().then(() => { if (location.hash === "#export") openExport(); });
