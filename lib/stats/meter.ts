// lib/stats/meter.ts — the reading log's foot in the content script: it loads the recorder
// (lib/stats/recorder.ts, a chunk of its own) only while statistics are on, outside a private
// window, and hands it what the page has read so far.
//
// Off, nothing of the recorder is loaded and nothing here runs. On, what the walk reports
// before the chunk has loaded (short stretches it left unread, paragraphs gone) is held and
// handed over once it has.
import { browser } from "#imports";
import type { Unit } from "../types";
import type { ScoreResult } from "../contract";
import { lazyVendor } from "../lazy";
import type { Layers } from "./config";
import type { Recorder, RecorderHost } from "./recorder";
import type { UiEvent } from "./model";

/** This document is in a private window, where nothing is measured (the worker would keep
 *  none of it either). */
export function inPrivateWindow(): boolean {
  try {
    return browser.extension?.inIncognitoContext === true;
  } catch {
    return false; // a dead extension context records nothing anyway
  }
}

export interface RecorderModule { createRecorder(host: RecorderHost): Recorder }
/** The chunk, by its web-accessible address: what a content script can import. An extension
 *  page cannot (Chrome hands it the resource's per-session address, which the page's own
 *  policy does not allow), and bundles the recorder instead (OrchestratorOptions.statsRecorder). */
const loadChunk = (): Promise<RecorderModule> => lazyVendor<RecorderModule>("stats.min.mjs");

export interface ReadingMeter {
  running(): boolean;
  /** Start, or start again under other layers, with the units on the page now. */
  start(layers: Layers, units: () => Iterable<Unit>): void;
  /** Stop. `send` (the default) sends what was learned first; false drops it. */
  stop(send?: boolean): void;
  track(unit: Unit): void;
  trackShort(nodes: Text[]): void;
  verdict(unit: Unit, result: ScoreResult): void;
  forget(unit: Unit): void;
  drop(): void;
  newView(units: Iterable<Unit>): void;
  leave(): void;
  ui(kind: UiEvent, unit?: Unit): void;
}

/** At most this many short stretches wait for the recorder to load. */
const MOST_HELD = 2000;

export function createReadingMeter(host: Omit<RecorderHost, "layers">, loadRecorder: () => Promise<RecorderModule> = loadChunk): ReadingMeter {
  let recorder: Recorder | null = null;
  let layers: Layers | null = null;
  let generation = 0;
  let held: Text[][] = [];
  const gone = new Set<Unit>();

  return {
    running: () => layers !== null,
    start(next, units) {
      if (layers && JSON.stringify(layers) === JSON.stringify(next)) return;
      if (recorder) { recorder.stop(true); recorder = null; }
      layers = next;
      const ticket = ++generation;
      void loadRecorder().then((module) => {
        if (ticket !== generation || !layers) return;
        recorder = module.createRecorder({ ...host, layers });
        recorder.start(units());
        for (const nodes of held) recorder.trackShort(nodes);
        for (const unit of gone) recorder.forget(unit);
        held = [];
        gone.clear();
      }, () => { if (ticket === generation) layers = null; });
    },
    stop(send = true) {
      generation++;
      recorder?.stop(send);
      recorder = null;
      layers = null;
      held = [];
      gone.clear();
    },
    track(unit) { recorder?.track(unit); },
    trackShort(nodes) {
      if (recorder) recorder.trackShort(nodes);
      else if (layers && held.length < MOST_HELD) held.push(nodes);
    },
    verdict(unit, result) { recorder?.verdict(unit, result); },
    forget(unit) {
      if (recorder) recorder.forget(unit);
      else if (layers) gone.add(unit);
    },
    drop() { recorder?.drop(); },
    newView(units) { recorder?.newView(units); },
    leave() { recorder?.leave(); },
    ui(kind, unit) { recorder?.ui(kind, unit); },
  };
}
