// entrypoints/stats/main.ts — the reading statistics page.
//
// Everything on it is read straight from the extension's own IndexedDB (lib/stats/store.ts),
// which this page, as an extension page, may open; nothing is asked of a server, and the
// export is a file this page hands the browser to save. The numbers are lib/stats/summary.ts's,
// the colours the chips' own (lib/render/scale.ts). Every chart has its numbers beside it in
// text: the bars are drawn inside the tables that state them, and the trend has a table under it.
import { browser } from "#imports";
import "../../lib/ui/basecoat-vega.cdn.min.css";
import { followSystemTheme } from "../../lib/ui/theme";
import { localizePage } from "../../lib/ui/localize";
import { messageLocale, t, type MessageKey } from "../../lib/i18n";
import { bandLabel, BUCKET_BANDS } from "../../lib/render/band";
import { bandColorRules } from "../../lib/render/scale";
import { settings } from "../../lib/settings/settings";
import { minWordsOf } from "../../lib/dom/text";
import { flagFromOf } from "../../lib/render/flagLevel";
import {
  addDays, aiShare, atLeast, localDate, monthRange, retentionOf, shares, STATS_LEVELS, statsLevelOf, viewedWords,
  type PageKind, type StatsLevel, type Tally,
} from "../../lib/stats/model";
import { openStatsStore, type StatsRange } from "../../lib/stats/store";
import { byKind, bySite, feedsAndRest, pagesLatestFirst, recordedLevel, sumDays, trend } from "../../lib/stats/summary";
import { buildExport, dailyCsv, type ExportLevel } from "../../lib/stats/export";
import { formatShare as percent, formatWords as words } from "../../lib/stats/format";
import type { PageRecord } from "../../lib/stats/record";

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

/** Sites listed by name, the rest counted; pages listed, the rest in the export. */
const TOP_SITES = 10;
const MOST_PAGES = 200;

const LEVEL_KEY: Record<StatsLevel, MessageKey> = {
  off: "statsLevelOff", daily: "statsLevelDaily", sites: "statsLevelSites", pages: "statsLevelPages",
};
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
  t.expected.forEach((w, i) => {
    if (!(w > 0)) return;
    const slice = el("span", `b${i}`);
    slice.style.flexGrow = String(w);
    bar.append(slice);
  });
  return bar;
}

// ---- the period ---------------------------------------------------------------------------

type Period = { kind: "today" } | { kind: "days"; days: 7 | 30 } | { kind: "month"; month: string };
let period: Period = { kind: "today" };

function bounds(p: Period, today: string): { from: string; to: string } {
  if (p.kind === "today") return { from: today, to: today };
  if (p.kind === "days") return { from: addDays(today, 1 - p.days), to: today };
  const { from, to } = monthRange(p.month);
  return { from, to: to > today ? today : to };
}

const rangeTabs = [...document.querySelectorAll<HTMLButtonElement>("#ranges > [role=tab]")];
const monthEl = $<HTMLSelectElement>("month");
function showPeriod(): void {
  const key = period.kind === "today" ? "today" : period.kind === "days" ? String(period.days) : "";
  for (const tab of rangeTabs) {
    const on = tab.dataset.range === key;
    tab.setAttribute("aria-selected", String(on));
    tab.tabIndex = on || (key === "" && tab === rangeTabs[0]) ? 0 : -1;
  }
  monthEl.value = period.kind === "month" ? period.month : "";
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
  if (monthEl.value) period = { kind: "month", month: monthEl.value };
  else period = { kind: "today" };
  void render();
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
}

// ---- the sections ----------------------------------------------------------------------------

