// lib/stats/export.ts — the file a reader saves from the statistics page, and may choose to give
// somebody (a research study, say). Anagram never sends it anywhere; docs/statistics.md and
// lib/stats/dictionary.ts describe every table and column.
//
// A file holds each dimension at the layer chosen for it, and never finer than what was
// recorded: a value kept at a coarser layer stays as it was kept. Every id and hash in it is
// keyed again for the file (`link`): "file" makes them this file's alone, so two files cannot be
// joined by them; "stable" keys them the same way in every file of this browser profile, so a
// study can join one person's monthly files. Sketches are masked the same way. Pure but for
// nothing: the page hands it the rows and the keys.
import { BUCKET_COUNT } from "../contract";
import { SCORE_CUTS } from "../render/scale";
import { rank, type Hashable, type Layers, type Layer } from "./config";
import { coarseDur, coarseLang, coarseLen, coarseTime, coarseTitle, coarseVerdict, type Lengths } from "./coarsen";
import { TABLES } from "./dictionary";
import { keyedHash } from "./hash";
import { headlineOf, tallyUnder, type Lens } from "./lens";
import {
  ARRIVALS, INPUT_KINDS, STATE_KINDS, UI_EVENTS,
  type ContextRow, type EventChunk, type TabEvent, type TotalRow, type UnitRow, type VisitRow,
} from "./model";
import type { TextRow } from "./store";

export const EXPORT_SCHEMA = "anagram-stats";
export const EXPORT_VERSION = 1;

export interface ExportSource {
  visits: VisitRow[];
  units: UnitRow[];
  events: EventChunk[];
  texts: TextRow[];
  totals: TotalRow[];
  tabs: TabEvent[];
  contexts: ContextRow[];
}

export interface ExportOptions {
  from: string;
  to: string;
  layers: Layers;
  hashed: Hashable[];
  link: "file" | "stable";
  lens: Lens;
  generatedAt: string;
  extensionVersion: string;
}

export interface Table { columns: string[]; rows: unknown[][] }
export interface ExportFile {
  manifest: Record<string, unknown>;
  tables: Record<string, Table>;
}

const PLACES = ["url", "nofragment", "querynames", "path", "pattern", "host", "domain"] as const;

/** The file for `source` under `opts`. `key` keys its ids and hashes (a random one per file, or
 *  the profile's stable one). */
