// lib/stats/strip.ts — what is kept already, made as coarse as a new configuration: when the
// reader asks for less, Settings offers to delete what the new configuration would not have kept
// (LogStore.rewrite). Keeping it is the default; nothing here runs unless they choose to delete.
import { rank, type RecordingConfig } from "./config";
import { coarseDur, coarseLang, coarseLen, coarseTime, coarseTitle, coarseVerdict, type Lengths } from "./coarsen";
import { keyedHash } from "./hash";
import type { UnitRow, VisitRow } from "./model";
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
  if (!next.on) {
    await store.rewrite({ visit: () => null, unit: () => null, events: true, texts: true, tabs: true });
    return;
  }
  const L = next.layers;
  const at = (d: keyof typeof L, layer: string): boolean => rank(d, L[d] as never) <= rank(d, layer as never);
  const hash = (v: string | undefined): string | undefined => v === undefined ? undefined : keyedHash(secret, v);
  const dur = (ms: number | undefined): number | undefined => ms === undefined ? undefined : coarseDur(ms, L.dur) ?? undefined;
  await store.rewrite({
    visit(v) {
      if (!at("rows", "visit")) return null;
      const out: VisitRow = { ...v, start: coarseTime(v.start, L.time), end: v.end === undefined ? undefined : coarseTime(v.end, L.time),
        shown: dur(v.shown) ?? 0, active: dur(v.active) ?? 0, focused: dur(v.focused) ?? 0 };
      const hashPlace = next.hashed.includes("place") && !v.hashed?.includes("place");
      if (v.places) {
        const places: VisitRow["places"] = {};
        if (L.place !== "none") for (const l of PLACES.slice(PLACES.indexOf(L.place as typeof PLACES[number]))) if (v.places[l] !== undefined) places[l] = hashPlace ? hash(v.places[l]) : v.places[l];
        out.places = Object.keys(places).length ? places : undefined;
        out.url = rank("place", L.place) <= rank("place", "pattern") ? places[L.place as keyof typeof places] : undefined;
        out.site = places.host ?? places.domain;
      }
      if (!at("nav", "full")) { out.referrer = undefined; out.previous = undefined; out.opener = undefined; }
      else if (hashPlace) out.referrer = hash(v.referrer);
      if (!at("nav", "arrival")) out.arrival = undefined;
      if (v.title !== undefined) out.title = L.title === "none" ? undefined : next.hashed.includes("title") && !v.hashed?.includes("title") ? hash(coarseTitle(v.title, L.title)) : v.hashed?.includes("title") ? v.title : coarseTitle(v.title, L.title);
      out.hashed = [...new Set([...(v.hashed ?? []), ...next.hashed])];
      if (!at("tabs", "ids")) { out.tab = undefined; out.window = undefined; }
      if (L.struct !== "full") out.signals = undefined;
      if (!at("geom", "share")) { out.height = undefined; out.width = undefined; }
      if (L.cover !== "visit") { out.found = undefined; out.leftOut = undefined; }
      if (!at("scroll", "visit")) out.scroll = undefined;
      if (!at("input", "idle")) out.idle = undefined;
      if (!at("input", "minutes")) out.minutes = undefined;
      if (!at("ui", "counts")) out.ui = undefined;
      if (L.engine === "model") out.engine = undefined;
      else if (L.engine === "basic" && v.engine) out.engine = { kind: v.engine.kind };
      return out;
    },
    unit(u) {
      if (!at("rows", "paragraph")) return null;
      const out: UnitRow = { ...u, found: dur(u.found) ?? 0, removedAt: dur(u.removedAt) };
      if (!at("text", "hash")) out.hash = undefined;
      if (!at("text", "sketch")) out.sketch = undefined;
      if (!at("text", "head")) out.head = undefined;
      out.len = u.len ? coarseLen(u.len as Lengths, L.len) : undefined;
      out.lang = u.lang ? coarseLang(u.lang, L.lang) : undefined;
      out.verdict = u.verdict ? coarseVerdict(u.verdict, L.verdict) : undefined;
      if (L.struct !== "full" && u.struct) out.struct = at("struct", "unit") ? { unit: u.struct.unit, post: u.struct.post, order: u.struct.order, paragraphs: u.struct.paragraphs } : undefined;
      if (u.geom) out.geom = L.geom === "none" ? undefined : L.geom === "share" ? { share: u.geom.share, page: u.geom.page } : L.geom === "order" ? { page: u.geom.page } : u.geom;
      if (u.expo) out.expo = L.expo === "none" ? undefined : L.expo === "read" ? { any: [0, 0, 0, 0], half: [0, 0, 0, 0], band: [0, 0, 0, 0], sightings: 0, readAt: dur(u.expo.readAt) } : u.expo;
      if (L.engine === "model") out.timing = undefined;
      else if (L.engine === "basic" && u.timing) out.timing = { cached: u.timing.cached };
      return out;
    },
    events: L.rows !== "event",
    texts: L.text !== "full",
    tabs: L.rows !== "event" || (L.tabs === "none" && L.cover !== "visit" && L.ui !== "events"),
  });
}
