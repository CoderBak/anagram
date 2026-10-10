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
import { bandLabel, BUCKET_BANDS } from "../../lib/render/band";
import { bandColorRules, levelOf } from "../../lib/render/scale";
import { settings } from "../../lib/settings/settings";
import { addDays, localDate, monthRange, scoreOf, viewedWords, type PageKind, type Tally, type UiEvent, type UnitRow, type VisitRow } from "../../lib/stats/model";
import { configOf, DIMENSION_IDS, normalize, presetConfig, presetOf, PRESET_IDS, rank, type Hashable, type Layers, type Preset, type RecordingConfig } from "../../lib/stats/config";
import { openStatsStore, type LogRange } from "../../lib/stats/store";
import { summarize, type Row } from "../../lib/stats/summary";
import { DEFAULT_LENS, headlineOf, isDefaultLens, sharesUnder, type Lens } from "../../lib/stats/lens";
import { buildExport, exportCsvFiles, exportJson, preview, type ExportFile } from "../../lib/stats/export";
import { zip } from "../../lib/stats/zip";
import { hmac } from "../../lib/stats/hash";
import { layerTable, presetHint, presetLabel, warningsOf } from "../../lib/stats/ui";
import { readStatsConfig, saveStatsConfig, statsSecret } from "../../lib/stats/settings";
import { formatShare as percent, formatWords as words } from "../../lib/stats/format";

localizePage();
followSystemTheme();
{
  const rules = document.createElement("style");
  rules.textContent = bandColorRules("", "html.dark");
  document.head.append(rules);
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

/** The four words' shares as one bar (aria-hidden: the text beside it says them). */
function mix(t: Tally): HTMLElement {
  const bar = el("div", "mix");
  bar.setAttribute("aria-hidden", "true");
  const parts = lens.estimator === "expected" ? t.expected : lens.estimator === "chip" ? t.units : t.argmax;
  parts.forEach((w, i) => {
    if (!(w > 0)) return;
    const slice = el("span", `b${i}`);
    slice.style.flexGrow = String(w);
    bar.append(slice);
  });
  return bar;
}

// ---- the lens ---------------------------------------------------------------------------------

let lens: Lens = { ...DEFAULT_LENS };
const LENS_KEY = "statsLens";
try { lens = { ...DEFAULT_LENS, ...JSON.parse(sessionStorage.getItem(LENS_KEY) ?? "{}") }; } catch { /* the default */ }
const lensSelects: { id: string; field: keyof Lens; options: [string | number, MessageKey, ...(string | number)[]][] }[] = [
  { id: "lensRead", field: "readMs", options: [[250, "statsSeconds", 0.25], [500, "statsSeconds", 0.5], [1000, "statsSeconds", 1], [2000, "statsSeconds", 2], [5000, "statsSeconds", 5], [10_000, "statsSeconds", 10], [30_000, "statsSeconds", 30]] },
  { id: "lensVisible", field: "visibility", options: [["band", "statsLensBand"], ["half", "statsLensHalf"], ["any", "statsLensAny"]] },
  { id: "lensOnce", field: "once", options: [["visit", "statsLensOnceVisit"], ["day", "statsLensOnceDay"], ["ever", "statsLensOnceEver"]] },
  { id: "lensEstimator", field: "estimator", options: [["expected", "statsLensExpected"], ["chip", "statsLensChip"], ["argmax", "statsLensArgmax"]] },
  { id: "lensWeight", field: "weight", options: [["words", "statsLensWords"], ["paragraphs", "statsLensParagraphs"], ["time", "statsLensTime"]] },
  { id: "lensHeadline", field: "headline", options: [["ai", "statsLensAi"], ["heavyAndAi", "statsLensHeavyAi"]] },
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
function lensChanged(): void {
  try { sessionStorage.setItem(LENS_KEY, JSON.stringify(lens)); } catch { /* not kept */ }
  showLens();
  void render();
}
showLens();

// ---- the period ---------------------------------------------------------------------------

type Period = { kind: "today" } | { kind: "days"; days: 7 | 30 } | { kind: "month"; month: string } | { kind: "range"; from: string; to: string };
let period: Period = { kind: "today" };

function bounds(p: Period, today: string): { from: string; to: string } {
  if (p.kind === "today") return { from: today, to: today };
  if (p.kind === "days") return { from: addDays(today, 1 - p.days), to: today };
  if (p.kind === "range") return p.from <= p.to ? { from: p.from, to: p.to } : { from: p.to, to: p.from };
  const { from, to } = monthRange(p.month);
  return { from, to: to > today ? today : to };
}

const rangeTabs = [...document.querySelectorAll<HTMLButtonElement>("#ranges > [role=tab]")];
const monthEl = $<HTMLSelectElement>("month");
const fromEl = $<HTMLInputElement>("rangeFrom"), toEl = $<HTMLInputElement>("rangeTo");
function showPeriod(): void {
  const key = period.kind === "today" ? "today" : period.kind === "days" ? String(period.days) : "";
  for (const tab of rangeTabs) {
    const on = tab.dataset.range === key;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on || (key === "" && tab === rangeTabs[0]) ? 0 : -1;
  }
  monthEl.value = period.kind === "month" ? period.month : "";
  if (period.kind !== "range") { fromEl.value = ""; toEl.value = ""; }
}
rangeTabs.forEach((tab, i) => {
  tab.addEventListener("click", () => {
    const range = tab.dataset.range;
    period = range === "today" ? { kind: "today" } : { kind: "days", days: range === "7" ? 7 : 30 };
    void render();
  });
  tab.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const next = rangeTabs[(i + (e.key === "ArrowRight" ? 1 : rangeTabs.length - 1)) % rangeTabs.length]!;
    next.focus();
    next.click();
  });
});
monthEl.addEventListener("change", () => {
  period = monthEl.value ? { kind: "month", month: monthEl.value } : { kind: "today" };
  void render();
});
for (const input of [fromEl, toEl]) input.addEventListener("change", () => {
  if (fromEl.value && toEl.value) { period = { kind: "range", from: fromEl.value, to: toEl.value }; void render(); }
});

