// lib/stats/config.ts — what the reading statistics keep: one layer for each dimension.
//
// Everything the log can hold is a FIELD, and every field belongs to a DIMENSION: what it
// says about the person (when, where, what text, how they moved). Each dimension has a
// ladder of LAYERS, finest first and ending, mostly, in nothing; a layer can always be worked
// out from a finer one, never the other way. A configuration is one layer per dimension.
// Recording, the statistics page and an export each hold one, and the page and the export
// are never finer than what was recorded (docs/statistics.md).
//
// Statistics are off until the reader chooses a preset or a configuration of their own, and
// nothing they keep leaves this computer unless they export it and hand the file over.
//
// Pure, and free of any extension API: the page's recorder (a chunk of its own) reads it too.

export const DIMENSIONS = {
  /** What one stored row is: an event of a visit, a paragraph, a visit, or a total. */
  rows: ["event", "paragraph", "visit", "page", "site", "kind", "day"],
  /** Clock times. */
  time: ["ms", "s", "min", "quarter", "hour", "day"],
  /** Durations and offsets within a visit. */
  dur: ["ms", "decis", "s", "bins", "none"],
  /** Addresses: the visit's, the referrer's and the frames'. */
  place: ["url", "nofragment", "querynames", "path", "pattern", "host", "domain", "none"],
  title: ["full", "short", "none"],
  /** A paragraph's text. */
  text: ["full", "head", "sketch", "hash", "none"],
  len: ["all", "words", "rounded", "bands", "none"],
  verdict: ["probs", "probs2", "words", "flagged", "none"],
  lang: ["full", "label", "english", "none"],
  /** What kind of page and of paragraph, and how the page is built. */
  struct: ["full", "unit", "kind", "none"],
  /** Where on the page. */
  geom: ["changes", "found", "share", "order", "none"],
  /** When paragraphs were on screen. */
  expo: ["steps", "intervals", "totals", "read", "none"],
  scroll: ["frames", "tenth", "second", "episodes", "visit", "none"],
  input: ["pointer", "positions", "events", "minutes", "idle", "none"],
  /** Page shown or hidden, window focused or not. */
  state: ["changes", "totals", "none"],
  tabs: ["full", "ids", "none"],
  /** How a visit was arrived at. */
  nav: ["full", "arrival", "none"],
  engine: ["full", "basic", "model"],
  /** How the person used Anagram's own chips, cards and menu. */
  ui: ["events", "counts", "none"],
  device: ["exact", "families", "none"],
  /** What could not be read, and time in front of pages Anagram cannot read. */
  cover: ["visit", "day", "none"],
} as const;

export type Dimension = keyof typeof DIMENSIONS;
export type Layer<D extends Dimension> = (typeof DIMENSIONS)[D][number];
export type Layers = { [D in Dimension]: Layer<D> };
export const DIMENSION_IDS = Object.keys(DIMENSIONS) as Dimension[];

/** Dimensions whose values name something (a site, a page): kept as a salted hash instead
 *  of in the clear, they can still be counted and told apart, and say nothing more. */
export const HASHABLE = ["place", "title"] as const satisfies readonly Dimension[];
export type Hashable = (typeof HASHABLE)[number];

export const RETENTION = {
  /** The fine trace: every exposure step, scroll frames, input and pointer events. */
  fine: [7, 30, 90],
  /** Paragraphs and visits. */
  detail: [30, 90, 365],
  /** Totals by day, kind, site and page. 0 keeps them until the reader clears them. */
  totals: [365, 0],
} as const;
export interface Retention { fine: (typeof RETENTION.fine)[number]; detail: (typeof RETENTION.detail)[number]; totals: (typeof RETENTION.totals)[number] }
export const DEFAULT_RETENTION: Retention = { fine: 7, detail: 90, totals: 0 };

export interface RecordingConfig {
  on: boolean;
  layers: Layers;
  /** The hashable dimensions kept as salted hashes. */
  hashed: Hashable[];
  retention: Retention;
}

/** The finest layer of every dimension. */
const FINEST = Object.fromEntries(DIMENSION_IDS.map((d) => [d, DIMENSIONS[d][0]])) as Layers;

const all = (over: Partial<Layers>, coarse: Partial<Layers> = {}): Layers => ({ ...FINEST, ...coarse, ...over });
/** Everything a totals preset does not keep. */
const NOTHING: Partial<Layers> = {
  time: "day", dur: "none", place: "none", title: "none", text: "none", len: "none", verdict: "words", lang: "none",
  struct: "kind", geom: "none", expo: "read", scroll: "none", input: "none", state: "none", tabs: "none", nav: "none",
  engine: "model", ui: "none", device: "families", cover: "day",
};

export const PRESETS = {
  daily: all({ rows: "day" }, NOTHING),
  sites: all({ rows: "site", place: "domain" }, NOTHING),
  pages: all({ rows: "page", place: "path", title: "full", time: "min", dur: "s", input: "idle", state: "totals" }, NOTHING),
  paragraphs: all({
    rows: "paragraph", time: "min", dur: "s", place: "none", title: "none", text: "hash", len: "all", verdict: "probs",
    lang: "label", struct: "unit", geom: "order", expo: "totals", scroll: "visit", input: "idle", state: "totals",
    tabs: "none", nav: "arrival", engine: "basic", ui: "counts", device: "families", cover: "visit",
  }),
  study: all({
    rows: "event", time: "s", dur: "decis", place: "domain", title: "none", text: "sketch", len: "all", verdict: "probs",
    lang: "full", struct: "full", geom: "found", expo: "intervals", scroll: "second", input: "events", state: "changes",
    tabs: "ids", nav: "arrival", engine: "full", ui: "events", device: "families", cover: "visit",
  }),
  full: all({ text: "sketch" }),
  fullText: all({}),
} as const satisfies Record<string, Layers>;
export type Preset = keyof typeof PRESETS;
export const PRESET_IDS = Object.keys(PRESETS) as Preset[];
/** Hashed by a preset as well as kept at its layer. */
const PRESET_HASHED: Partial<Record<Preset, Hashable[]>> = {};

