// lib/stats/store.ts — the reading statistics on disk: IndexedDB `anagram-stats`, in the
// extension's own origin, which no page can open.
//
// The worker is the only writer of readings (lib/stats/worker.ts); the statistics page, the
// toolbar menu and Settings open the same database to read it, export it and clear it, as
// extension pages of the same origin may. No message carries the records anywhere.
//
// Four stores: `days` by date, `sites` by [date, site], `pages` by [date, key], and `meta`
// (when retention last ran). A day's records sort together under every key, so the oldest
// days are deleted with one key range per store.
import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import { applyReading, pageKey, type DayRecord, type PageRecord, type Reading, type SiteRecord } from "./record";
import type { StatsLevel } from "./model";

interface StatsDB extends DBSchema {
  days: { key: string; value: DayRecord };
  sites: { key: [string, string]; value: SiteRecord };
  pages: { key: [string, string]; value: PageRecord };
  meta: { key: string; value: unknown };
}

export const STATS_DB = "anagram-stats";
const STORES = ["days", "sites", "pages", "meta"] as const;

/** Everything recorded from one date to another, both included. */
export interface StatsRange {
  days: DayRecord[];
  sites: SiteRecord[];
  pages: PageRecord[];
}

export interface StatsStore {
  /** Add one message's reading at `level` (lib/stats/record.ts decides what is kept). */
  record(level: StatsLevel, reading: Reading): Promise<void>;
  read(from: string, to: string): Promise<StatsRange>;
  /** The day's totals alone: the toolbar menu's line. */
  day(date: string): Promise<DayRecord | undefined>;
  /** The first day anything is recorded for, or null: the month picker's start. */
  first(): Promise<string | null>;
  /** Delete every day before `date`. */
  prune(before: string): Promise<void>;
  clear(): Promise<void>;
  getMeta(key: string): Promise<unknown>;
  setMeta(key: string, value: unknown): Promise<void>;
}

let opened: Promise<IDBPDatabase<StatsDB>> | null = null;
function database(): Promise<IDBPDatabase<StatsDB>> {
  opened ??= openDB<StatsDB>(STATS_DB, 1, {
    upgrade(db) {
      db.createObjectStore("days", { keyPath: "date" });
      db.createObjectStore("sites", { keyPath: ["date", "site"] });
      db.createObjectStore("pages", { keyPath: ["date", "key"] });
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

/** [date] sorts before every [date, x], and [date, []] after every [date, "…"]: an array is
 *  greater than any string in IndexedDB's ordering. */
const daysOf = (from: string, to: string): IDBKeyRange => IDBKeyRange.bound([from], [to, []]);

export function openStatsStore(): StatsStore {
  return {
    async record(level, reading) {
      const db = await database();
      const tx = db.transaction(["days", "sites", "pages"], "readwrite");
      const [day, site, page] = await Promise.all([
        tx.objectStore("days").get(reading.date),
        tx.objectStore("sites").get([reading.date, reading.site]),
        tx.objectStore("pages").get([reading.date, pageKey(reading.url, reading.title)]),
      ]);
      const next = applyReading(level, reading, { day, site, page });
      const writes: Promise<unknown>[] = [];
      if (next.day) writes.push(tx.objectStore("days").put(next.day));
      if (next.site) writes.push(tx.objectStore("sites").put(next.site));
      if (next.page) writes.push(tx.objectStore("pages").put(next.page));
      await Promise.all([...writes, tx.done]);
    },
    async read(from, to) {
      const db = await database();
      const tx = db.transaction(["days", "sites", "pages"], "readonly");
      const [days, sites, pages] = await Promise.all([
        tx.objectStore("days").getAll(IDBKeyRange.bound(from, to)),
        tx.objectStore("sites").getAll(daysOf(from, to)),
        tx.objectStore("pages").getAll(daysOf(from, to)),
      ]);
      return { days, sites, pages };
    },
    async day(date) {
      return (await database()).get("days", date);
    },
    async first() {
      const cursor = await (await database()).transaction("days").store.openCursor();
      return cursor?.value.date ?? null;
    },
    async prune(before) {
      const db = await database();
      const tx = db.transaction(["days", "sites", "pages"], "readwrite");
      await Promise.all([
        tx.objectStore("days").delete(IDBKeyRange.upperBound(before, true)),
        tx.objectStore("sites").delete(IDBKeyRange.upperBound([before], true)),
        tx.objectStore("pages").delete(IDBKeyRange.upperBound([before], true)),
        tx.done,
      ]);
    },
    async clear() {
      const db = await database();
      const tx = db.transaction([...STORES], "readwrite");
      await Promise.all([...STORES.map((name) => tx.objectStore(name).clear()), tx.done]);
    },
    async getMeta(key) {
      return (await database()).get("meta", key);
    },
    async setMeta(key, value) {
      await (await database()).put("meta", value, key);
    },
  };
}
