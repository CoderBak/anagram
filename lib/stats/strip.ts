// lib/stats/strip.ts — what is kept already, made as coarse as a new configuration: when the
// reader asks for less, Settings offers to delete what the new configuration would not have kept
// (LogStore.rewrite). Keeping it is the default; nothing here runs unless they choose to delete.
import { OFF, rank, type RecordingConfig } from "./config";
import { coarseDur, coarseLang, coarseLen, coarseTime, retainedTitle, coarseVerdict, type Lengths } from "./coarsen";
import { registrableDomain } from "../publicSuffixes";
import { groupTotals, projectTotal } from "./totals";
import { placeLadder, projectStreams, projectReferrer, projectTab } from "./coarsen";
import { keyedHash } from "./hash";
import { indexHashedPlaces, readFlagOnly, recordedRead, type UnitRow, type VisitRow } from "./model";
import type { LogStore } from "./store";

const PLACES = ["url", "nofragment", "querynames", "path", "pattern", "host", "domain"] as const;

/** Whether `next` keeps less of anything than `was`. */
export function keepsLess(was: RecordingConfig, next: RecordingConfig): boolean {
  if (!was.on) return false;
  if (!next.on) return true;
  return (Object.keys(was.layers) as (keyof RecordingConfig["layers"])[]).some((d) => rank(d, next.layers[d] as never) > rank(d, was.layers[d] as never))
    || next.hashed.some((h) => !was.hashed.includes(h));
}

/** Rewrite `store` to what `next` keeps; off deletes every visit, paragraph and event, and the
 *  totals stay (Clear statistics deletes those). `secret` hashes what is newly to be hashed. */