export function buildExport(source: ExportSource, opts: ExportOptions, key: Uint8Array): ExportFile {
  const L = opts.layers;
  const at = <D extends keyof Layers>(d: D, layer: Layer<D>): boolean => rank(d, L[d]) <= rank(d, layer);
  const pseudo = (id: string | undefined): string | undefined => id === undefined ? undefined : keyedHash(key, id);
  const mask = sketchMask(key);
  const dur = (ms: number | undefined): number | undefined => ms === undefined ? undefined : coarseDur(ms, L.dur) ?? undefined;
  const time = (ms: number | undefined): number | undefined => ms === undefined ? undefined : coarseTime(ms, L.time);
  /** A value kept in the clear or as a hash, for the file: re-keyed where it was a hash,
   *  hashed where the file asks, as it was otherwise. */
  const named = (value: string | undefined, wasHashed: boolean, d: Hashable): string | undefined =>
    value === undefined ? undefined : wasHashed || opts.hashed.includes(d) ? keyedHash(key, value) : value;

  const tables: Record<string, Record<string, unknown>[]> = {};
  const add = (name: string, row: Record<string, unknown> | null): void => { if (row) (tables[name] ??= []).push(row); };

  // ---- visits ----------------------------------------------------------------------------------
  const visitsKept = at("rows", "visit");
  const byVisit = new Map(source.visits.map((v) => [v.id, v]));
  if (visitsKept) {
    for (const v of source.visits) {
      const was = (d: Hashable): boolean => v.hashed?.includes(d) ?? false;
      const place = L.place === "none" ? undefined : placeAt(v.places, L.place);
      add("visits", {
        id: pseudo(v.id), date: v.date, start: time(v.start), end: time(v.end), ended: v.ended, frame: v.frame,
        parent: at("nav", "full") ? pseudo(v.parent) : undefined,
        tab: at("tabs", "ids") ? pseudo(v.tab) : undefined, window: at("tabs", "ids") ? pseudo(v.window) : undefined,
        url: rank("place", L.place) <= rank("place", "pattern") ? named(place, was("place"), "place") : undefined,
        site: L.place === "none" ? undefined : named(v.places?.host ?? v.places?.domain, was("place"), "place"),
        title: v.title === undefined || L.title === "none" ? undefined : was("title") ? pseudo(v.title) : named(coarseTitle(v.title, L.title), false, "title"),
        kind: at("struct", "kind") ? v.kind : undefined, signals: L.struct === "full" ? v.signals : undefined, surface: v.surface,
        arrival: at("nav", "arrival") ? v.arrival : undefined,
        referrer: at("nav", "full") ? named(v.referrer, was("place"), "place") : undefined,
        previous: at("nav", "full") ? pseudo(v.previous) : undefined, opener: at("nav", "full") ? pseudo(v.opener) : undefined,
        shown: at("state", "totals") ? dur(v.shown) : undefined, active: at("state", "totals") ? dur(v.active) : undefined,
        focused: at("state", "totals") ? dur(v.focused) : undefined,
        height: at("geom", "share") ? v.height : undefined, width: at("geom", "share") ? v.width : undefined,
        found: L.cover === "visit" ? v.found : undefined, leftOut: L.cover === "visit" ? v.leftOut : undefined,
        display: v.display, model: v.model,
        engine: L.engine === "full" ? v.engine : L.engine === "basic" && v.engine ? { kind: v.engine.kind } : undefined,
        scroll: at("scroll", "visit") ? v.scroll : undefined,
        idle: at("input", "idle") ? v.idle?.map(([a, b]) => [dur(a), dur(b)]) : undefined,
        minutes: at("input", "minutes") ? v.minutes : undefined,
        ui: at("ui", "counts") ? v.ui : undefined, pdf: v.pdf, tally: tallyOut(v.tally),
      });
    }
  }

  // ---- paragraphs -----------------------------------------------------------------------------
  const unitsKept = at("rows", "paragraph");
  if (unitsKept) {
    for (const u of source.units) {
      add("units", {
        visit: pseudo(u.visit), n: u.n, date: u.date, status: u.status,
        hash: at("text", "hash") ? pseudo(u.hash) : undefined,
        sketch: at("text", "sketch") && u.sketch ? masked(u.sketch, mask) : undefined,
        head: at("text", "head") ? u.head : undefined,
        len: u.len ? coarseLen(u.len as Lengths, L.len) : undefined,
        lang: u.lang ? coarseLang(u.lang, L.lang) : undefined,
        struct: L.struct === "full" ? u.struct : at("struct", "unit") && u.struct ? { unit: u.struct.unit, post: u.struct.post, order: u.struct.order, paragraphs: u.struct.paragraphs } : undefined,
        geom: !u.geom || L.geom === "none" ? undefined : L.geom === "share" ? { share: u.geom.share, page: u.geom.page } : L.geom === "order" ? { page: u.geom.page } : u.geom,
        verdict: u.verdict ? coarseVerdict(u.verdict, L.verdict) : undefined,
        timing: L.engine === "full" ? u.timing && { cached: u.timing.cached, answered: dur(u.timing.answered) } : L.engine === "basic" ? u.timing && { cached: u.timing.cached } : undefined,
        expo: !u.expo || L.expo === "none" ? undefined : L.expo === "read" ? { readAt: dur(u.expo.readAt) }
          : { any: u.expo.any.map((x) => dur(x)), half: u.expo.half.map((x) => dur(x)), band: u.expo.band.map((x) => dur(x)), first: dur(u.expo.first), last: dur(u.expo.last), sightings: u.expo.sightings, readAt: dur(u.expo.readAt) },
        found: dur(u.found), removedAt: dur(u.removedAt),
      });
    }
  }

  // ---- events ---------------------------------------------------------------------------------------
  if (L.rows === "event") {
    const scrollEvery = L.scroll === "frames" ? 0 : L.scroll === "tenth" ? 100 : L.scroll === "second" ? 1000 : null;
    const lastScroll = new Map<string, number>();
    for (const chunk of [...source.events].sort((a, b) => a.visit.localeCompare(b.visit) || a.seq - b.seq)) {
      const visit = pseudo(chunk.visit);
      const s = chunk.streams;
      const rowsOf = (stream: Record<string, number[] | undefined> | undefined, keep: (i: number) => boolean, shape: (i: number) => Record<string, unknown>): void => {
        if (!stream) return;
        const length = Object.values(stream).find(Array.isArray)?.length ?? 0;
        return void Array.from({ length }, (_, i) => i).filter(keep).forEach((i) => add(streamName(stream, s), { visit, ...shape(i) }));
      };
      if (L.expo === "steps") rowsOf(s.steps, () => true, (i) => ({ t: dur(s.steps!.t[i]), unit: s.steps!.unit[i], obs: s.steps!.obs[i], ratio: s.steps!.ratio[i], top: s.steps!.top[i], h: s.steps!.h[i] }));
      if (at("expo", "intervals")) rowsOf(s.intervals, () => true, (i) => ({ unit: s.intervals!.unit[i], kind: s.intervals!.kind[i], start: dur(s.intervals!.start[i]), end: dur(s.intervals!.end[i]), peak: s.intervals!.peak[i] }));
      if (scrollEvery !== null) rowsOf(s.scroll, (i) => {
        const k = `${chunk.visit} ${s.scroll!.box[i]}`, t = s.scroll!.t[i]!;
        if (t - (lastScroll.get(k) ?? -Infinity) < scrollEvery) return false;
        lastScroll.set(k, t);
        return true;
      }, (i) => ({ t: dur(s.scroll!.t[i]), box: s.scroll!.box[i], x: s.scroll!.x[i], y: s.scroll!.y[i], vw: s.scroll!.vw[i], vh: s.scroll!.vh[i], ph: s.scroll!.ph[i] }));
      if (at("scroll", "episodes")) rowsOf(s.episodes, () => true, (i) => ({ start: dur(s.episodes!.start[i]), end: dur(s.episodes!.end[i]), distance: s.episodes!.distance[i], peak: s.episodes!.peak[i] }));
      if (at("input", "events")) {
        const move = INPUT_KINDS.indexOf("move");
        rowsOf(s.input, (i) => L.input === "pointer" || s.input!.kind[i] !== move, (i) => ({
          t: dur(s.input!.t[i]), kind: s.input!.kind[i],
          x: at("input", "positions") ? s.input!.x?.[i] : undefined, y: at("input", "positions") ? s.input!.y?.[i] : undefined, n: s.input!.n?.[i],
        }));
      }
      if (L.state === "changes") rowsOf(s.state, () => true, (i) => ({ t: dur(s.state!.t[i]), kind: s.state!.kind[i] }));
      if (L.ui === "events") rowsOf(s.ui, () => true, (i) => ({ t: dur(s.ui!.t[i]), kind: s.ui!.kind[i], unit: s.ui!.unit[i] }));
      if (L.geom === "changes") rowsOf(s.geom, () => true, (i) => ({ t: dur(s.geom!.t[i]), unit: s.geom!.unit[i], x: s.geom!.x[i], y: s.geom!.y[i], w: s.geom!.w[i], h: s.geom!.h[i] }));
    }
    for (const e of source.tabs) {
      const keep = e.kind === "uncovered" ? L.cover === "visit" : e.kind === "ui" ? L.ui === "events"
        : L.tabs === "full" || (L.tabs === "ids" && (e.kind === "tabFront" || e.kind === "windowFocus" || e.kind === "windowBlur"));
      if (!keep) continue;
      add("tabs", {
        at: time(e.at), date: e.date, kind: e.kind, window: at("tabs", "ids") ? pseudo(e.window) : undefined, tab: at("tabs", "ids") ? pseudo(e.tab) : undefined,
        opener: L.tabs === "full" ? pseudo(e.opener) : undefined, state: L.tabs === "full" ? e.state : undefined, index: L.tabs === "full" ? e.index : undefined,
        ms: dur(e.ms), ui: e.ui, visit: pseudo(e.visit),
      });
    }
  }

  // ---- context, texts, totals ----------------------------------------------------------------------
  for (const c of source.contexts) {
    add("context", {
      at: time(c.at), date: c.date, extension: c.extension,
      browser: L.device === "none" ? undefined : L.device === "exact" ? c.browser : family(c.browser),
      os: L.device === "none" ? undefined : L.device === "exact" ? c.os : family(c.os),
      hardware: L.device === "exact" ? c.hardware : undefined, locale: c.locale, model: c.model,
      engine: L.engine === "full" ? c.engine : L.engine === "basic" && c.engine ? { kind: c.engine.kind } : undefined,
      settings: c.settings, recording: c.recording,
    });
  }
  if (unitsKept && L.text === "full") for (const t of source.texts) add("texts", { hash: pseudo(t.hash), text: t.text, first: t.first, last: t.last });
  for (const t of source.totals) {
    if (t.scope === "site" && !(at("rows", "site") && at("place", "domain"))) continue;
    if (t.scope === "page" && !(at("rows", "page") && at("place", "pattern"))) continue;
    if (t.scope === "kind" && !at("struct", "kind")) continue;
    const key = t.scope === "site" || t.scope === "page" ? (t.key.startsWith("file:") ? "file:" : named(t.key, t.hashed ?? false, "place")) : t.key;
    add("totals", {
      date: t.date, scope: t.scope, key,
      title: t.title === undefined || L.title === "none" ? undefined : t.hashed ? pseudo(t.title) : named(coarseTitle(t.title, L.title), false, "title"),
      start: at("time", "min") ? t.start : undefined, dwell: L.dur === "none" ? undefined : t.dwell, kind: t.kind, models: t.models,
      tally: tallyOut(t.tally),
    });
  }

  // ---- the lens ---------------------------------------------------------------------------------------
  if (unitsKept && source.units.length > 0) {
    const groups = new Map<string, UnitRow[]>();
    for (const u of source.units) {
      const v = byVisit.get(u.visit);
      const key = `${v?.date ?? u.date}\t${v?.kind ?? "other"}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(u);
    }
    for (const [key, units] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const [date, kind] = key.split("\t") as [string, string];
      const tally = tallyUnder(units, opts.lens);
      add("lens", { date, kind, headline: headlineOf(tally, opts.lens), tally: tallyOut(tally) });
    }
  }

  // ---- the file ---------------------------------------------------------------------------------------
  const out: Record<string, Table> = {};
  for (const [name, rows] of Object.entries(tables)) out[name] = columnar(name, rows);
  const recorded = uniqueBy(source.contexts.map((c) => c.recording).filter(Boolean), (r) => JSON.stringify(r));
  return {
    manifest: {
      schema: EXPORT_SCHEMA, version: EXPORT_VERSION, generatedAt: opts.generatedAt, extension: { version: opts.extensionVersion },
      range: { from: opts.from, to: opts.to },
      layers: { ...L }, hashed: [...opts.hashed], link: opts.link, lens: { ...opts.lens }, recorded,
      scale: { bands: ["human", "light", "heavy", "ai"], cuts: [...SCORE_CUTS].map((c) => Math.round(c * 10_000) / 10_000), buckets: BUCKET_COUNT },
      names: { input: INPUT_KINDS, state: STATE_KINDS, ui: UI_EVENTS, arrival: ARRIVALS, exposure: ["all", "focused", "flung", "focused and flung"] },
      rows: Object.fromEntries(Object.entries(out).map(([name, t]) => [name, t.rows.length])),
      dictionary: Object.fromEntries(Object.keys(out).map((name) => [name, TABLES[name] ?? { description: "", columns: [] }])),
    },
    tables: out,
  };
}

/** The finest layer kept at or above `layer`: never finer than what was recorded. */
function placeAt(places: VisitRow["places"], layer: Layer<"place">): string | undefined {
  if (!places || layer === "none") return undefined;
  for (const l of PLACES.slice(PLACES.indexOf(layer as typeof PLACES[number]))) if (places[l] !== undefined) return places[l];
  return undefined;
}

function family(value: string | undefined): string | undefined {
  return value?.split(" ")[0];
}

function streamName(stream: object, s: EventChunk["streams"]): string {
  for (const [name, value] of Object.entries(s)) if (value === stream) return name;
  return "events";
}

const r1 = (x: number): number => Math.round(x * 10) / 10;
function tallyOut(t: VisitRow["tally"]): Record<string, unknown> {
  return { scored: t.scored, expected: t.expected.map(r1), units: [...t.units], argmax: [...(t.argmax ?? [0, 0, 0, 0])],
    short: t.short, language: t.language, unavailable: t.unavailable, removed: t.removed ?? 0 };
}

function uniqueBy<T>(list: T[], key: (t: T) => string): T[] {
  const seen = new Set<string>();
  return list.filter((t) => { const k = key(t); if (seen.has(k)) return false; seen.add(k); return true; });
}

/** 32 sixteen-bit masks from the file's key: the same text has the same sketch within the file,
 *  and none of another file's. */
function sketchMask(key: Uint8Array): number[] {
  const hex = keyedHash(key, "sketch mask 0") + keyedHash(key, "sketch mask 1") + keyedHash(key, "sketch mask 2") + keyedHash(key, "sketch mask 3")
    + keyedHash(key, "sketch mask 4") + keyedHash(key, "sketch mask 5") + keyedHash(key, "sketch mask 6") + keyedHash(key, "sketch mask 7");
  return Array.from({ length: 32 }, (_, i) => parseInt(hex.slice(i * 4, i * 4 + 4), 16));
}
function masked(sketch: string, mask: number[]): string {
  const bytes = Uint8Array.from(atob(sketch.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  for (let s = 0; s * 2 + 1 < bytes.length; s++) {
    const v = ((bytes[s * 2]! << 8) | bytes[s * 2 + 1]!) ^ (mask[s] ?? 0);
    bytes[s * 2] = v >> 8; bytes[s * 2 + 1] = v & 255;
  }
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Rows as columns and arrays: nested objects flattened to dotted columns, the dictionary's
 *  order first; a column nobody has a value in is left out. */
function flatten(row: Record<string, unknown>, prefix = "", out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(row)) {
    if (v === undefined) continue;
    const name = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) flatten(v as Record<string, unknown>, name, out);
    else out[name] = v;
  }
  return out;
}
function columnar(name: string, rows: Record<string, unknown>[]): Table {
  const flat = rows.map((r) => flatten(r));
  const order = (TABLES[name]?.columns ?? []).map((c) => c.column);
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const r of flat) for (const c of Object.keys(r)) if (!seen.has(c)) { seen.add(c); columns.push(c); }
  const rankOf = (c: string): number => { const i = order.findIndex((o) => c === o || c.startsWith(`${o}.`)); return i < 0 ? order.length : i; };
  columns.sort((a, b) => rankOf(a) - rankOf(b));
  return { columns, rows: flat.map((r) => columns.map((c) => r[c] ?? null)) };
}

// ---- formats -------------------------------------------------------------------------------------------

export function exportJson(file: ExportFile): string {
  return JSON.stringify(file) + "\n";
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** Each table as CSV, and the manifest beside them. */
export function exportCsvFiles(file: ExportFile): { name: string; text: string }[] {
  return [
    { name: "manifest.json", text: JSON.stringify(file.manifest, null, 2) + "\n" },
    ...Object.entries(file.tables).map(([name, t]) => ({
      name: `${name}.csv`,
      text: [t.columns.map(csvCell).join(","), ...t.rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n",
    })),
  ];
}

/** What the export dialog shows before saving: rows per table, the first rows of each, and the
 *  file's size. */
export function preview(file: ExportFile, rows = 3): { tables: { name: string; rows: number; columns: string[]; first: unknown[][] }[]; bytes: number } {
  return {
    tables: Object.entries(file.tables).map(([name, t]) => ({ name, rows: t.rows.length, columns: t.columns, first: t.rows.slice(0, rows) })),
    bytes: new TextEncoder().encode(exportJson(file)).length,
  };
}