/** The months there is anything for, newest first, as the picker's choices. */
async function fillMonths(today: string): Promise<void> {
  const first = (await store.first().catch(() => null)) ?? today;
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

function headline(total: Tally, average: number | null): void {
  $("heroShare").textContent = percent(headlineOf(total, lens));
  const what = lens.headline === "ai" ? "statsHeroLine" : "statsHeroLineHeavy";
  $("heroLine").textContent = total.scored > 0 ? t(what, words(total.scored)) : t("statsHeroNone");
  $("heroMix").replaceWith(Object.assign(mix(total), { id: "heroMix" }));
  const legend = $("heroLegend");
  const s = sharesUnder(total, lens);
  legend.replaceChildren(...BUCKET_BANDS.map((band, i) => {
    const item = el("li", `b${i}`);
    item.append(el("span", "dot"), el("span", "lbl", bandLabel(band)), el("span", "n", percent(s ? s[i]! : null)));
    return item;
  }));
  $("heroCompare").textContent = average === null ? "" : t("statsCompare30", percent(average));
}

/** A table whose rows each carry their numbers, and under each row's name its bar. */
function bandTable(head: MessageKey, rows: { label: string; tally: Tally }[]): HTMLTableElement {
  const table = el("table", "table");
  const tr = table.createTHead().insertRow();
  tr.append(el("th", undefined, t(head)), el("th", "num", t(lens.weight === "words" ? "statsColWords" : lens.weight === "paragraphs" ? "statsColParagraphs" : "statsColSeconds")), el("th", "num", t(lens.headline === "ai" ? "statsColAi" : "statsColHeavyAi")));
  const body = table.createTBody();
  for (const row of rows) {
    const r = body.insertRow();
    const label = r.insertCell();
    label.className = "name";
    label.append(el("span", undefined, row.label), mix(row.tally));
    Object.assign(r.insertCell(), { className: "num", textContent: words(viewedWords(row.tally)) });
    Object.assign(r.insertCell(), { className: "num", textContent: percent(headlineOf(row.tally, lens)) });
  }
  return table;
}

function empty(host: HTMLElement, key: MessageKey): void {
  host.replaceChildren(el("p", "empty", t(key)));
}

/** The trend: a column a day, its four words stacked; each column says its numbers when
 *  pointed at, and the table under it says them all. */
function trendChart(days: { date: string; tally: Tally }[], from: string, to: string): void {
  const host = $("trendChart");
  const W = Math.max(300, Math.round(host.clientWidth || 720)), H = 190, left = 44, right = 8, top = 8, bottom = 24;
  const plotW = W - left - right, plotH = H - top - bottom;
  const parts = (t2: Tally): number[] => lens.estimator === "expected" ? t2.expected : lens.estimator === "chip" ? t2.units : t2.argmax;
  const totalOf = (t2: Tally): number => parts(t2).reduce((a, b) => a + b, 0);
  const most = Math.max(...days.map((d) => totalOf(d.tally)), 0);
  const step = niceStep(most / 2);
  const max = Math.max(step * 2, 1);
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("width", String(W));
  svg.setAttribute("height", String(H));
  svg.setAttribute("class", "trend");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", t("statsTrendAria", rangeText(from, to)));
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
    add(svg, "text", { x: left - 6, y: y + 4, "text-anchor": "end" }, compact.format(tick));
  }
  const slot = plotW / days.length;
  const colW = Math.min(24, Math.max(2, slot * 0.7));
  const labelEvery = Math.ceil(days.length / 8);
  days.forEach((d, i) => {
    const x = left + slot * i + (slot - colW) / 2;
    const col = add(svg, "g", { class: "col" });
    add(col, "title", {}, `${dayFormat.format(dateOf(d.date))}: ${t("statsTrendTip", words(d.tally.scored), percent(headlineOf(d.tally, lens)))}`);
    let y = top + plotH;
    const segs = parts(d.tally).map((w, band) => ({ band, h: (w / max) * plotH })).filter((p) => p.h > 0.5);
    segs.forEach((p, k) => {
      const gap = k > 0 ? 2 : 0;
      const h = Math.max(0.5, p.h - gap);
      y -= p.h;
      const last = k === segs.length - 1;
      const r = last ? Math.min(4, h, colW / 2) : 0;
      add(col, "path", { class: `seg b${p.band}`, d: `M${x},${y + gap + h}V${y + gap + r}Q${x},${y + gap} ${x + r},${y + gap}H${x + colW - r}Q${x + colW},${y + gap} ${x + colW},${y + gap + r}V${y + gap + h}Z` });
    });
    add(col, "rect", { class: "hit", x: left + slot * i, y: top, width: slot, height: plotH });
    if (i % labelEvery === 0 || i === days.length - 1) add(svg, "text", { x: x + colW / 2, y: H - 6, "text-anchor": "middle" }, shortDay.format(dateOf(d.date)));
  });
  host.replaceChildren(svg);

  const table = el("table", "table");
  const head = table.createTHead().insertRow();
  for (const [text, cls] of [[t("statsColDate"), ""], [t("statsColWords"), "num"], [t("statsColScored"), "num"],
    ...BUCKET_BANDS.map((b) => [bandLabel(b), "num"])] as [string, string][]) head.append(el("th", cls || undefined, text));
  const body = table.createTBody();
  for (const d of days) {
    const r = body.insertRow();
    r.insertCell().textContent = dayFormat.format(dateOf(d.date));
    Object.assign(r.insertCell(), { className: "num", textContent: words(viewedWords(d.tally)) });
    Object.assign(r.insertCell(), { className: "num", textContent: words(d.tally.scored) });
    const s = sharesUnder(d.tally, lens);
    for (let i = 0; i < 4; i++) Object.assign(r.insertCell(), { className: "num", textContent: percent(s ? s[i]! : null) });
  }
  $("trendTable").replaceChildren(table);
}