export const OFF: RecordingConfig = { on: false, layers: PRESETS.daily, hashed: [], retention: DEFAULT_RETENTION };

export function presetConfig(preset: Preset, retention: Retention = DEFAULT_RETENTION): RecordingConfig {
  return { on: true, layers: { ...PRESETS[preset] }, hashed: [...(PRESET_HASHED[preset] ?? [])], retention };
}

/** The index of a layer in its ladder: 0 is the finest. */
export function rank<D extends Dimension>(d: D, layer: Layer<D>): number {
  return (DIMENSIONS[d] as readonly string[]).indexOf(layer);
}

/** Which preset a configuration is, or null for one of the reader's own. */
export function presetOf(config: RecordingConfig): Preset | null {
  if (!config.on) return null;
  for (const id of PRESET_IDS) {
    const hashed = PRESET_HASHED[id] ?? [];
    if (DIMENSION_IDS.every((d) => PRESETS[id][d] === config.layers[d]) &&
      hashed.length === config.hashed.length && hashed.every((h) => config.hashed.includes(h))) return id;
  }
  return null;
}

/**
 * The configuration as it can be kept: a dimension finer than the rows it would be kept in is
 * made as coarse as they allow, and the rows as coarse as the address allows (pages need an
 * address; sites a host). What was moved, by dimension, so Settings can say so.
 */
export function normalize(config: RecordingConfig): { config: RecordingConfig; moved: Dimension[] } {
  const layers: Layers = { ...config.layers };
  const moved = new Set<Dimension>();
  /** No finer than `coarsest`. */
  const cap = <D extends Dimension>(d: D, coarsest: Layer<D>): void => {
    if (rank(d, layers[d]) < rank(d, coarsest)) { (layers as Record<Dimension, string>)[d] = coarsest; moved.add(d); }
  };
  /** No coarser than `finest`. */
  const floor = <D extends Dimension>(d: D, finest: Layer<D>): void => {
    if (rank(d, layers[d]) > rank(d, finest)) { (layers as Record<Dimension, string>)[d] = finest; moved.add(d); }
  };
  // Rows by address: a page needs at least the path's pattern, a site a domain.
  if (layers.rows === "page" && rank("place", layers.place) > rank("place", "pattern")) {
    layers.rows = rank("place", layers.place) <= rank("place", "domain") ? "site" : "kind"; moved.add("rows");
  }
  if (layers.rows === "site" && layers.place === "none") { layers.rows = "kind"; moved.add("rows"); }
  // What only an event log holds.
  if (layers.rows !== "event") {
    cap("expo", "totals"); cap("scroll", "visit"); cap("input", "idle"); cap("state", "totals");
    cap("tabs", "ids"); cap("ui", "counts"); cap("geom", "found");
  }
  // An event log times its events: a duration of "none" or in bins cannot.
  if (layers.rows === "event") floor("dur", "s");
  // Paragraph rows weigh each paragraph by its words.
  if (rank("rows", layers.rows) <= rank("rows", "paragraph")) floor("len", "rounded");
  // What only paragraph rows hold.
  if (rank("rows", layers.rows) > rank("rows", "paragraph")) {
    cap("text", "none"); cap("len", "bands"); cap("verdict", "words"); cap("lang", "english"); cap("struct", "kind");
    cap("geom", "none"); cap("expo", "read");
  }
  // What only visit rows hold.
  if (rank("rows", layers.rows) > rank("rows", "visit")) {
    cap("scroll", "none"); cap("input", "idle"); cap("tabs", "none"); cap("nav", "none"); cap("ui", "none");
    if (layers.rows !== "page") { cap("title", "none"); cap("time", "day"); }
    cap("cover", "day");
  }
  return { config: { ...config, layers, hashed: config.hashed.filter((h) => HASHABLE.includes(h)) }, moved: [...moved] };
}

/** A stored value as a configuration: anything not one is off, a layer that is not one of its
 *  dimension's is its preset's, and the rest is normalized. */
export function configOf(value: unknown): RecordingConfig {
  if (!value || typeof value !== "object") return OFF;
  const raw = value as Partial<{ on: unknown; layers: Record<string, unknown>; hashed: unknown; retention: Record<string, unknown> }>;
  if (raw.on !== true) return { ...OFF, retention: retentionOf(raw.retention) };
  const layers = { ...PRESETS.daily } as Record<Dimension, string>;
  for (const d of DIMENSION_IDS) {
    const v = raw.layers?.[d];
    if (typeof v === "string" && (DIMENSIONS[d] as readonly string[]).includes(v)) layers[d] = v;
  }
  const hashed = Array.isArray(raw.hashed) ? raw.hashed.filter((h): h is Hashable => (HASHABLE as readonly unknown[]).includes(h)) : [];
  return normalize({ on: true, layers: layers as Layers, hashed, retention: retentionOf(raw.retention) }).config;
}

function retentionOf(value: unknown): Retention {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const pick = <K extends keyof Retention>(k: K): Retention[K] =>
    ((RETENTION[k] as readonly unknown[]).includes(raw[k]) ? raw[k] : DEFAULT_RETENTION[k]) as Retention[K];
  return { fine: pick("fine"), detail: pick("detail"), totals: pick("totals") };
}
