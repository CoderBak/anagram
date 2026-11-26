import { rank, type Layer, type Layers, type Hashable } from "./config";
import { coarseDur, retainedTitle, placeLadder } from "./coarsen";
import { registrableDomain } from "../publicSuffixes";
import type { PlaceLayerKey, TotalRow, VisitRow } from "./model";
import { mergeTotal } from "./store";

/** Hashed groups that need a retained address link to reach the requested layer. */
export function coarserPlaceLayer(t: TotalRow, layers: Layers): PlaceLayerKey | undefined {
  if (!t.hashed || layers.place === "none" || (t.scope !== "page" && t.scope !== "site") || t.key.startsWith("file:")) return;
  const site = t.scope === "site";
  if (rank("rows", layers.rows) > rank("rows", t.scope) || rank("place", layers.place) > rank("place", site ? "domain" : "pattern")) return;
  const target = site && layers.place !== "domain" ? "host" : layers.place;
  return rank("place", t.placeLayer ?? (site ? "host" : "url")) < rank("place", target) ? target : undefined;
}

/** Aggregate keys need the same privacy boundaries as individual visits. Already hashed
 *  keys cannot be shortened to a new address layer. Drop that group if it cannot be mapped. */
export function projectTotal(t: TotalRow, layers: Layers, hashed: readonly Hashable[],
  hash: (value: string) => string, forFile = false, keptPlaces?: ReadonlyMap<string, VisitRow["places"]>): TotalRow | null {
  const { scope } = t;
  if (scope === "day") return t;
  if (scope === "kind") return layers.struct === "none" ? null : t;
  const site = scope === "site";
  if (rank("rows", layers.rows) > rank("rows", scope) ||
      rank("place", layers.place) > rank("place", site ? "domain" : "pattern")) return null;
  const target = (site ? layers.place === "domain" ? "domain" : "host" : layers.place) as Exclude<Layer<"place">, "none">;
  const layer = t.placeLayer && rank("place", t.placeLayer) > rank("place", target) ? t.placeLayer : target;
  const wasTitleHash = t.titleHashed ?? /^[a-f0-9]{16}$/i.test(t.title ?? "");
  let title = retainedTitle(t.title, wasTitleHash, t.titleLayer, layers.title);
  if (title !== undefined && (wasTitleHash ? forFile : hashed.includes("title"))) title = hash(title);
  let key = t.key;
  let siteHash = t.siteHash;
  // Only the title allowed by this projection can identify a local document. The old
  // key may contain a full filename even when the title has since been removed.
  if (key.startsWith("file:")) key = "file:" + (forFile && title ? hash(title) : title ?? "");
  else if (key) {
    if (t.hashed) {
      if (!site && !forFile) siteHash ??= keptPlaces?.get(key)?.host;
      const coarser = coarserPlaceLayer(t, layers);
      if (coarser) {
        const coarse = keptPlaces?.get(key)?.[coarser];
        if (!coarse) return null;
        key = coarse;
      }
      if (forFile) key = hash(key);
    } else {
      if (site && layer === "domain") key = registrableDomain(key);
      if (!site) {
        const places = placeLadder(key);
        if (!places || layer === "none") return null;
        key = places[layer];
        if (hashed.includes("place") && !forFile) siteHash = hash(places.host);
      }
      if (hashed.includes("place")) key = hash(key);
    }
  }
  return { ...t, key, siteHash: forFile ? undefined : siteHash, title, titleLayer: t.titleLayer === "short" ? "short" : layers.title, placeLayer: layer, hashed: t.hashed || hashed.includes("place"),
    titleHashed: !!wasTitleHash || hashed.includes("title"),
    kind: layers.struct === "none" ? undefined : t.kind,
    startDate: rank("time", layers.time) <= rank("time", "min") ? t.startDate : undefined,
    start: rank("time", layers.time) <= rank("time", "min") ? t.start : undefined,
    dwell: t.dwell === undefined || layers.dur === "none" ? undefined : (coarseDur(t.dwell * 1000, layers.dur) ?? 0) / 1000 };
}

export function groupTotals(rows: Iterable<TotalRow>, project: (r: TotalRow) => TotalRow | null): TotalRow[] {
  const groups = new Map<string, TotalRow>();
  for (const row of rows) {
    const t = project(row);
    if (!t) continue;
    const key = JSON.stringify([t.date, t.scope, t.key]);
    groups.set(key, mergeTotal(groups.get(key), t));
  }
  return [...groups.values()];
}
