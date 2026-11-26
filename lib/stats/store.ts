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
import { addTally, emptyTally, indexHashedPlaces, readingDay, type HashedPlaces, type PlaceLayerKey, type ContextRow, type EventChunk, type TabEvent, type Tally, type TotalRow, type UnitRow, type VisitRow } from "./model";

export interface TextRow { hash: string; text: string; first: string; last: string }

interface LogDB extends DBSchema {
  visits: { key: string; value: VisitRow; indexes: { date: string } };
  units: { key: [string, number]; value: UnitRow; indexes: { date: string; readDate: string } };
  events: { key: [string, number]; value: EventChunk; indexes: { date: string } };
  texts: { key: string; value: TextRow; indexes: { last: string } };
  totals: { key: [string, string, string]; value: TotalRow };
  tabs: { key: number; value: TabEvent; indexes: { date: string } };
  context: { key: number; value: ContextRow; indexes: { date: string } };
  meta: { key: string; value: unknown };
}

export const STATS_DB = "anagram-stats";
const VERSION = 4;
const CLEARED = "clearedAt";
const REWRITTEN = "rewrittenAt";
function stale(time: number | undefined, cutoff: unknown): boolean {
  return time !== undefined && typeof cutoff === "number" && time <= cutoff;
}
const STORES = ["visits", "units", "events", "texts", "totals", "tabs", "context", "meta"] as const;

interface Rewrite {
  visit(v: VisitRow): VisitRow | null;
  unit(u: UnitRow): UnitRow | null;
  /** Called after visit() has seen every original visit, in the same transaction. */
  totals(rows: TotalRow[]): TotalRow[];
  events(e: EventChunk): EventChunk | null;
  tabs(e: TabEvent): TabEvent | null;
  context(c: ContextRow): ContextRow | null;
  texts: boolean;
}

/** Everything recorded from one date to another, both included. */
export interface LogRange {
  visits: VisitRow[];
  units: UnitRow[];
  totals: TotalRow[];
}

/** One message's writes, made together. */
export interface LogWrite {
  started?: number;
  preparedAt?: number;
  visit?: VisitRow;
  units?: UnitRow[];
  /** Default reads delivered after the visit's opening day, sometimes in a separate packet. */
  counted?: { visit: string; date: string; units: number[] };
  events?: EventChunk;
  texts?: { hash: string; text: string; date: string }[];
  /** Tallies to add to totals, with what a page's total also notes. */
  totals?: TotalRow[];
}

export interface LogStore {
  visit(id: string): Promise<VisitRow | undefined>;
  write(w: LogWrite): Promise<void>;
  tab(event: TabEvent, observedAt?: number): Promise<void>;
  context(row: ContextRow, fingerprint?: string, observedAt?: number): Promise<void>;
  /** Visits, paragraphs and totals from `from` to `to`; paragraphs only when asked. */
  read(from: string, to: string, opts?: { units?: boolean; visits?: boolean; byReadDate?: boolean }): Promise<LogRange>;
  /** The events of some visits, the texts of some hashes, the tab events and context of a range. */
  events(visits: readonly string[]): Promise<EventChunk[]>;
  hasEvents(visit: string): Promise<boolean>;
  /** One visit's paragraphs. */
  unitsOf(visit: string): Promise<UnitRow[]>;
  hashedPlaces(keys: ReadonlyMap<string, PlaceLayerKey>): Promise<HashedPlaces>;
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
  /** Counts of reading-log rows only, excluding housekeeping metadata. */
  size(): Promise<{ rows: Record<string, number> }>;
  /** Strip what a coarser configuration would not hold from what is kept (`strip` returns the
   *  row as that configuration would have it, or null to delete it). */
  rewrite(strip: Rewrite): Promise<void>;
  clear(): Promise<void>;
  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
}

