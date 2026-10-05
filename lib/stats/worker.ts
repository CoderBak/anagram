// lib/stats/worker.ts — the worker's half of the reading log: what a page's recorder sends in,
// the log's rows out, at the layers the reader chose (lib/stats/config.ts).
//
// A page says what it read and how, and nothing else (STATS_RECORD, held to
// lib/stats/wire.ts's schema). WHERE it was read is the browser's to say: the site comes from
// the tab the browser names on the sender, the date from this worker's clock, and a private
// window from the tab's own flag. The address the recorder names (the one its visit began at,
// which a route change since has not moved) is taken only where its origin is the tab's or
// the frame's own. A private window's reading is never kept, nor a site the reader switched
// Anagram off for, even a page of it they asked for from the menu, nor Analyze text (its page
// may not send this message).
//
// Each message is coarsened to the configuration here, once: what a layer leaves out never
// reaches the disk. A text is hashed and sketched with the log's secret (lib/stats/hash.ts),
// which no page has. The totals by day, kind, site and page are the default lens's, added as
// paragraphs are counted.
import type { ModelInfo } from "../contract";
import { normalizeRuleHost } from "../settings/settings";
import { safePdfSource } from "../pdf/source";
import { MODEL_MIN_WORDS } from "../dom/text";
import { HASHABLE, rank, type Hashable, type Layer, type RecordingConfig } from "./config";
import { coarseDur, coarseLang, coarseLen, coarseTime, coarseTitle, coarseVerdict, placeLadder } from "./coarsen";
import { headOf, keyedHash, sketchOf } from "./hash";
import {
  addDays, addTally, argmaxOf, bandOf, emptyTally, localDate, localMinute, scoreOf, tallyOfRead,
  type Arrival, type EngineInfo, type EventChunk, type EventStreams, type Exposure, type Tally, type UnitRow, type VisitRow,
} from "./model";
import type { LogStore, LogWrite } from "./store";
import type { StatsWire, WireUnit } from "./wire";

export interface StatsSender {
  url?: string;
  frameId?: number;
  documentId?: string;
  tab?: { id?: number; windowId?: number; url?: string; title?: string; incognito?: boolean };
}

/** What the worker knows of tabs and windows (lib/stats/tabs.ts). */
export interface TabFacts {
  tabId(id: number): string;
  windowId(id: number): string;
  arrival(tab: number, frame: number): Arrival | undefined;
  /** The top visit a tab shows now, and the one before it; the visit its opener showed. */
  topVisit(tab: number): string | undefined;
  previousVisit(tab: number, visit: string): string | undefined;
  openerVisit(tab: number): string | undefined;
  /** A tab's top visit is `visit` from now (the recorder of its top frame said so). */
  noteTopVisit(tab: number, visit: string): void;
  /** Something of the tab was recorded just now: it is not uncovered. */
  covered(tab: number): void;
}

export interface StatsKeeperDeps {
  store: LogStore;
  config(): Promise<RecordingConfig>;
  /** Whether Anagram is on for this hostname by the reader's settings; for a PDF from this
   *  computer (no hostname) the global switch. */
  enabledFor(hostname: string | null): Promise<boolean>;
  model(): ModelInfo | null;
  engine(): Promise<EngineInfo | null>;
  secret(): Promise<Uint8Array>;
  tabs?: TabFacts;
  now?(): Date;
}

/** Where words were read: the address the visit is filed under, and the page whose words
 *  they count for (a frame's count for the page it is in, as its site rules do). */
interface Place {
  /** The visit's own address, or null for a file from this computer. */
  own: string | null;
  /** The page's (the tab's top-level address, or the PDF reader's document). */
  page: string | null;
  hostname: string | null;
}

/** An ordinary page: the tab's top-level address, http(s) only; the frame's own address. */
function pagePlace(wire: StatsWire, sender: StatsSender): Place | null {
  const top = httpUrl(sender.tab?.url);
  if (!top) return null;
  const frame = httpUrl(sender.url) ?? top;
  // The address the visit began at, from the recorder, where its origin is the document's own:
  // after a route change the tab already shows the next address.
  const claimed = httpUrl(wire.visit.href);
  const own = claimed && claimed.origin === frame.origin ? claimed : frame;
  const page = sender.frameId === 0 || sender.frameId === undefined ? own : top;
  return { own: own.href, page: page.href, hostname: top.hostname };
}

