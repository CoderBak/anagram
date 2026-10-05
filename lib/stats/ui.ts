// lib/stats/ui.ts — the words for the reading log's dimensions, layers and presets, and the table
// Settings and the export dialog both choose layers in: a row per dimension, its layers from
// finest to none, never finer than `cap` allows (what was recorded, for an export).
import { t, type MessageKey } from "../i18n";
import { DIMENSION_KEYS, LAYER_KEYS, PRESET_KEYS } from "./labels";
import {
  DIMENSION_IDS, DIMENSIONS, HASHABLE, normalize, PRESET_IDS, presetOf, rank,
  type Dimension, type Hashable, type Layers, type Preset, type RecordingConfig,
} from "./config";

export const dimensionLabel = (d: Dimension): string => t(DIMENSION_KEYS[d]![0]);
export const dimensionHint = (d: Dimension): string => t(DIMENSION_KEYS[d]![1]);
export const layerLabel = (d: Dimension, layer: string): string => t(LAYER_KEYS[`${d}.${layer}`]!);
export const presetLabel = (p: Preset | "off" | "custom"): string => t(PRESET_KEYS[p]![0]);
export const presetHint = (p: Preset | "off" | "custom"): string => t(PRESET_KEYS[p]![1]);

/** The warnings a configuration earns: what it keeps that someone else using this browser
 *  profile could read. */
export function warningsOf(config: RecordingConfig): MessageKey[] {
  if (!config.on) return [];
  const L = config.layers;
  const out: MessageKey[] = [];
  if (L.text === "full") out.push("statsWarnText");
  else if (L.text === "head") out.push("statsWarnHead");
  if (!config.hashed.includes("place") && rank("place", L.place) <= rank("place", "nofragment")) out.push("statsWarnUrl");
  if (!config.hashed.includes("place") && rank("place", L.place) <= rank("place", "pattern") && rank("rows", L.rows) <= rank("rows", "page")) out.push("statsPagesWarning");
  if (L.input === "pointer") out.push("statsWarnPointer");
  return out;
}

/** What a preset (or the reader's own configuration) is called. */
export function configName(config: RecordingConfig): string {
  if (!config.on) return presetLabel("off");
  return presetLabel(presetOf(config) ?? "custom");
}

export interface LayerTable {
  element: HTMLElement;
  /** Show these layers (normalized), capped at `cap`'s. */
  show(layers: Layers, hashed: Hashable[], cap?: Layers | null): void;
}

/**
 * The dimension table: a select per dimension (its layers finer than `cap` left out) and, for a
 * dimension that names something, whether to keep it as a salted hash. `onChange` gets the
 * configuration as chosen, normalized; a row the rows hold no more of says so.
 */
export function layerTable(idPrefix: string, onChange: (layers: Layers, hashed: Hashable[]) => void): LayerTable {
  const table = document.createElement("table");
  table.className = "table dims";
  const head = table.createTHead().insertRow();
  for (const key of ["statsColDimension", "statsColLayer"] as const) {
    const th = document.createElement("th");
    th.textContent = t(key);
    head.append(th);
  }
  const body = table.createTBody();
  const selects = new Map<Dimension, HTMLSelectElement>();
  const hashBoxes = new Map<Hashable, HTMLInputElement>();
  let current: { layers: Layers; hashed: Hashable[] } | null = null;
  for (const d of DIMENSION_IDS) {
    const row = body.insertRow();
    const name = row.insertCell();
    name.className = "name";
    const label = document.createElement("label");
    label.htmlFor = `${idPrefix}-${d}`;
    label.textContent = dimensionLabel(d);
    const hint = document.createElement("span");
    hint.className = "hint";
    hint.textContent = dimensionHint(d);
    name.append(label, hint);
    const cell = row.insertCell();
    const select = document.createElement("select");
    select.className = "select";
    select.id = `${idPrefix}-${d}`;
    cell.append(select);
    selects.set(d, select);
    if ((HASHABLE as readonly Dimension[]).includes(d)) {
      const box = document.createElement("input");
      box.type = "checkbox";
      box.className = "input";
      box.id = `${idPrefix}-${d}-hash`;
      const boxLabel = document.createElement("label");
      boxLabel.className = "hash";
      boxLabel.htmlFor = box.id;
      boxLabel.append(box, document.createTextNode(` ${t("statsAsHash")}`));
      cell.append(boxLabel);
      hashBoxes.set(d as Hashable, box);
      box.addEventListener("change", changed);
    }
    select.addEventListener("change", changed);
  }
  function changed(): void {
    if (!current) return;
    const layers = { ...current.layers } as Record<Dimension, string>;
    for (const [d, select] of selects) layers[d] = select.value;
    const hashed = [...hashBoxes].filter(([, box]) => box.checked).map(([d]) => d);
    const normal = normalize({ on: true, layers: layers as Layers, hashed, retention: { fine: 7, detail: 90, totals: 0 } }).config;
    onChange(normal.layers, normal.hashed);
  }
  return {
    element: table,
    show(layers, hashed, cap = null) {
      current = { layers, hashed };
      for (const d of DIMENSION_IDS) {
        const select = selects.get(d)!;
        const all = DIMENSIONS[d] as readonly string[];
        const from = cap ? rank(d, cap[d] as never) : 0;
        select.replaceChildren(...all.slice(from).map((layer) => new Option(layerLabel(d, layer), layer)));
        select.value = rank(d, layers[d] as never) < from ? all[from]! : layers[d];
      }
      for (const [d, box] of hashBoxes) box.checked = hashed.includes(d);
    },
  };
}

export { PRESET_IDS };