function headline(total: Tally, average: number | null): void {
  const share = aiShare(total);
  $("heroShare").textContent = percent(share);
  $("heroLine").textContent = total.scored > 0 ? t("statsHeroLine", words(total.scored)) : t("statsHeroNone");
  $("heroMix").replaceWith(Object.assign(mix(total), { id: "heroMix" }));
  const legend = $("heroLegend");
  const s = shares(total);
  legend.replaceChildren(...BUCKET_BANDS.map((band, i) => {
    const item = el("li", `b${i}`);
    item.append(el("span", "dot"), el("span", "lbl", bandLabel(band)), el("span", "n", percent(s ? s[i]! : null)));
    return item;
  }));
  $("heroCompare").textContent = average === null ? "" : t("statsCompare30", percent(average));
}

/** A table whose rows each carry their numbers, and under each row's name its bar: the bar
 *  goes with the row however narrow the page, and the numbers say what it shows. */
function bandTable(head: MessageKey, rows: { label: string; tally: Tally }[]): HTMLTableElement {
  const table = el("table", "table");
  const tr = table.createTHead().insertRow();
  tr.append(el("th", undefined, t(head)), el("th", "num", t("statsColWords")), el("th", "num", t("statsColAi")));
  const body = table.createTBody();
  for (const row of rows) {
    const r = body.insertRow();
    const label = r.insertCell();
    label.className = "name";
    label.append(el("span", undefined, row.label), mix(row.tally));
    Object.assign(r.insertCell(), { className: "num", textContent: words(viewedWords(row.tally)) });
    Object.assign(r.insertCell(), { className: "num", textContent: percent(aiShare(row.tally)) });
  }
  return table;
}

function empty(host: HTMLElement, key: MessageKey): void {
  host.replaceChildren(el("p", "empty", t(key)));
}

/** The trend: a column a day, its four words stacked by expected words; each column says its
 *  numbers when pointed at, and the table under it says them all. */
function trendChart(days: { date: string; tally: Tally }[], from: string, to: string): void {
  const host = $("trendChart");
  // As wide as it is drawn, so its words are at the page's own size on a phone too.
  const W = Math.max(300, Math.round(host.clientWidth || 720)), H = 190, left = 44, right = 8, top = 8, bottom = 24;
  const plotW = W - left - right, plotH = H - top - bottom;
  const most = Math.max(...days.map((d) => d.tally.scored), 0);
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
    add(col, "title", {}, `${dayFormat.format(dateOf(d.date))}: ${t("statsTrendTip", words(d.tally.scored), percent(aiShare(d.tally)))}`);
    let y = top + plotH;
    const parts = d.tally.expected.map((w, band) => ({ band, h: (w / max) * plotH })).filter((p) => p.h > 0.5);
    parts.forEach((p, k) => {
      // A 2px gap of the page between the words; the top of the column rounded.
      const gap = k > 0 ? 2 : 0;
      const h = Math.max(0.5, p.h - gap);
      y -= p.h;
      const last = k === parts.length - 1;
      const r = last ? Math.min(4, h, colW / 2) : 0;
      add(col, "path", { class: `seg b${p.band}`, d: `M${x},${y + gap + h}V${y + gap + r}Q${x},${y + gap} ${x + r},${y + gap}H${x + colW - r}Q${x + colW},${y + gap} ${x + colW},${y + gap + r}V${y + gap + h}Z` });
    });
    add(col, "rect", { class: "hit", x: left + slot * i, y: top, width: slot, height: plotH });
    if (i % labelEvery === 0 || i === days.length - 1) {
      add(svg, "text", { x: x + colW / 2, y: H - 6, "text-anchor": "middle" }, shortDay.format(dateOf(d.date)));
    }
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
    const s = shares(d.tally);
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
    [total.scored, "statsCovScored"], [total.short, "statsCovShort"], [total.language, "statsCovLanguage"], [total.unavailable, "statsCovUnavailable"],
  ];
  const bar = el("div", "mix");
  bar.id = "coverageMix";
  bar.setAttribute("aria-hidden", "true");
  parts.forEach(([n], i) => {
    if (!(n > 0)) return;
    const slice = el("span", `cov${i}`);
    slice.style.flexGrow = String(n);
    bar.append(slice);
  });
  $("coverageMix").replaceWith(bar);
  $("coverageList").replaceChildren(...parts.map(([n, key], i) => {
    const item = el("li", `cov${i}`);
    item.append(el("span", "dot"), el("span", "lbl", t(key, words(n))));
    return item;
  }));
}

