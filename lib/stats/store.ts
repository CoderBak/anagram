// lib/stats/store.ts — the reading log on disk: IndexedDB `anagram-stats`, in the extension's
// own origin, which no page can open.
//
// The worker is the only writer of readings (lib/stats/worker.ts); the statistics page, the
// toolbar menu and Settings open the same database to read it, export it and clear it, as
// extension pages of the same origin may. No message carries the log anywhere.
//
// Stores, each with the day its rows belong to (what retention and the views go by):
//   visits   one per visit                      key id
//   units    one per paragraph of a visit       key [visit, n]
//   events   a visit's event streams, in chunks key [visit, seq]
//   texts    the text of a paragraph, once      key hash
//   totals   per day, kind, site and page       key [date, scope, key]
//   tabs     window and tab events              key auto
//   context  what the log was recorded under    key auto
//   meta     the hash secret's place, retention's last run
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { addTally, emptyTally, type ContextRow, type EventChunk, type TabEvent, type Tally, type TotalRow, type UnitRow, type VisitRow } from "./model";

export interface TextRow { hash: string; text: string; first: string; last: string }

interface LogDB extends DBSchema {
  visits: { key: string; value: VisitRow; indexes: { date: string } };
  units: { key: [string, number]; value: UnitRow; indexes: { date: string } };
  events: { key: [string, number]; value: EventChunk; indexes: { date: string } };
  texts: { key: string; value: TextRow; indexes: { last: string } };
  totals: { key: [string, string, string]; value: TotalRow };
  tabs: { key: number; value: TabEvent; indexes: { date: string } };
  context: { key: number; value: ContextRow; indexes: { date: string } };
  meta: { key: string; value: unknown };
}

export const STATS_DB = "anagram-stats";
const VERSION = 2;
const STORES = ["visits", "units", "events", "texts", "totals", "tabs", "context", "meta"] as const;

/** Everything recorded from one date to another, both included. */
export interface LogRange {
  visits: VisitRow[];
  units: UnitRow[];
  totals: TotalRow[];
}

/** One message's writes, made together. */
export interface LogWrite {
  visit?: VisitRow;
  units?: UnitRow[];
  events?: EventChunk;
  texts?: { hash: string; text: string; date: string }[];
  /** Tallies to add to totals, with what a page's total also notes. */
  totals?: { date: string; scope: TotalRow["scope"]; key: string; tally: Tally; title?: string; start?: string; dwell?: number; kind?: TotalRow["kind"]; models?: TotalRow["models"]; hashed?: boolean }[];
}

export interface LogStore {
  visit(id: string): Promise<VisitRow | undefined>;
  write(w: LogWrite): Promise<void>;
  tab(event: TabEvent): Promise<void>;
  context(row: ContextRow): Promise<void>;
  /** Visits, paragraphs and totals from `from` to `to`; paragraphs only when asked. */
  read(from: string, to: string, opts?: { units?: boolean }): Promise<LogRange>;
  /** The events of some visits, the texts of some hashes, the tab events and context of a range. */
  events(visits: readonly string[]): Promise<EventChunk[]>;
  /** One visit's paragraphs. */
  unitsOf(visit: string): Promise<UnitRow[]>;
  texts(hashes: readonly string[]): Promise<TextRow[]>;
  tabs(from: string, to: string): Promise<TabEvent[]>;
  contexts(from: string, to: string): Promise<ContextRow[]>;
  /** A day's totals alone: the toolbar menu's line. */
  day(date: string): Promise<TotalRow | undefined>;
  /** The first day anything is recorded for, or null. */
  first(): Promise<string | null>;
  /** Delete, before each date: events and tab events; visits and paragraphs (and texts no
   *  longer read since); totals and context (null keeps them). */
  prune(before: { fine: string; detail: string; totals: string | null }): Promise<void>;
  /** How much the log holds, in rows by store, and roughly in bytes. */
  size(): Promise<{ rows: Record<string, number>; bytes: number | null }>;
  /** Strip what a coarser configuration would not hold from what is kept (`strip` returns the
   *  row as that configuration would have it, or null to delete it). */
  rewrite(strip: { visit(v: VisitRow): VisitRow | null; unit(u: UnitRow): UnitRow | null; events: boolean; texts: boolean; tabs: boolean }): Promise<void>;
  clear(): Promise<void>;
  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
}