function httpUrl(address: string | undefined): URL | null {
  try {
    const url = new URL(address ?? "");
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** The PDF reader: the document it shows, by the `src` its own address carries; a file from
 *  this computer has no address. */
function readerPlace(readerAddress: string | undefined): Place {
  let src: URL | null = null;
  try {
    src = safePdfSource(new URL(readerAddress ?? "").searchParams.get("src") ?? "");
  } catch { /* no address: a file */ }
  if (!src || src.protocol === "file:") return { own: null, page: null, hostname: null };
  return { own: src.href, page: src.href, hostname: src.hostname };
}

const PRUNED = "pruned";
const PLACE_LAYERS = ["url", "nofragment", "querynames", "path", "pattern", "host", "domain"] as const;

export function createStatsKeeper(deps: StatsKeeperDeps) {
  const now = deps.now ?? (() => new Date());
  /** One message at a time: each is a read and a write of the same visit and totals. */
  let queue: Promise<unknown> = Promise.resolve();
  /** Which document a recorder's visit id belongs to: another document cannot add to it. */
  const owners = new Map<string, string>();

  let pruned = "";
  async function prune(today: string, config: RecordingConfig): Promise<void> {
    const r = config.retention;
    const mark = `${today} ${r.fine} ${r.detail} ${r.totals}`;
    if (pruned === mark) return;
    const last = await deps.store.getMeta(PRUNED);
    if (last !== mark) {
      await deps.store.prune({ fine: addDays(today, 1 - r.fine), detail: addDays(today, 1 - r.detail), totals: r.totals ? addDays(today, 1 - r.totals) : null });
      await deps.store.setMeta(PRUNED, mark);
    }
    pruned = mark;
  }

  return {
    /** Keep what a page read. Resolves to whether anything was kept; a page is never told why
     *  not (it is answered the same either way). */
    record(wire: StatsWire, sender: StatsSender, role: "content" | "reader"): Promise<boolean> {
      const run = queue.then(async () => {
        if (sender.tab?.incognito) return false;
        const config = await deps.config();
        if (!config.on) return false;
        const place = role === "reader" ? readerPlace(sender.url) : pagePlace(wire, sender);
        if (!place || !(await deps.enabledFor(place.hostname))) return false;
        // A visit id is its document's: the first to use it owns it.
        const owner = `${sender.tab?.id ?? "?"} ${sender.frameId ?? 0} ${sender.documentId ?? sender.url ?? ""}`;
        const had = owners.get(wire.visit.id);
        if (had !== undefined && had !== owner) return false;
        owners.set(wire.visit.id, owner);
        if (owners.size > 5000) owners.delete(owners.keys().next().value!);
        const today = localDate(now());
        await prune(today, config).catch(() => undefined);
        await keep(wire, sender, role, place, config);
        return true;
      });
      queue = run.catch(() => undefined);
      return run;
    },
  };

  async function keep(wire: StatsWire, sender: StatsSender, role: "content" | "reader", place: Place, config: RecordingConfig): Promise<void> {
    const L = config.layers;
    const hashed = (d: Hashable): boolean => config.hashed.includes(d);
    const needsSecret = hashed("place") || hashed("title") || L.text !== "none";
    const secret = needsSecret ? await deps.secret() : null;
    const hashOf = (value: string): string => keyedHash(secret!, value);
    const v = wire.visit;
    const date = localDate(new Date(v.start));
    const existing = await deps.store.visit(v.id);
    const tabId = sender.tab?.id;
    const dur = (ms: number | undefined): number | undefined => ms === undefined ? undefined : coarseDur(ms, L.dur) ?? undefined;
    const rowsAt = (layer: Layer<"rows">): boolean => rank("rows", L.rows) <= rank("rows", layer);

    // ---- the visit ------------------------------------------------------------------------------
    const ladder = place.own ? placeLadder(place.own) : null;
    const places: VisitRow["places"] = {};
    if (ladder && L.place !== "none") {
      for (const layer of PLACE_LAYERS.slice(PLACE_LAYERS.indexOf(L.place as typeof PLACE_LAYERS[number]))) {
        places[layer] = hashed("place") ? hashOf(ladder[layer]) : ladder[layer];
      }
    }
    const url = L.place !== "none" && rank("place", L.place) <= rank("place", "pattern") ? places[L.place as keyof typeof places] : undefined;
    const site = places.host ?? places.domain;
    const rawTitle = role === "reader" || sender.frameId === 0 || sender.frameId === undefined ? (sender.tab?.title ?? "").trim() : "";
    const titled = coarseTitle(rawTitle, L.title);
    const title = titled && hashed("title") ? hashOf(titled) : titled;
    const isTop = role === "reader" || v.frame === "top";
    if (tabId !== undefined && isTop && !existing && rowsAt("visit")) deps.tabs?.noteTopVisit(tabId, v.id);
    if (tabId !== undefined) deps.tabs?.covered(tabId);

    const row: VisitRow = {
      ...(existing ?? {}),
      id: v.id, date, start: coarseTime(v.start, L.time),
      frame: v.frame, kind: role === "reader" ? "document" : v.kind, surface: v.surface,
      shown: dur(v.shown) ?? 0, active: dur(v.active) ?? 0, focused: dur(v.focused) ?? 0,
      tally: existing?.tally ?? emptyTally(),
    };
    if (v.end !== undefined) row.end = coarseTime(v.end, L.time);
    if (v.ended) row.ended = v.ended;
    if (Object.keys(places).length) { row.places = places; row.url = url; row.site = site; }
    if (config.hashed.length) row.hashed = [...config.hashed];
    if (title !== undefined) row.title = title;
    if (tabId !== undefined && L.tabs !== "none") {
      row.tab = deps.tabs?.tabId(tabId);
      if (sender.tab?.windowId !== undefined) row.window = deps.tabs?.windowId(sender.tab.windowId);
    }
    if (v.frame === "frame" && tabId !== undefined) row.parent = deps.tabs?.topVisit(tabId);
    if (L.nav !== "none") {
      row.arrival = v.route ? "route" : v.restored ? "restored" : existing?.arrival ?? (tabId !== undefined ? deps.tabs?.arrival(tabId, sender.frameId ?? 0) : undefined);
      if (L.nav === "full" && tabId !== undefined && isTop) {
        row.previous ??= deps.tabs?.previousVisit(tabId, v.id);
        row.opener ??= deps.tabs?.openerVisit(tabId);
        const ref = v.referrer ? placeLadder(v.referrer) : null;
        if (ref && L.place !== "none") {
          const layer = L.place as typeof PLACE_LAYERS[number];
          row.referrer = hashed("place") ? hashOf(ref[layer]) : ref[layer];
        }
      }
    }
    if (L.struct === "full" && v.signals) row.signals = v.signals;
    if (L.geom !== "none") { row.height = v.height; row.width = v.width; }
    if (L.cover === "visit") { row.found = v.found; row.leftOut = v.leftOut; }
    if (v.display) row.display = v.display;
    if (v.pdf) row.pdf = v.pdf;
    if (L.scroll !== "none" && v.scroll) row.scroll = v.scroll;
    if (L.input !== "none" && v.idle) row.idle = v.idle.map(([a, b]) => [dur(a) ?? 0, dur(b) ?? 0]);
    if (L.input === "minutes" && v.minutes) row.minutes = v.minutes;
    if (L.ui !== "none" && v.ui) row.ui = v.ui;
    const model = deps.model();
    if (model) row.model = model;
    const engine = await deps.engine().catch(() => null);
    if (engine && L.engine !== "model") row.engine = L.engine === "full" ? engine : { kind: engine.kind };

    // ---- what was counted ------------------------------------------------------------------------
    const read: Tally = emptyTally();
    for (const r of wire.reads ?? []) addTally(read, tallyOfRead(r.w, r.p ? normalized(r.p) : null, r.why ?? null));
    addTally(row.tally, read);

    // ---- the paragraphs --------------------------------------------------------------------------
    const units: UnitRow[] = [];
    const texts: NonNullable<LogWrite["texts"]> = [];
    if (rowsAt("paragraph")) {
      for (const u of wire.units ?? []) units.push(unitRow(u, v.id, date, L, secret, texts));
    }

    // ---- the events --------------------------------------------------------------------------------
    let events: EventChunk | undefined;
    if (L.rows === "event" && wire.events && Object.keys(wire.events).length > 0) {
      events = { visit: v.id, seq: wire.seq, date, streams: coarseStreams(wire.events, L) };
    }

    // ---- totals --------------------------------------------------------------------------------------
    const totals: NonNullable<LogWrite["totals"]> = [];
    const shownDelta = isTop ? Math.round((v.dwell ?? 0) / 1000) : 0;
    const anything = (wire.reads?.length ?? 0) > 0;
    const models = model ? [model] : [];
    if (anything) {
      totals.push({ date, scope: "day", key: "", tally: read, models });
      totals.push({ date, scope: "kind", key: row.kind, tally: read });
    }
    // The page and the site the words count for: the tab's (a frame's words are its page's).
    const pagePlaces = place.page ? placeLadder(place.page) : null;
    if (rowsAt("site") && L.place !== "none") {
      const siteKey = pagePlaces ? (hashed("place") ? hashOf(pagePlaces.host) : pagePlaces[rank("place", L.place) <= rank("place", "host") ? "host" : "domain"]) : "";
      if (anything) totals.push({ date, scope: "site", key: siteKey, tally: read, ...(hashed("place") ? { hashed: true } : {}) });
    }
    if (rowsAt("page") && rank("place", L.place) <= rank("place", "pattern")) {
      const layer = L.place as typeof PLACE_LAYERS[number];
      const pageKey = pagePlaces ? (hashed("place") ? hashOf(pagePlaces[layer]) : pagePlaces[layer]) : `file:${rawTitle}`;
      if (anything || shownDelta > 0) {
        totals.push({
          date, scope: "page", key: pageKey, tally: read, kind: row.kind, ...(hashed("place") ? { hashed: true } : {}),
          ...(title !== undefined && isTop ? { title } : {}),
          ...(rank("time", L.time) <= rank("time", "min") ? { start: localMinute(new Date(v.start)) } : {}),
          ...(L.dur !== "none" && isTop ? { dwell: shownDelta } : {}),
        });
      }
    }

    const write: LogWrite = { totals, texts, units };
    if (rowsAt("visit")) write.visit = row;
    if (events) write.events = events;
    await deps.store.write(write);
  }
}

/** The probabilities as a distribution: what arrives sums to one within rounding. */
function normalized(p: readonly number[]): number[] {
  const sum = p.reduce((n, x) => n + x, 0);
  return sum > 0 ? p.map((x) => x / sum) : [0.25, 0.25, 0.25, 0.25];
}

function unitRow(u: WireUnit, visit: string, date: string, L: RecordingConfig["layers"], secret: Uint8Array | null, texts: NonNullable<LogWrite["texts"]>): UnitRow {
  const dur = (ms: number | undefined): number | undefined => ms === undefined ? undefined : coarseDur(ms, L.dur) ?? undefined;
  const row: UnitRow = { visit, n: u.n, date, status: u.status, found: dur(u.found) ?? 0 };
  if (u.removedAt !== undefined) row.removedAt = dur(u.removedAt);
  if (u.text !== undefined && secret && L.text !== "none") {
    row.hash = keyedHash(secret, u.text);
    if (rank("text", L.text) <= rank("text", "sketch")) row.sketch = sketchOf(secret, u.text);
    if (rank("text", L.text) <= rank("text", "head")) row.head = headOf(u.text);
    if (L.text === "full") texts.push({ hash: row.hash, text: u.text, date });
  }
  const words = u.len?.words ?? 0;
  const len = coarseLen({ ...(u.len ?? {}), words }, L.len);
  if (len) row.len = len;
  if (u.verdict?.p) {
    const p = normalized(u.verdict.p);
    const verdict = coarseVerdict({
      p: u.verdict.p, score: u.verdict.score ?? Math.round(scoreOf(p) * 10_000) / 10_000, band: bandOf(p), argmax: argmaxOf(p),
      flagged: u.verdict.flagged, doubt: words < MODEL_MIN_WORDS, truncated: u.verdict.truncated, tokens: u.len?.tokens,
    }, L.verdict);
    if (verdict) row.verdict = verdict;
  }
  if (u.lang) {
    const lang = coarseLang({ ...u.lang, english: u.lang.label === undefined ? undefined : u.lang.label === "en" }, L.lang);
    if (lang) row.lang = lang;
  }
  if (u.struct && L.struct !== "none" && L.struct !== "kind") {
    row.struct = L.struct === "full" ? u.struct : { unit: u.struct.unit, post: u.struct.post, order: u.struct.order, paragraphs: u.struct.paragraphs };
  }
  if (u.geom && L.geom !== "none") {
    row.geom = L.geom === "share" ? { share: u.geom.share, page: u.geom.page } : L.geom === "order" ? (u.geom.page !== undefined ? { page: u.geom.page } : undefined) : u.geom;
    if (!row.geom) delete row.geom;
  }
  if (u.expo && L.expo !== "none") {
    const e = (x: Exposure): Exposure => x.map((ms) => dur(ms) ?? 0) as Exposure;
    row.expo = L.expo === "read"
      ? { any: [0, 0, 0, 0], half: [0, 0, 0, 0], band: [0, 0, 0, 0], sightings: 0, readAt: dur(u.expo.readAt) }
      : { any: e(u.expo.any), half: e(u.expo.half), band: e(u.expo.band), sightings: u.expo.sightings, first: dur(u.expo.first), last: dur(u.expo.last), readAt: dur(u.expo.readAt) };
  }
  if (u.timing && L.engine !== "model") row.timing = L.engine === "full" ? { cached: u.timing.cached, answered: dur(u.timing.answered) } : { cached: u.timing.cached };
  return row;
}

/** The streams with their offsets at DUR's layer. */
function coarseStreams(s: EventStreams, L: RecordingConfig["layers"]): EventStreams {
  const d = (ms: number): number => coarseDur(ms, L.dur) ?? 0;
  const out: EventStreams = {};
  for (const [name, stream] of Object.entries(s) as [keyof EventStreams, Record<string, number[] | undefined>][]) {
    if (!stream) continue;
    const copy: Record<string, number[]> = {};
    for (const [column, values] of Object.entries(stream)) {
      if (!values) continue;
      copy[column] = column === "t" || column === "start" || column === "end" ? values.map(d) : [...values];
    }
    (out as Record<string, unknown>)[name] = copy;
  }
  return out;
}

export { HASHABLE };