function pagesTable(pages: PageRecord[]): void {
  const host = $("pagesTable");
  if (pages.length === 0) { empty(host, "statsNoPages"); $("pagesMore").textContent = ""; return; }
  const table = el("table", "table");
  const head = table.createTHead().insertRow();
  for (const [key, cls] of [["statsColOpened", ""], ["statsColPage", ""], ["statsColWords", "num"], ["statsColAi", "num"], ["statsColShown", "num"]] as [MessageKey, string][]) {
    head.append(el("th", cls || undefined, t(key)));
  }
  const body = table.createTBody();
  for (const p of pages.slice(0, MOST_PAGES)) {
    const r = body.insertRow();
    r.insertCell().textContent = `${shortDay.format(dateOf(p.date))} ${p.start}`;
    const cell = r.insertCell();
    cell.className = "name";
    const name = p.title || p.url || t("statsLocalFile");
    if (p.url) {
      const link = el("a", undefined, name);
      link.href = p.url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = p.url;
      cell.append(link);
    } else cell.textContent = name;
    Object.assign(r.insertCell(), { className: "num", textContent: words(viewedWords(p.tally)) });
    Object.assign(r.insertCell(), { className: "num", textContent: percent(aiShare(p.tally)) });
    Object.assign(r.insertCell(), { className: "num", textContent: p.dwell > 0 ? duration(p.dwell) : "–" });
  }
  host.replaceChildren(table);
  $("pagesMore").textContent = pages.length > MOST_PAGES ? t("statsMorePages", words(MOST_PAGES), words(pages.length)) : "";
}

// ---- the whole page --------------------------------------------------------------------------

let level: StatsLevel = "off";
let shown: { range: StatsRange; from: string; to: string; recorded: StatsLevel } | null = null;
let rendering = 0;

async function render(): Promise<void> {
  const ticket = ++rendering;
  const today = localDate();
  level = statsLevelOf(await settings.statsLevel.getValue().catch(() => "off"));
  const retention = retentionOf(await settings.statsRetentionDays.getValue().catch(() => 90));
  const { from, to } = bounds(period, today);
  const none = (): StatsRange => ({ days: [], sites: [], pages: [] });
  const [range, recent, first] = await Promise.all([
    store.read(from, to).catch(none),
    store.read(addDays(today, -29), today).catch(none),
    store.first().catch(() => null),
  ]);
  if (ticket !== rendering) return;
  await fillMonths(today);
  showPeriod();

  $("levelLine").textContent = level === "off" ? t("statsRecordingOff") : t("statsRecordingLine", t(LEVEL_KEY[level]), integer.format(retention));
  $("offCard").hidden = level !== "off";
  // Off with nothing kept: the explanation is the whole page.
  $("content").hidden = level === "off" && first === null;
  $("period").textContent = rangeText(from, to);

  const recorded = recordedLevel(range);
  shown = { range, from, to, recorded };
  const total = sumDays(range.days);
  const nothing = viewedWords(total) === 0;
  $("emptyCard").hidden = !nothing;
  $("sections").hidden = nothing;
  ($("export") as HTMLButtonElement).disabled = first === null;
  ($("clear") as HTMLButtonElement).disabled = first === null;
  if (nothing) return;

  headline(total, aiShare(sumDays(recent.days)));
  $("trendCard").hidden = from === to;
  if (from !== to) trendChart(trend(range.days, from, to), from, to);
  const kinds = byKind(range.days);
  $("kindTable").replaceChildren(bandTable("statsColKind", kinds.map((k) => ({ label: t(KIND_KEY[k.kind]), tally: k.tally }))));
  const { feeds, rest } = feedsAndRest(range.days);
  $("feedTable").replaceChildren(bandTable("statsColKind", [
    { label: t("statsKindFeed"), tally: feeds },
    { label: t("statsEverythingElse"), tally: rest },
  ]));

  const sites = bySite(range.sites);
  $("siteCard").hidden = sites.length === 0 && !atLeast(level, "sites");
  if (sites.length === 0) empty($("siteTable"), "statsNoSites");
  else $("siteTable").replaceChildren(bandTable("statsColSite", sites.slice(0, TOP_SITES).map((s) => ({ label: s.site || t("statsLocalFiles"), tally: s.tally }))));
  $("siteMore").textContent = sites.length > TOP_SITES ? t("statsMoreSites", words(sites.length - TOP_SITES)) : "";

  coverage(total);

  $("pagesCard").hidden = range.pages.length === 0 && !atLeast(level, "pages");
  pagesTable(pagesLatestFirst(range.pages));
}