let opened: Promise<IDBPDatabase<LogDB>> | null = null;
function database(): Promise<IDBPDatabase<LogDB>> {
  opened ??= openDB<LogDB>(STATS_DB, VERSION, {
    upgrade(db, from) {
      // Version 1 (days, sites, pages) was never released: it gives way to the log.
      if (from < 2) for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name as never);
      db.createObjectStore("visits", { keyPath: "id" }).createIndex("date", "date");
      db.createObjectStore("units", { keyPath: ["visit", "n"] }).createIndex("date", "date");
      db.createObjectStore("events", { keyPath: ["visit", "seq"] }).createIndex("date", "date");
      db.createObjectStore("texts", { keyPath: "hash" }).createIndex("last", "last");
      db.createObjectStore("totals", { keyPath: ["date", "scope", "key"] });
      db.createObjectStore("tabs", { autoIncrement: true }).createIndex("date", "date");
      db.createObjectStore("context", { autoIncrement: true }).createIndex("date", "date");
      db.createObjectStore("meta");
    },
    // Another page of the extension holds an older version open: let go, and open afresh next time.
    blocking() {
      void opened?.then((db) => db.close());
      opened = null;
    },
  }).catch((error: unknown) => {
    opened = null;
    throw error;
  });
  return opened;
}

/** The database if it is there: reading the log never makes one. A page that only looks
 *  (Settings, the statistics page, the toolbar menu) leaves no database behind while nothing
 *  is recorded. */
async function existing(): Promise<IDBPDatabase<LogDB> | null> {
  if (opened) return opened;
  try {
    const all = await indexedDB.databases?.();
    if (all && !all.some((d) => d.name === STATS_DB)) return null;
  } catch { /* unknown: open it */ }
  return database();
}

const dates = (from: string, to: string): IDBKeyRange => IDBKeyRange.bound(from, to);
/** [date] sorts before every [date, …], and [date, []] after: an array is greater than any
 *  string in IndexedDB's ordering. */
const totalsOf = (from: string, to: string): IDBKeyRange => IDBKeyRange.bound([from], [to, []]);