/** 1, 2 or 5 times a power of ten: the gridlines' step. */
function niceStep(x: number): number {
  if (!(x > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(x));
  return ([1, 2, 5, 10].find((m) => m * p >= x) ?? 10) * p;
}

function coverage(total: Tally): void {
  const viewed = viewedWords(total);
  $("coverageLine").textContent = t("statsCoverageLine", words(total.scored), words(viewed), percent(viewed > 0 ? total.scored / viewed : null));
  const parts: [number, MessageKey][] = [
    [total.scored, "statsCovScored"], [total.short, "statsCovShort"], [total.language, "statsCovLanguage"], [total.unavailable, "statsCovUnavailable"], [total.removed, "statsCovRemoved"],
  ];
  const bar = el("div", "mix");
  bar.id = "coverageMix";
  bar.setAttribute("aria-hidden", "true");
  parts.forEach(([n], i) => {
    if (!(n > 0)) return;
    const slice = el("span", `cov${Math.min(i, 3)}`);
    slice.style.flexGrow = String(n);
    bar.append(slice);
  });
  $("coverageMix").replaceWith(bar);
  $("coverageList").replaceChildren(...parts.map(([n, key], i) => {
    const item = el("li", `cov${Math.min(i, 3)}`);
    item.append(el("span", "dot"), el("span", "lbl", t(key, words(n))));
    return item;
  }));
}

function linkOrText(url: string | undefined, name: string): HTMLElement {
  if (url && /^https?:\/\//.test(url)) {
    const link = el("a", undefined, name);
    link.href = url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.title = url;
    return link;
  }
  return el("span", undefined, name);
}

function pagesTable(pages: Row[]): void {
  const host = $("pagesTable");
  if (pages.length === 0) { empty(host, "statsNoPages"); $("pagesMore").textContent = ""; return; }
  const table = el("table", "table");
  const head = table.createTHead().insertRow();
  for (const [key, cls] of [["statsColOpened", ""], ["statsColPage", ""], ["statsColWords", "num"], [lens.headline === "ai" ? "statsColAi" : "statsColHeavyAi", "num"], ["statsColShown", "num"]] as [MessageKey, string][]) {
    head.append(el("th", cls || undefined, t(key)));
  }
  const body = table.createTBody();
  for (const p of pages.slice(0, MOST_ROWS)) {
    const r = body.insertRow();
    const [date, minute] = (p.start ?? "").split(" ");
    r.insertCell().textContent = date ? `${shortDay.format(dateOf(date))} ${minute ?? ""}`.trim() : "";
    const cell = r.insertCell();
    cell.className = "name";
    cell.append(linkOrText(p.url, p.title || p.url || t("statsLocalFile")));
    Object.assign(r.insertCell(), { className: "num", textContent: words(viewedWords(p.tally)) });
    Object.assign(r.insertCell(), { className: "num", textContent: percent(headlineOf(p.tally, lens)) });
    Object.assign(r.insertCell(), { className: "num", textContent: p.dwell ? duration(p.dwell) : "–" });
  }
  host.replaceChildren(table);
  $("pagesMore").textContent = pages.length > MOST_ROWS ? t("statsMorePages", words(MOST_ROWS), words(pages.length)) : "";
}

function visitsTable(visits: Row[], withEvents: boolean): void {
  const host = $("visitsTable");
  if (visits.length === 0) { empty(host, "statsNoVisits"); $("visitsMore").textContent = ""; return; }
  const table = el("table", "table");
  const head = table.createTHead().insertRow();
  for (const [key, cls] of [["statsColOpened", ""], ["statsColPage", ""], ["statsColWords", "num"], [lens.headline === "ai" ? "statsColAi" : "statsColHeavyAi", "num"], ["statsColShown", "num"], ["statsColReplay", ""]] as [MessageKey, string][]) {
    head.append(el("th", cls || undefined, t(key)));
  }
  const body = table.createTBody();
  for (const row of visits.slice(0, MOST_ROWS)) {
    const v = row.visit!;
    const r = body.insertRow();
    r.insertCell().textContent = timeFormat.format(new Date(v.start));
    const cell = r.insertCell();
    cell.className = "name";
    cell.append(linkOrText(v.url, v.title || v.url || v.site || t(KIND_KEY[v.kind])));
    Object.assign(r.insertCell(), { className: "num", textContent: words(viewedWords(row.tally)) });
    Object.assign(r.insertCell(), { className: "num", textContent: percent(headlineOf(row.tally, lens)) });
    Object.assign(r.insertCell(), { className: "num", textContent: v.shown ? duration(Math.round(v.shown / 1000)) : "–" });
    const replay = r.insertCell();
    if (withEvents) {
      const button = el("button", "linkish", t("statsReplay"));
      button.type = "button";
      button.addEventListener("click", () => void showReplay(v));
      replay.append(button);
    }
  }
  host.replaceChildren(table);
  $("visitsMore").textContent = visits.length > MOST_ROWS ? t("statsMoreVisits", words(MOST_ROWS), words(visits.length)) : "";
}

/** A visit's replay: when each paragraph was on screen, in its chip's colour, with how far
 *  down the page was scrolled. */
async function showReplay(v: VisitRow): Promise<void> {
  const [units, events] = await Promise.all([store.unitsOf(v.id), store.events([v.id])]);
  const spells: { n: number; start: number; end: number }[] = [];
  const scroll: { t: number; y: number; ph: number; vh: number }[] = [];
  for (const chunk of events) {
    const iv = chunk.streams.intervals;
    if (iv) for (let i = 0; i < iv.unit.length; i++) if (iv.kind[i] === 0) spells.push({ n: iv.unit[i]!, start: iv.start[i]!, end: iv.end[i]! });
    const st = chunk.streams.steps;
    if (st && !iv) {
      // From the steps: on screen from a step above nothing to the next at nothing.
      const open = new Map<number, number>();
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
  const byN = new Map(units.map((u) => [u.n, u]));
  const end = Math.max(1, v.end ? v.end - v.start : 0, ...spells.map((s) => s.end), ...scroll.map((s) => s.t));
  const ns = "http://www.w3.org/2000/svg";
  const rows = Math.max(1, ...units.map((u) => u.n + 1), ...spells.map((s) => s.n + 1));
  const W = Math.max(300, Math.round($("replayChart").clientWidth || 720)), laneH = Math.max(3, Math.min(10, 300 / rows)), left = 8, H = rows * laneH + 30;
  const x = (ms: number): number => left + (ms / end) * (W - left - 8);
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  svg.setAttribute("class", "replay");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", t("statsReplayAria", words(rows), duration(Math.round(end / 1000))));
  const add = (tag: string, attrs: Record<string, string | number>, text?: string): void => {
    const node = document.createElementNS(ns, tag);
    for (const [k, val] of Object.entries(attrs)) node.setAttribute(k, String(val));
    if (text !== undefined) node.textContent = text;
    svg.append(node);
  };
  for (let n = 0; n < rows; n++) add("rect", { class: "lane", x: left, y: n * laneH, width: W - left - 8, height: Math.max(1, laneH - 1) });
  for (const s of spells) {
    const u: UnitRow | undefined = byN.get(s.n);
    const p = u?.verdict?.p;
    const band = p ? levelOf(scoreOf(p)) : u?.verdict?.band;
    add("rect", { class: `on b${band ?? 0}`, x: x(s.start), y: s.n * laneH, width: Math.max(1, x(s.end) - x(s.start)), height: Math.max(1, laneH - 1) });
  }
  if (scroll.length > 1) {
    const d = scroll.map((s, i) => `${i ? "L" : "M"}${x(s.t).toFixed(1)},${((s.y / Math.max(1, s.ph - s.vh)) * (rows * laneH)).toFixed(1)}`).join("");
    add("path", { class: "scroll", d });
  }
  add("text", { x: left, y: H - 6 }, "0");
  add("text", { x: W - 8, y: H - 6, "text-anchor": "end" }, duration(Math.round(end / 1000)));
  $("replayChart").replaceChildren(svg);
  $("replayTitle").textContent = t("statsReplayTitle", timeFormat.format(new Date(v.start)), v.title || v.url || v.site || t(KIND_KEY[v.kind]));
  $("replay").hidden = false;
  $("replay").scrollIntoView({ block: "nearest" });
}

// ---- the whole page --------------------------------------------------------------------------

let config: RecordingConfig | null = null;
let shown: { range: LogRange; from: string; to: string } | null = null;
let rendering = 0;

async function render(): Promise<void> {
  const ticket = ++rendering;
  const today = localDate();
  config = await readStatsConfig();
  const { from, to } = bounds(period, today);
  const none = (): LogRange => ({ visits: [], units: [], totals: [] });
  const needUnits = !isDefaultLens(lens);
  const [range, recent, first] = await Promise.all([
    store.read(from, to, { units: needUnits }).catch(none),
    // The thirty days the period is held against, counted by the same rule.
    store.read(addDays(today, -29), today, { units: needUnits }).catch(none),
    store.first().catch(() => null),
  ]);
  if (ticket !== rendering) return;
  await fillMonths(today);
  showPeriod();

  const preset = config.on ? presetOf(config) ?? "custom" : "off";
  $("levelLine").textContent = config.on ? t("statsRecordingLine", presetLabel(preset), integer.format(config.retention.detail)) : t("statsRecordingOff");
  $("offCard").hidden = config.on;
  $("content").hidden = !config.on && first === null;
  $("period").textContent = rangeText(from, to);

  shown = { range, from, to };
  const summary = summarize(range, from, to, lens);
  const total = summary.total;
  const nothing = viewedWords(total) === 0 && summary.visits.length === 0;
  $("emptyCard").hidden = !nothing;
  $("sections").hidden = nothing;
  ($("export") as HTMLButtonElement).disabled = first === null;
  ($("clear") as HTMLButtonElement).disabled = first === null;
  $("lensNote").textContent = isDefaultLens(lens) ? t("statsLensDefault")
    : range.units.length > 0 ? t("statsLensApplied") : t("statsLensCannot");
  if (nothing) return;

  const recentSummary = summarize(recent, addDays(today, -29), today, lens);
  headline(total, headlineOf(recentSummary.total, lens));
  $("trendCard").hidden = from === to;
  if (from !== to) trendChart(summary.trend, from, to);
  $("kindTable").replaceChildren(bandTable("statsColKind", summary.kinds.map((k) => ({ label: t(KIND_KEY[k.kind]), tally: k.tally }))));
  $("feedTable").replaceChildren(bandTable("statsColKind", [
    { label: t("statsKindFeed"), tally: summary.feeds },
    { label: t("statsEverythingElse"), tally: summary.rest },
  ]));
  const sites = summary.sites;
  $("siteCard").hidden = sites.length === 0;
  if (sites.length > 0) $("siteTable").replaceChildren(bandTable("statsColSite", sites.slice(0, TOP_SITES).map((s) => ({ label: s.key || t("statsLocalFiles"), tally: s.tally }))));
  $("siteMore").textContent = sites.length > TOP_SITES ? t("statsMoreSites", words(sites.length - TOP_SITES)) : "";
  coverage(total);
  $("pagesCard").hidden = summary.pages.length === 0;
  pagesTable(summary.pages);
  $("visitsCard").hidden = summary.visits.length === 0;
  visitsTable(summary.visits, config.on ? config.layers.rows === "event" : true);
}

// ---- turning it on ---------------------------------------------------------------------------

{
  const list = $("presetList");
  const select = $<HTMLSelectElement>("turnOnPreset");
  for (const p of PRESET_IDS) {
    const item = el("li");
    item.append(el("strong", undefined, presetLabel(p)), el("span", undefined, presetHint(p)));
    list.append(item);
    select.add(new Option(presetLabel(p), p));
  }
  const warn = (): void => {
    const config2 = presetConfig(select.value as Preset);
    $("turnOnWarn").replaceChildren(...warningsOf(config2).map((key) => el("p", "warn", t(key))));
  };
  select.addEventListener("change", warn);
  warn();
  $("turnOn").addEventListener("click", () => void saveStatsConfig(presetConfig(select.value as Preset, config?.retention)).then(render));
}

// ---- export -----------------------------------------------------------------------------------

const exportDialog = $<HTMLDialogElement>("exportDialog");
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
  const [range, tabs, contexts] = await Promise.all([store.read(from, to, { units: true }), store.tabs(from, to), store.contexts(from, to)]);
  const ev = exportChoice.layers.rows === "event" ? await store.events(range.visits.map((v) => v.id)) : [];
  const tx = exportChoice.layers.text === "full" ? await store.texts([...new Set(range.units.map((u) => u.hash).filter((h): h is string => !!h))]) : [];
  const link = (new FormData($<HTMLFormElement>("exportForm")).get("link") === "stable") ? "stable" : "file";
  const key = link === "stable"
    ? Uint8Array.from((hmac(await statsSecret(), "anagram export key").match(/../g) ?? []).map((h) => parseInt(h, 16)))
    : crypto.getRandomValues(new Uint8Array(32));
  const file = buildExport({ visits: range.visits, units: range.units, events: ev, texts: tx, totals: range.totals, tabs, contexts }, {
    from, to, layers: exportChoice.layers, hashed: exportChoice.hashed, link, lens,
    generatedAt: new Date().toISOString(), extensionVersion: browser.runtime.getManifest().version,
  }, key);
  return { file, name: `anagram-stats-${from}${from === to ? "" : `-to-${to}`}` };
}

let previewTicket = 0;
async function refreshPreview(): Promise<void> {
  const ticket = ++previewTicket;
  const host = $("exportPreview");
  host.textContent = t("statsExportPreparing");
  const made = await fileOf().catch(() => null);
  if (ticket !== previewTicket) return;
  if (!made) { host.textContent = ""; return; }
  const p = preview(made.file);
  host.replaceChildren(el("p", undefined, t("statsExportSize", sizeText(p.bytes), words(p.tables.reduce((n, x) => n + x.rows, 0)))));
  for (const table of p.tables) {
    const details = el("details", "table-view");
    details.append(el("summary", undefined, t("statsExportTable", table.name, words(table.rows))));
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
  const start = config.on ? { layers: config.layers, hashed: config.hashed } : { layers: presetConfig("daily").layers, hashed: [] as Hashable[] };
  exportChoice = start;
  exportTable.show(start.layers, start.hashed, cap);
  exportPreset.value = matchPreset(start.layers, start.hashed);
  $("exportPresetNote").textContent = t("statsExportCap");
  $("exportRange").textContent = t("statsExportRange", rangeText(shown.from, shown.to));
  exportDialog.showModal();
  exportPreset.focus();
  void refreshPreview();
}
exportPreset.addEventListener("change", () => {
  if (!config || exportPreset.value === "custom") return;
  const cap = config.on ? config.layers : presetConfig("fullText").layers;
  const layers = coarsest(presetConfig(exportPreset.value as Preset).layers, cap);
  exportChoice = { layers, hashed: exportChoice?.hashed ?? [] };
  exportTable.show(layers, exportChoice.hashed, cap);
  void refreshPreview();
});
for (const input of document.querySelectorAll<HTMLInputElement>("#exportForm input[name=link]")) input.addEventListener("change", () => void refreshPreview());
$("export").addEventListener("click", openExport);
$("exportCancel").addEventListener("click", () => exportDialog.close());
$("exportForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const format = String(new FormData(e.target as HTMLFormElement).get("format") ?? "json");
  void fileOf().then(async (made) => {
    if (!made) return;
    noteUi("export");
    if (format === "csv") save(`${made.name}.zip`, "application/zip", zip(exportCsvFiles(made.file)));
    else if (format === "jsongz") save(`${made.name}.json.gz`, "application/gzip", await gzip(exportJson(made.file)));
    else save(`${made.name}.json`, "application/json", exportJson(made.file));
    exportDialog.close();
  });
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
$("clear").addEventListener("click", () => { clearDialog.showModal(); $("clearCancel").focus(); });
$("clearCancel").addEventListener("click", () => clearDialog.close());
$("clearConfirm").addEventListener("click", () => {
  void Promise.all([store.clear(), settings.statsSecret.setValue(null)]).then(() => { clearDialog.close(); period = { kind: "today" }; return render(); });
});

// ---- keeping up ---------------------------------------------------------------------------------

settings.statsConfig.watch((value) => { config = configOf(value); void render(); });
let resized: ReturnType<typeof setTimeout> | undefined;
let lastWidth = window.innerWidth;
window.addEventListener("resize", () => {
  if (window.innerWidth === lastWidth) return;
  lastWidth = window.innerWidth;
  clearTimeout(resized);
  resized = setTimeout(() => void render(), 200);
});
// What was read in other tabs meanwhile: shown when this page is looked at again.
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") void render(); });
void render().then(() => { if (location.hash === "#export") openExport(); });