let opened: Promise<IDBPDatabase<LogDB>> | null = null;
function database(): Promise<IDBPDatabase<LogDB>> {
  opened ??= openDB<LogDB>(STATS_DB, VERSION, {
    upgrade(db, from, _to, tx) {
      if (from < 2) {
        // Version 1 was the unreleased, aggregate-only prototype.
        for (const name of [...db.objectStoreNames]) db.deleteObjectStore(name as never);
        db.createObjectStore("visits", { keyPath: "id" }).createIndex("date", "date");
        db.createObjectStore("units", { keyPath: ["visit", "n"] }).createIndex("date", "date");
        db.createObjectStore("events", { keyPath: ["visit", "seq"] }).createIndex("date", "date");
        db.createObjectStore("texts", { keyPath: "hash" }).createIndex("last", "last");
        db.createObjectStore("totals", { keyPath: ["date", "scope", "key"] });
        db.createObjectStore("tabs", { autoIncrement: true }).createIndex("date", "date");
        db.createObjectStore("context", { autoIncrement: true }).createIndex("date", "date");
        db.createObjectStore("meta");
      }
      const units = tx.objectStore("units");
      if (from < 3) units.createIndex("readDate", "readDate");
      if (from === 2) {
        // Unit keys group a visit's paragraphs together. Read its timing once, and
        // backfill in the upgrade transaction so a failed upgrade leaves v2 intact.
        void (async () => {
          let visit: VisitRow | undefined;
          for (let cursor = await units.openCursor(); cursor; cursor = await cursor.continue()) {
            const u = cursor.value;
            if (visit?.id !== u.visit) visit = await tx.objectStore("visits").get(u.visit);
            await cursor.update({ ...u, readDate: readingDay(u, visit) });
          }
        })().catch(() => { try { tx.abort(); } catch { /* the failed request already aborted it */ } });
      }
      if (from >= 2 && from < 4) {
        // A visit that supplies an older page's host may have opened before the
        // selected period. Recover that link while its retained hashes still exist.
        void (async () => {
          let hosts: Map<string, string> | undefined;
          for (let c = await tx.objectStore("totals").openCursor(); c; c = await c.continue()) {
            const t = c.value;
            if (t.scope !== "page" || !t.hashed || t.siteHash !== undefined || t.key.startsWith("file:")) continue;
            if (!hosts) {
              hosts = new Map();
              for (let v = await tx.objectStore("visits").openCursor(); v; v = await v.continue()) {
                const visit = v.value, host = visit.places?.host ?? visit.site;
                if (!host || !visit.hashed?.includes("place")) continue;
                if (visit.url) hosts.set(visit.url, host);
                for (const address of Object.values(visit.places ?? {})) hosts.set(address, host);
              }
              if (!hosts.size) break;
            }
            const siteHash = hosts.get(t.key);
            if (siteHash !== undefined) await c.update({ ...t, siteHash });
          }
        })().catch(() => { try { tx.abort(); } catch { /* the failed request already aborted it */ } });
      }
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
      const tx = db.transaction(["meta", "visits", "units", "events", "texts", "totals"], "readwrite");
      const meta = tx.objectStore("meta");
      if (stale(w.started, await meta.get(CLEARED)) || stale(w.preparedAt, await meta.get(REWRITTEN))) { await tx.done; return; }
      const ops: Promise<unknown>[] = [];
      if (w.visit) ops.push(tx.objectStore("visits").put(w.visit));
      const units = tx.objectStore("units");
      const counted = new Set(w.counted?.units);
      for (const u of w.units ?? []) {
        const reported = counted.delete(u.n) ? w.counted?.date : undefined;
        ops.push(units.get([u.visit, u.n]).then((had) =>
          units.put(mergeUnit(had, { ...u, readDate: readingDay(u, w.visit) }, reported))));
      }
      if (w.counted) for (const n of counted) {
        const { visit, date } = w.counted;
        ops.push(units.get([visit, n]).then((u) => u && units.put({ ...u, readDate: date })));
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
    async tab(event, observedAt = event.at) {
      const tx = (await database()).transaction(["meta", "tabs"], "readwrite");
      if (!stale(observedAt, await tx.objectStore("meta").get(CLEARED)) && !stale(observedAt, await tx.objectStore("meta").get(REWRITTEN))) await tx.objectStore("tabs").add(event);
      await tx.done;
    },
    async context(row, fingerprint, observedAt = row.at) {
      const tx = (await database()).transaction(["meta", "context"], "readwrite");
      const meta = tx.objectStore("meta");
      if (!stale(observedAt, await meta.get(CLEARED)) && !stale(observedAt, await meta.get(REWRITTEN)) &&
          (fingerprint === undefined || await meta.get("context") !== fingerprint)) {
        await tx.objectStore("context").add(row);
        if (fingerprint !== undefined) await meta.put(fingerprint, "context");
      }
      await tx.done;
    },
    async read(from, to, opts = {}) {
      const db = await existing();
      if (!db) return { visits: [], units: [], totals: [] };
      const tx = db.transaction(["visits", "units", "totals"], "readonly");
      const [visits, units, totals] = await Promise.all([
        opts.visits === false ? [] as VisitRow[] : tx.objectStore("visits").index("date").getAll(dates(from, to)),
        opts.units ? tx.objectStore("units").index(opts.byReadDate ? "readDate" : "date").getAll(dates(from, to)) : Promise.resolve([]),
        tx.objectStore("totals").getAll(totalsOf(from, to)),
      ]);
      if (opts.byReadDate && opts.visits !== false) {
        const present = new Set(visits.map((v) => v.id));
        const extra = new Set(units.filter((u) => !present.has(u.visit)).map((u) => u.visit));
        for (const v of await Promise.all([...extra].map((id) => tx.objectStore("visits").get(id)))) {
          if (v) visits.push(v);
        }
      }
      return { visits, units, totals };
    },
    async events(visits) {
      const db = await existing();
      if (!db) return [];
      const tx = db.transaction("events");
      const all = await Promise.all(visits.map((id) => tx.store.getAll(IDBKeyRange.bound([id, 0], [id, Infinity]))));
      return all.flat();
    },
    async hasEvents(visit) {
      const db = await existing();
      return !!db && (await db.getKey("events", IDBKeyRange.bound([visit, 0], [visit, Infinity]))) !== undefined;
    },
    async unitsOf(visit) {
      return (await existing())?.getAll("units", IDBKeyRange.bound([visit, 0], [visit, Infinity])) ?? [];
    },
    async hashedPlaces(keys) {
      const found: HashedPlaces = new Map();
      if (!keys.size) return found;
      const db = await existing();
      if (!db) return found;
      for (let c = await db.transaction("visits").store.openCursor(); c; c = await c.continue()) {
        indexHashedPlaces(found, c.value, keys);
        if (found.size === keys.size) break;
      }
      return found;
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
      if (!db) return { rows: {} };
      const rows: Record<string, number> = {};
      for (const name of STORES) if (name !== "meta") rows[name] = await db.count(name);
      return { rows };
    },
    async rewrite(strip) {
      const db = await existing();
      if (!db) return;
      const tx = db.transaction([...STORES], "readwrite");
      const ops: Promise<unknown>[] = [];
      const visitsRewritten = (async () => {
        for (let c = await tx.objectStore("visits").openCursor(); c; c = await c.continue()) {
          const next = strip.visit(c.value);
          if (next) await c.update(next); else await c.delete();
        }
      })();
      ops.push((async () => {
        for (let c = await tx.objectStore("units").openCursor(); c; c = await c.continue()) {
          const next = strip.unit(c.value);
          if (next) await c.update(next); else await c.delete();
        }
      })());
      for (const name of ["events", "tabs", "context"] as const) ops.push((async () => {
        const store = tx.objectStore(name);
        for (let c = await store.openCursor(); c; c = await c.continue()) {
          const next = name === "events" ? strip.events(c.value as EventChunk)
            : name === "tabs" ? strip.tabs(c.value as TabEvent) : strip.context(c.value as ContextRow);
          if (next) await c.update(next); else await c.delete();
        }
      })());
      ops.push((async () => {
        const store = tx.objectStore("totals");
        const [original] = await Promise.all([store.getAll(), visitsRewritten]);
        const rows = strip.totals(original);
        await store.clear();
        await Promise.all(rows.map((r) => store.put(r)));
      })());
      ops.push(tx.objectStore("meta").delete("context"), tx.objectStore("meta").put(Date.now(), REWRITTEN));
      if (strip.texts) ops.push(tx.objectStore("texts").clear());
      await Promise.all([...ops, tx.done]);
    },
    async clear() {
      const db = await database();
      const tx = db.transaction([...STORES], "readwrite");
      await Promise.all(STORES.map((name) => tx.objectStore(name).clear()));
      await tx.objectStore("meta").put(Date.now(), CLEARED);
      await tx.done;
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
export function mergeUnit(had: UnitRow | undefined, u: UnitRow, reported?: string): UnitRow {
  const readDate = reported ?? ((had?.expo?.read || had?.expo?.readAt !== undefined) ? had.readDate : undefined) ?? u.readDate;
  if (!had) return { ...u, readDate };
  return { ...u, readDate, hash: u.hash ?? had.hash, sketch: u.sketch ?? had.sketch, head: u.head ?? had.head };
}

/** A total with a tally added: a page's keeps its first start and title, and adds its dwell. */
export function mergeTotal(had: TotalRow | undefined, t: NonNullable<LogWrite["totals"]>[number]): TotalRow {
  const row: TotalRow = had ? structuredClone(had) : { date: t.date, scope: t.scope, key: t.key, tally: emptyTally() };
  addTally(row.tally, t.tally);
  if (t.title !== undefined) { row.title = t.title; row.titleHashed = t.titleHashed; row.titleLayer = t.titleLayer; }
  if (t.placeLayer) row.placeLayer = t.placeLayer;
  if (t.siteHash !== undefined) row.siteHash = t.siteHash;
  if (t.start !== undefined && (row.start === undefined ||
      (t.startDate ?? t.date) + t.start < (row.startDate ?? row.date) + row.start)) {
    row.start = t.start;
    row.startDate = t.startDate;
  }
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
      if (stale(w.started, meta.get(CLEARED)) || stale(w.preparedAt, meta.get(REWRITTEN))) return;
      if (w.visit) visits.set(w.visit.id, structuredClone(w.visit));
      const counted = new Set(w.counted?.units);
      for (const u of w.units ?? []) {
        const key = `${u.visit} ${u.n}`, reported = counted.delete(u.n) ? w.counted?.date : undefined;
        units.set(key, mergeUnit(units.get(key), { ...structuredClone(u), readDate: readingDay(u, w.visit) }, reported));
      }
      if (w.counted) for (const n of counted) {
        const u = units.get(`${w.counted.visit} ${n}`);
        if (u) u.readDate = w.counted.date;
      }
      if (w.events) events.set(`${w.events.visit} ${w.events.seq}`, structuredClone(w.events));
      for (const t of w.texts ?? []) texts.set(t.hash, { hash: t.hash, text: t.text, first: texts.get(t.hash)?.first ?? t.date, last: t.date });
      for (const t of w.totals ?? []) {
        const key = `${t.date} ${t.scope} ${t.key}`;
        totals.set(key, mergeTotal(totals.get(key), t));
      }
    },
    async tab(event, observedAt = event.at) { if (!stale(observedAt, meta.get(CLEARED)) && !stale(observedAt, meta.get(REWRITTEN))) tabs.push(structuredClone(event)); },
    async context(row, fingerprint, observedAt = row.at) {
      if (stale(observedAt, meta.get(CLEARED)) || stale(observedAt, meta.get(REWRITTEN)) || (fingerprint !== undefined && fingerprint === meta.get("context"))) return;
      context.push(structuredClone(row));
      if (fingerprint !== undefined) meta.set("context", fingerprint);
    },
    async read(from, to, opts = {}) {
      const selected = opts.units ? [...units.values()].filter((u) =>
        inRange(opts.byReadDate ? readingDay(u, visits.get(u.visit)) : u.date, from, to)) : [];
      const parents = new Set(opts.byReadDate ? selected.map((u) => u.visit) : []);
      return {
        visits: opts.visits === false ? [] : [...visits.values()].filter((v) => inRange(v.date, from, to) || parents.has(v.id)),
        units: selected,
        totals: [...totals.values()].filter((t) => inRange(t.date, from, to)),
      };
    },
    async events(ids) { return [...events.values()].filter((e) => ids.includes(e.visit)).sort((a, b) => a.seq - b.seq); },
    async hasEvents(visit) { return [...events.values()].some(chunk => chunk.visit === visit); },
    async unitsOf(visit) { return [...units.values()].filter((u) => u.visit === visit).sort((a, b) => a.n - b.n); },
    async hashedPlaces(keys) {
      const found: HashedPlaces = new Map();
      for (const v of visits.values()) {
        if (found.size === keys.size) break;
        indexHashedPlaces(found, v, keys);
      }
      return found;
    },
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
    async size() { return { rows: { visits: visits.size, units: units.size, events: events.size, texts: texts.size, totals: totals.size, tabs: tabs.length, context: context.length } }; },
    async rewrite(strip) {
      for (const [k, v] of visits) { const next = strip.visit(v); if (next) visits.set(k, next); else visits.delete(k); }
      for (const [k, u] of units) { const next = strip.unit(u); if (next) units.set(k, next); else units.delete(k); }
      const grouped = strip.totals([...totals.values()]);
      totals.clear();
      for (const t of grouped) totals.set(`${t.date} ${t.scope} ${t.key}`, t);
      for (const [k, e] of events) { const next = strip.events(e); if (next) events.set(k, next); else events.delete(k); }
      const rewriteList = <T>(rows: T[], apply: (row: T) => T | null): void => {
        for (let i = rows.length - 1; i >= 0; i--) { const next = apply(rows[i]!); if (next) rows[i] = next; else rows.splice(i, 1); }
      };
      rewriteList(tabs, strip.tabs);
      rewriteList(context, strip.context);
      meta.delete("context"); meta.set(REWRITTEN, Date.now());
      if (strip.texts) texts.clear();
    },
    async clear() { visits.clear(); units.clear(); events.clear(); texts.clear(); totals.clear(); tabs.length = 0; context.length = 0; meta.clear(); meta.set(CLEARED, Date.now()); },
    async getMeta(key) { return meta.get(key); },
    async setMeta(key, value) { meta.set(key, value); },
    dump: () => ({ visits: [...visits.values()], units: [...units.values()], events: [...events.values()], texts: [...texts.values()], totals: [...totals.values()], tabs: [...tabs], context: [...context] }),
  };
}