export async function stripTo(store: LogStore, next: RecordingConfig, secret: Uint8Array): Promise<void> {
  const L = next.on ? next.layers : OFF.layers;
  const at = (d: keyof typeof L, layer: string): boolean => rank(d, L[d] as never) <= rank(d, layer as never);
  const hash = (v: string | undefined): string | undefined => v === undefined ? undefined : keyedHash(secret, v);
  const dur = (ms: number | undefined): number | undefined => ms === undefined ? undefined : coarseDur(ms, L.dur) ?? undefined;
  const lastScroll = new Map<number, number>();
  let previousVisit = "";
  const placesByHash = new Map<string, NonNullable<VisitRow["places"]>>();
  await store.rewrite({
    totals: (rows) => groupTotals(rows, (row) => projectTotal(row, L, next.hashed, (value) => keyedHash(secret, value), false, placesByHash)),
    visit(v) {
      if (at("rows", "site") && L.place !== "none") indexHashedPlaces(placesByHash, v);
      if (!at("rows", "visit")) return null;
      const out: VisitRow = { ...v, start: coarseTime(v.start, L.time), end: v.end === undefined ? undefined : coarseTime(v.end, L.time),
        shown: dur(v.shown) ?? 0, active: dur(v.active) ?? 0, focused: dur(v.focused) ?? 0 };
      const hashPlace = next.hashed.includes("place") && !v.hashed?.includes("place");
      if (L.place === "none") { out.site = undefined; out.url = undefined; out.pageSite = undefined; }
      if (v.pageSite && L.place !== "none") {
        const coarse = L.place === "domain" && v.places?.host !== undefined;
        out.pageSite = coarse ? v.hashed?.includes("place") ? undefined : registrableDomain(v.pageSite) : v.pageSite;
        if (hashPlace) out.pageSite = hash(out.pageSite);
      }
      const storedPlaces = v.places ?? (!v.hashed?.includes("place") && v.url ? placeLadder(v.url) : null);
      if (storedPlaces) {
        const places: VisitRow["places"] = {};
        if (L.place !== "none") for (const l of PLACES.slice(PLACES.indexOf(L.place as typeof PLACES[number]))) if (storedPlaces[l] !== undefined) places[l] = hashPlace ? hash(storedPlaces[l]) : storedPlaces[l];
        out.places = Object.keys(places).length ? places : undefined;
        out.url = rank("place", L.place) <= rank("place", "pattern") ? places[L.place as keyof typeof places] : undefined;
        out.site = places.host ?? places.domain;
      } else {
        out.url = undefined;
        if (v.site && L.place !== "none") {
          out.site = L.place === "domain" ? v.hashed?.includes("place") ? undefined : registrableDomain(v.site) : v.site;
          if (hashPlace) out.site = hash(out.site);
        }
      }
      if (!at("nav", "full")) { out.referrer = undefined; out.previous = undefined; out.opener = undefined; }
      else {
        out.referrer = projectReferrer(v, L.place);
        if (hashPlace) out.referrer = hash(out.referrer);
      }
      if (!at("nav", "arrival")) out.arrival = undefined;
      out.title = retainedTitle(v.title, !!v.hashed?.includes("title"), v.titleLayer, L.title);
      if (next.hashed.includes("title") && !v.hashed?.includes("title")) out.title = hash(out.title);
      out.titleLayer = v.titleLayer === "short" ? "short" : L.title;
      out.hashed = [...new Set([...(v.hashed ?? []), ...next.hashed])];
      if (!at("tabs", "ids")) { out.tab = undefined; out.window = undefined; }
      if (L.struct !== "full") out.signals = undefined;
      if (!at("geom", "share")) { out.height = undefined; out.width = undefined; }
      if (L.cover !== "visit") { out.found = undefined; out.leftOut = undefined; }
      if (!at("scroll", "visit")) out.scroll = undefined;
      if (L.state === "none") out.shown = out.active = out.focused = 0;
      out.idle = at("input", "idle") ? v.idle?.map(([a,b]) => [dur(a) ?? 0, dur(b) ?? 0]) : undefined;
      if (!at("input", "minutes")) out.minutes = undefined;
      if (!at("ui", "counts")) out.ui = undefined;
      if (L.engine === "model") out.engine = undefined;
      else if (L.engine === "basic" && v.engine) out.engine = { kind: v.engine.kind };
      return out;
    },
    unit(u) {
      if (!at("rows", "paragraph")) return null;
      const out: UnitRow = { ...u, found: dur(u.found) ?? 0, removedAt: dur(u.removedAt) };
      if (L.expo === "none") out.readDate = u.date;
      if (!at("text", "hash")) out.hash = undefined;
      if (!at("text", "sketch")) out.sketch = undefined;
      if (!at("text", "head")) out.head = undefined;
      out.len = u.len ? coarseLen(u.len as Lengths, L.len) : undefined;
      out.lang = u.lang ? coarseLang(u.lang, L.lang) : undefined;
      out.verdict = u.verdict ? coarseVerdict(u.verdict, L.verdict) : undefined;
      if (L.struct !== "full" && u.struct) out.struct = at("struct", "unit") ? { unit: u.struct.unit, post: u.struct.post, order: u.struct.order, paragraphs: u.struct.paragraphs } : undefined;
      if (u.geom) out.geom = L.geom === "none" ? undefined : L.geom === "share" ? { share: u.geom.share, page: u.geom.page } : L.geom === "order" ? { page: u.geom.page } : u.geom;
      if (u.expo) out.expo = L.expo === "none" || (L.expo === "read" && recordedRead(u.expo) === undefined) ? undefined
        : L.expo === "read" || L.dur === "none" || readFlagOnly(u.expo) ? { any: [0, 0, 0, 0], half: [0, 0, 0, 0], band: [0, 0, 0, 0], sightings: L.expo === "read" ? 0 : u.expo.sightings, read: recordedRead(u.expo), readAt: dur(u.expo.readAt) } : {
        any: u.expo.any.map((ms) => dur(ms) ?? 0) as typeof u.expo.any,
        half: u.expo.half.map((ms) => dur(ms) ?? 0) as typeof u.expo.half,
        band: u.expo.band.map((ms) => dur(ms) ?? 0) as typeof u.expo.band,
        sightings: u.expo.sightings, readAt: dur(u.expo.readAt), first: dur(u.expo.first), last: dur(u.expo.last),
      };
      if (L.engine === "model") out.timing = undefined;
      else if (L.engine === "basic" && u.timing) out.timing = { cached: u.timing.cached };
      else if (u.timing) out.timing = { ...u.timing, answered: dur(u.timing.answered) };
      return out;
    },
    events(e) {
      if (L.rows !== "event") return null;
      if (e.visit !== previousVisit) { previousVisit = e.visit; lastScroll.clear(); }
      const streams = projectStreams(e.streams, L, lastScroll);
      return Object.keys(streams).length ? { ...e, streams } : null;
    },
    texts: L.text !== "full",
    tabs: (e) => projectTab(e, L),
    context(c) {
      if (!next.on) return null;
      const family = (value?: string): string | undefined => L.device === "none" ? undefined : L.device === "exact" ? value : value?.split(" ")[0];
      return { ...c, at: coarseTime(c.at, L.time), browser: family(c.browser), os: family(c.os),
        hardware: L.device === "exact" ? c.hardware : undefined, screen: L.device === "exact" ? c.screen : undefined,
        engine: L.engine === "full" ? c.engine : L.engine === "basic" && c.engine ? { kind: c.engine.kind } : undefined };
    },
  });
}
