// lib/stats/record.ts — how one message of reading is added to the day it was read on.
//
// Pure: the worker hands it what is stored now and stores what comes back
// (lib/stats/store.ts), which keeps the rules — what each level keeps, the per-day bounds —
// checkable without IndexedDB (test/node/stats.test.ts).
import type { ModelInfo } from "../contract";
import {
  addTally,
  atLeast,
  emptyTally,
  finer,
  tallyOf,
  type PageKind,
  type ReadSkip,
  type ReadUnit,
  type StatsLevel,
  type Tally,
} from "./model";

/** A day's totals: every level keeps one per day. */
export interface DayRecord {
  date: string;
  /** The finest level anything of this day was recorded at: a day recorded by site in the
   *  morning and by day after that has site records for the morning only. */
  level: Exclude<StatsLevel, "off">;
  total: Tally;
  kinds: Partial<Record<PageKind, Tally>>;
  /** How many site and page records the day has — what the per-day bounds count. */
  siteCount: number;
  pageCount: number;
  /** The models that scored the day's reading and the minimum lengths in force: both change
   *  what the numbers mean, and either can change within a day. */
  models: ModelInfo[];
  minWords: number[];
}

/** A site's share of a day (level "sites" and up). The site is the host the tab showed,
 *  without a leading "www."; "" is a PDF from this computer. */
export interface SiteRecord {
  date: string;
  site: string;
  tally: Tally;
}

/** A page's share of a day (level "pages"). One record per address per day: a page read
 *  twice in a day keeps its first start and adds the rest. */
export interface PageRecord {
  date: string;
  /** What the record is stored under: the address, or "file:" and the title for a PDF from
   *  this computer, which has none. */
  key: string;
  /** Origin and path, never the query or the fragment; "" for a PDF from this computer. */
  url: string;
  title: string;
  /** When it was first read that day, "HH:MM". */
  start: string;
  /** Seconds the page was shown in front, with somebody reading. */
  dwell: number;
  kind: PageKind;
  tally: Tally;
}

/** One message's worth of reading, with everything the worker derived for it. */
export interface Reading {
  date: string;
  minute: string;
  site: string;
  url: string;
  title: string;
  kind: PageKind;
  dwell: number;
  units: readonly ReadUnit[];
  skipped: readonly ReadSkip[];
  model?: ModelInfo | null;
  minWords?: number | null;
}

/** A day keeps at most this many site and page records: past them its totals still count. */
export const MAX_SITES_PER_DAY = 1000;
export const MAX_PAGES_PER_DAY = 2000;
const MAX_NOTES = 4;
export const MAX_TITLE_CHARS = 200;

export function pageKey(url: string, title: string): string {
  return url || `file:${title}`;
}

export interface Records {
  day?: DayRecord;
  site?: SiteRecord;
  page?: PageRecord;
}

/** What the day, the site and the page hold once `reading` is added; only the records this
 *  level keeps come back, and none at all for a message with nothing read in it. */
export function applyReading(level: StatsLevel, reading: Reading, now: Records): Records {
  if (level === "off") return {};
  const read = tallyOf(reading.units, reading.skipped);
  const words = read.scored + read.short + read.language + read.unavailable;
  const out: Records = {};
  if (words > 0) {
    const day: DayRecord = now.day ? structuredClone(now.day) : {
      date: reading.date, level, total: emptyTally(), kinds: {}, siteCount: 0, pageCount: 0, models: [], minWords: [],
    };
    day.level = finer(day.level, level) as DayRecord["level"];
    addTally(day.total, read);
    addTally((day.kinds[reading.kind] ??= emptyTally()), read);
    note(day.models, reading.model);
    note(day.minWords, reading.minWords);
    out.day = day;
    if (atLeast(level, "sites") && (now.site || day.siteCount < MAX_SITES_PER_DAY)) {
      if (!now.site) day.siteCount++;
      const site = now.site ? structuredClone(now.site) : { date: reading.date, site: reading.site, tally: emptyTally() };
      addTally(site.tally, read);
      out.site = site;
    }
  }
  // A page is listed once something on it has been read; the time it was shown is added to
  // a page already listed, and is never a reason to list one.
  if (atLeast(level, "pages") && (words > 0 || now.page) && (now.page || (out.day?.pageCount ?? MAX_PAGES_PER_DAY) < MAX_PAGES_PER_DAY)) {
    if (!now.page) out.day!.pageCount++;
    const page: PageRecord = now.page ? structuredClone(now.page) : {
      date: reading.date, key: pageKey(reading.url, reading.title), url: reading.url, title: reading.title,
      start: reading.minute, dwell: 0, kind: reading.kind, tally: emptyTally(),
    };
    if (reading.title) page.title = reading.title.slice(0, MAX_TITLE_CHARS);
    page.dwell += reading.dwell;
    addTally(page.tally, read);
    out.page = page;
  }
  return out;
}

function note<T>(list: T[], value: T | null | undefined): void {
  if (value === null || value === undefined || list.length >= MAX_NOTES) return;
  const same = JSON.stringify(value);
  if (!list.some((v) => JSON.stringify(v) === same)) list.push(value);
}