// ---- turning it on ---------------------------------------------------------------------------

const turnOnLevel = $<HTMLSelectElement>("turnOnLevel");
const turnOnWarn = $("turnOnWarn");
turnOnLevel.addEventListener("change", () => { turnOnWarn.hidden = turnOnLevel.value !== "pages"; });
$("turnOn").addEventListener("click", () => {
  const chosen = statsLevelOf(turnOnLevel.value);
  if (chosen !== "off") void settings.statsLevel.setValue(chosen).then(render);
});

// ---- export -----------------------------------------------------------------------------------

const exportDialog = $<HTMLDialogElement>("exportDialog");
const exportLevel = $<HTMLSelectElement>("exportLevel");
function openExport(): void {
  if (!shown) return;
  const finest = shown.recorded === "off" ? "daily" : shown.recorded;
  // As recorded, or coarser: never finer.
  exportLevel.replaceChildren(...STATS_LEVELS.filter((l) => l !== "off" && atLeast(finest, l)).map((l) => new Option(t(LEVEL_KEY[l]), l)));
  exportLevel.value = finest;
  $("exportRange").textContent = t("statsExportRange", rangeText(shown.from, shown.to));
  exportDialog.showModal();
  exportLevel.focus();
}
$("export").addEventListener("click", openExport);
$("exportCancel").addEventListener("click", () => exportDialog.close());
$("exportForm").addEventListener("submit", (e) => {
  e.preventDefault();
  if (!shown) return;
  const { range, from, to, recorded } = shown;
  const format = (new FormData(e.target as HTMLFormElement).get("format") === "csv") ? "csv" : "json";
  void Promise.all([settings.flagFrom.getValue(), settings.minWords.getValue(), settings.mergeShorts.getValue()]).then(([flagFrom, minWords, mergeShorts]) => {
    const file = buildExport(range, from, to, recorded, exportLevel.value as ExportLevel, {
      generatedAt: localDate(), extensionVersion: browser.runtime.getManifest().version,
      flagFrom: flagFromOf(flagFrom), minWords: minWordsOf(minWords), mergeShorts,
    });
    const name = `anagram-stats-${from}${from === to ? "" : `-to-${to}`}`;
    if (format === "csv") save(`${name}.csv`, "text/csv", dailyCsv(file));
    else save(`${name}.json`, "application/json", JSON.stringify(file, null, 2) + "\n");
    exportDialog.close();
  });
});

/** Hand the browser a file to save: no request, no permission, nothing leaves the computer. */
function save(name: string, type: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
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
  void store.clear().then(() => { clearDialog.close(); period = { kind: "today" }; return render(); });
});

// ---- keeping up ---------------------------------------------------------------------------------

settings.statsLevel.watch(() => void render());
settings.statsRetentionDays.watch(() => void render());
// The trend is drawn at the width it has.
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