export function openStatsStore(): LogStore {
  return {
    async visit(id) {
      return (await existing())?.get("visits", id);
    },
    async write(w) {
      const db = await database();
      const tx = db.transaction(["visits", "units", "events", "texts", "totals"], "readwrite");
      const ops: Promise<unknown>[] = [];
      if (w.visit) ops.push(tx.objectStore("visits").put(w.visit));
      for (const u of w.units ?? []) {
        const store = tx.objectStore("units");
        ops.push(store.get([u.visit, u.n]).then((had) => store.put(mergeUnit(had, u))));
      }
      if (w.events) ops.push(tx.objectStore("events").put(w.events));
      for (const t of w.texts ?? []) {
        const store = tx.objectStore("texts");
        ops.push(store.get(t.hash).then((had) => store.put({ hash: t.hash, text: t.text, first: had?.first ?? t.date, last: t.date })));
      }
      for (const t of w.totals ?? []) {
        const store = tx.objectStore("totals");
        ops.push(store.get([t.date, t.scope, t.key]).then((had) => store.put(mergeTotal(had, t))));
      }
      await Promise.all([...ops, tx.done]);
    },
    async tab(event) {
      await (await database()).add("tabs", event);
    },
    async context(row) {
      await (await database()).add("context", row);
    },
    async read(from, to, opts = {}) {
      const db = await existing();
      if (!db) return { visits: [], units: [], totals: [] };
      const tx = db.transaction(["visits", "units", "totals"], "readonly");
      const [visits, units, totals] = await Promise.all([
        tx.objectStore("visits").index("date").getAll(dates(from, to)),
        opts.units ? tx.objectStore("units").index("date").getAll(dates(from, to)) : Promise.resolve([]),
        tx.objectStore("totals").getAll(totalsOf(from, to)),
      ]);
      return { visits, units, totals };
    },
    async events(visits) {
      const db = await existing();
      if (!db) return [];
      const tx = db.transaction("events");
      const all = await Promise.all(visits.map((id) => tx.store.getAll(IDBKeyRange.bound([id, 0], [id, Infinity]))));
      return all.flat();
    },
    async unitsOf(visit) {
      return (await existing())?.getAll("units", IDBKeyRange.bound([visit, 0], [visit, Infinity])) ?? [];
    },
    async texts(hashes) {
      const db = await existing();
      if (!db) return [];
      const tx = db.transaction("texts");
      return (await Promise.all(hashes.map((h) => tx.store.get(h)))).filter((t): t is TextRow => t !== undefined);
    },
    async tabs(from, to) {
      return (await existing())?.getAllFromIndex("tabs", "date", dates(from, to)) ?? [];
    },
    async contexts(from, to) {
      return (await existing())?.getAllFromIndex("context", "date", dates(from, to)) ?? [];
    },
    async day(date) {
      return (await existing())?.get("totals", [date, "day", ""]);
    },
    async first() {
      const db = await existing();
      const cursor = db ? await db.transaction("totals").store.openCursor() : null;
      return cursor?.value.date ?? null;
    },
    async prune(before) {
      const db = await existing();
      if (!db) return;
      const tx = db.transaction(["visits", "units", "events", "texts", "totals", "tabs", "context"], "readwrite");
      const below = (date: string) => IDBKeyRange.upperBound(date, true);
      const drop = async (store: "visits" | "units" | "events" | "tabs" | "context", date: string) => {
        for (let c = await tx.objectStore(store).index("date").openCursor(below(date)); c; c = await c.continue()) await c.delete();
      };
      const ops: Promise<unknown>[] = [drop("events", before.fine), drop("tabs", before.fine), drop("visits", before.detail), drop("units", before.detail)];
      ops.push((async () => {
        for (let c = await tx.objectStore("texts").index("last").openCursor(below(before.detail)); c; c = await c.continue()) await c.delete();
      })());
      if (before.totals) {
        ops.push(tx.objectStore("totals").delete(IDBKeyRange.upperBound([before.totals], true)), drop("context", before.totals));
      }
      await Promise.all([...ops, tx.done]);
    },
    async size() {
      const db = await existing();
      if (!db) return { rows: {}, bytes: 0 };
      const rows: Record<string, number> = {};
      for (const name of STORES) rows[name] = await db.count(name);
      let bytes: number | null = null;
      try { bytes = (await navigator.storage.estimate()).usage ?? null; } catch { /* unknown */ }
      return { rows, bytes };
    },
    async rewrite(strip) {
      const db = await existing();
      if (!db) return;
      const tx = db.transaction(["visits", "units", "events", "texts", "tabs"], "readwrite");
      const ops: Promise<unknown>[] = [];
      ops.push((async () => {
        for (let c = await tx.objectStore("visits").openCursor(); c; c = await c.continue()) {
          const next = strip.visit(c.value);
          if (next) await c.update(next); else await c.delete();
        }
      })());
      ops.push((async () => {
        for (let c = await tx.objectStore("units").openCursor(); c; c = await c.continue()) {
          const next = strip.unit(c.value);
          if (next) await c.update(next); else await c.delete();
        }
      })());
      if (strip.events) ops.push(tx.objectStore("events").clear());
      if (strip.texts) ops.push(tx.objectStore("texts").clear());
      if (strip.tabs) ops.push(tx.objectStore("tabs").clear());
      await Promise.all([...ops, tx.done]);
    },
    async clear() {
      const db = await existing();
      if (!db) return;
      const tx = db.transaction([...STORES], "readwrite");
      await Promise.all([...STORES.map((name) => tx.objectStore(name).clear()), tx.done]);
    },
    async getMeta(key) {
      return (await existing())?.get("meta", key);
    },
    async setMeta(key, value) {
      await (await database()).put("meta", value, key);
    },
  };
}

/** A paragraph's row again: what only its first snapshot carried (its text, and so its hash,
 *  sketch and first words) stays. */
export function mergeUnit(had: UnitRow | undefined, u: UnitRow): UnitRow {
  if (!had) return u;
  return { ...u, hash: u.hash ?? had.hash, sketch: u.sketch ?? had.sketch, head: u.head ?? had.head };
}

/** A total with a tally added: a page's keeps its first start and title, and adds its dwell. */
export function mergeTotal(had: TotalRow | undefined, t: NonNullable<LogWrite["totals"]>[number]): TotalRow {
  const row: TotalRow = had ? structuredClone(had) : { date: t.date, scope: t.scope, key: t.key, tally: emptyTally() };
  addTally(row.tally, t.tally);
  if (t.title !== undefined) row.title = t.title;
  if (t.start !== undefined) row.start ??= t.start;
  if (t.dwell !== undefined) row.dwell = (row.dwell ?? 0) + t.dwell;
  if (t.kind !== undefined) row.kind ??= t.kind;
  if (t.hashed) row.hashed = true;
  for (const m of t.models ?? []) {
    row.models ??= [];
    if (!row.models.some((x) => x.id === m.id && x.ver === m.ver && x.calibration === m.calibration) && row.models.length < 4) row.models.push(m);
  }
  return row;
}

/** The same store in memory: what the tests drive the worker with. */
export function memoryStatsStore(): LogStore & { dump(): { visits: VisitRow[]; units: UnitRow[]; events: EventChunk[]; texts: TextRow[]; totals: TotalRow[]; tabs: TabEvent[]; context: ContextRow[] } } {
  const visits = new Map<string, VisitRow>(), units = new Map<string, UnitRow>(), events = new Map<string, EventChunk>();
  const texts = new Map<string, TextRow>(), totals = new Map<string, TotalRow>();
  const tabs: TabEvent[] = [], context: ContextRow[] = [];
  const meta = new Map<string, unknown>();
  const inRange = (d: string, from: string, to: string): boolean => d >= from && d <= to;
  return {
    async visit(id) { return structuredClone(visits.get(id)); },
    async write(w) {
      if (w.visit) visits.set(w.visit.id, structuredClone(w.visit));
      for (const u of w.units ?? []) units.set(`${u.visit} ${u.n}`, mergeUnit(units.get(`${u.visit} ${u.n}`), structuredClone(u)));
      if (w.events) events.set(`${w.events.visit} ${w.events.seq}`, structuredClone(w.events));
      for (const t of w.texts ?? []) texts.set(t.hash, { hash: t.hash, text: t.text, first: texts.get(t.hash)?.first ?? t.date, last: t.date });
      for (const t of w.totals ?? []) {
        const key = `${t.date} ${t.scope} ${t.key}`;
        totals.set(key, mergeTotal(totals.get(key), t));
      }
    },
    async tab(event) { tabs.push(structuredClone(event)); },
    async context(row) { context.push(structuredClone(row)); },
    async read(from, to, opts = {}) {
      return {
        visits: [...visits.values()].filter((v) => inRange(v.date, from, to)),
        units: opts.units ? [...units.values()].filter((u) => inRange(u.date, from, to)) : [],
        totals: [...totals.values()].filter((t) => inRange(t.date, from, to)),
      };
    },
    async events(ids) { return [...events.values()].filter((e) => ids.includes(e.visit)).sort((a, b) => a.seq - b.seq); },
    async unitsOf(visit) { return [...units.values()].filter((u) => u.visit === visit).sort((a, b) => a.n - b.n); },
    async texts(hashes) { return hashes.map((h) => texts.get(h)).filter((t): t is TextRow => t !== undefined); },
    async tabs(from, to) { return tabs.filter((t) => inRange(t.date, from, to)); },
    async contexts(from, to) { return context.filter((c) => inRange(c.date, from, to)); },
    async day(date) { return totals.get(`${date} day `); },
    async first() { return [...totals.values()].map((t) => t.date).sort()[0] ?? null; },
    async prune(before) {
      for (const [k, e] of events) if (e.date < before.fine) events.delete(k);
      for (let i = tabs.length - 1; i >= 0; i--) if (tabs[i]!.date < before.fine) tabs.splice(i, 1);
      for (const [k, v] of visits) if (v.date < before.detail) visits.delete(k);
      for (const [k, u] of units) if (u.date < before.detail) units.delete(k);
      for (const [k, t] of texts) if (t.last < before.detail) texts.delete(k);
      if (before.totals) {
        for (const [k, t] of totals) if (t.date < before.totals) totals.delete(k);
        for (let i = context.length - 1; i >= 0; i--) if (context[i]!.date < before.totals) context.splice(i, 1);
      }
    },
    async size() { return { rows: { visits: visits.size, units: units.size, events: events.size, texts: texts.size, totals: totals.size, tabs: tabs.length, context: context.length }, bytes: null }; },
    async rewrite(strip) {
      for (const [k, v] of visits) { const next = strip.visit(v); if (next) visits.set(k, next); else visits.delete(k); }
      for (const [k, u] of units) { const next = strip.unit(u); if (next) units.set(k, next); else units.delete(k); }
      if (strip.events) events.clear();
      if (strip.texts) texts.clear();
      if (strip.tabs) tabs.length = 0;
    },
    async clear() { visits.clear(); units.clear(); events.clear(); texts.clear(); totals.clear(); tabs.length = 0; context.length = 0; meta.clear(); },
    async getMeta(key) { return meta.get(key); },
    async setMeta(key, value) { meta.set(key, value); },
    dump: () => ({ visits: [...visits.values()], units: [...units.values()], events: [...events.values()], texts: [...texts.values()], totals: [...totals.values()], tabs: [...tabs], context: [...context] }),
  };
}
