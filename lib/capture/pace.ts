// lib/capture/pace.ts — how fast Anagram reads in the background: the PDF reader's pages it
// has not drawn (lib/pdf/readAhead.ts), a web page's paragraphs nobody has scrolled to yet.
//
// The engine reads one pass at a time and cannot be interrupted (lib/webengine/engine.ts), so
// whatever is read in the background is a delay for what is on screen and a cost in power.
// What follows keeps both bounded, on a fast GPU and on a slow CPU alike, from one
// measurement: how long the engine takes here for a thousand characters (a pass's cost grows
// with its text, and paragraphs are of every length: timed per pass, short ones made a CPU
// look like a GPU). One batch far slower than the pace — the model loaded again after five
// idle minutes, another tab's work ahead of it — is not taken at its word; two in a row are.
//
// - Pace: a duty cycle. After a batch that kept the engine busy for B ms the background rests
//   B·(1 − d)/d, with d by how fast the engine is — half its time on a GPU, a third on a CPU,
//   15% on a slow one — and half that on battery. (The spellcheckers' "cold mode"
//   and Zotero's indexer work in slices on the same principle.) A speed changes class only a
//   fifth past the line, so one odd batch does not swing it.
// - Batches (the PDF reader's; a web page's background lane keeps its own budget, one
//   paragraph a batch where the engine is not fast, lib/capture/orchestrator.ts): about a
//   second of the engine's time where it is fast, ONE paragraph where it is not, so what comes
//   on screen next waits behind at most one paragraph — and one paragraph until something has
//   been measured, whatever the device says. Where it is not fast the
//   paragraphs on screen go one at a time too: a pass pads its texts to the longest of them
//   (three paragraphs of a page took 4.8 s together on an M4's CPU, 3.1 s one by one), and
//   each chip is up as soon as its paragraph is read.
// - Quiet: nothing starts until the reader has left the page alone for twice what a thousand
//   characters take (at least half a second, at most five), as a spellchecker waits for
//   typing to stop.
// - Scope: a slow engine, or a page that has had ten minutes of the engine's time, reads only
//   around what is being read.

import { deviceKind } from "../backend/deviceKind";

export type Speed = "fast" | "mid" | "slow";

/** Milliseconds per thousand characters at or under which the engine is "fast" (a GPU: about
 *  200 on an M4; the local engine), and over which it is "slow" (an M4's CPU: about 1000). */
const FAST_MS_PER_K = 400;
const SLOW_MS_PER_K = 2000;
/** How far past a line a speed must go to change class. */
const HYSTERESIS = 0.2;
/** A batch this many times slower than the pace is not counted, unless the next is too. */
const OUTLIER = 6;
/** The engine's share of time the background may take, by speed. */
const DUTY: Record<Speed, number> = { fast: 0.5, mid: 1 / 3, slow: 0.15 };
/** A fast engine's batch: about this much of its time, and at most this many characters. */
const BATCH_MS = 1000;
const MAX_BATCH_CHARS = 4000;
/** Engine time a document may take in the background while it is open before the reader keeps
 *  to what is around the place being read, as a slow engine does: ten minutes. */
const SESSION_MS = 10 * 60_000;
/** The first guess, before anything has been measured: between a GPU and a CPU. */
const SEED_MS_PER_K = 600;

/** What the engine's device says of its pace, where it says something. */
export function seedFor(device: string | undefined): number | null {
  const kind = deviceKind(device);
  return kind === "gpu" ? 250 : kind === "cpu" ? 1000 : null;
}

function classOf(msPerK: number): Speed {
  return msPerK <= FAST_MS_PER_K ? "fast" : msPerK <= SLOW_MS_PER_K ? "mid" : "slow";
}

export interface Pacer {
  /** A background batch came back: it took `ms`, and the engine read `chars` characters of it
   *  (cache hits are not read, and teach nothing about speed). */
  done(ms: number, chars: number): void;
  /** How long a thousand characters take here, smoothed. */
  msPerK(): number;
  /** How many batches it has measured. */
  samples(): number;
  speed(): Speed;
  /** How long to rest after a batch that took `ms`; `asked`, the reader asked for the whole
   *  document, gives a slow engine a third of its time rather than a seventh. */
  restAfter(ms: number, onBattery: boolean, asked?: boolean): number;
  /** About how long `chars` more characters take in the background, its rests included. */
  timeFor(chars: number, onBattery: boolean, asked?: boolean): number;
  /** Characters a batch may carry; 0 means one paragraph. */
  budget(): number;
  /** How long the reader must have left the page alone before background work starts. */
  quiet(): number;
  /** The reader keeps to what is around the place being read (slow, or the document's share
   *  spent) until asked for the whole document. */
  limited(): boolean;
  /** A new document: its share of engine time starts again; the pace measured stays. */
  newDocument(): void;
}

export function createPacer(seedMsPerK = SEED_MS_PER_K): Pacer {
  let pace = seedMsPerK;
  let cls = classOf(pace);
  let spent = 0;
  let samples = 0;
  let outlier = false;
  const duty = (onBattery: boolean, asked: boolean): number => Math.max(DUTY[cls], asked ? DUTY.mid : 0) * (onBattery ? 0.5 : 1);
  return {
    done(ms, chars) {
      spent += ms;
      if (chars <= 0) return;
      const measured = ms * 1000 / chars;
      // Against a measured pace only: the first batch is the measure, the seed a guess.
      if (samples > 0 && measured > OUTLIER * pace && !outlier) { outlier = true; return; }
      outlier = false;
      // The guess gives way fast: the first measurements weigh half.
      const weight = samples < 3 ? 0.5 : 0.2;
      pace = (1 - weight) * pace + weight * measured;
      samples++;
      const above = (line: number) => pace > line * (1 + HYSTERESIS);
      const below = (line: number) => pace < line * (1 - HYSTERESIS);
      if (cls === "fast" && above(FAST_MS_PER_K)) cls = above(SLOW_MS_PER_K) ? "slow" : "mid";
      else if (cls === "mid" && below(FAST_MS_PER_K)) cls = "fast";
      else if (cls === "mid" && above(SLOW_MS_PER_K)) cls = "slow";
      else if (cls === "slow" && below(SLOW_MS_PER_K)) cls = below(FAST_MS_PER_K) ? "fast" : "mid";
    },
    msPerK: () => pace,
    samples: () => samples,
    speed: () => cls,
    restAfter(ms, onBattery, asked = false) {
      const d = duty(onBattery, asked);
      return Math.round(ms * (1 - d) / d);
    },
    timeFor: (chars, onBattery, asked = false) => Math.round(chars / 1000 * pace / duty(onBattery, asked)),
    budget: () => (cls === "fast" && samples > 0 ? Math.min(MAX_BATCH_CHARS, Math.round(BATCH_MS * 1000 / pace)) : 0),
    quiet: () => Math.min(5000, Math.max(500, 2 * pace)),
    limited: () => cls === "slow" || spent > SESSION_MS,
    newDocument() { spent = 0; },
  };
}

/** What the reader does that says the page is being read now: the background waits. */
export const READER_INPUT = ["wheel", "scroll", "keydown", "pointerdown", "touchstart"] as const;
/** At this charge and falling, the background stops (where Chrome's Energy Saver starts
 *  holding pages back too). */
export const LOW_BATTERY = 0.2;

/**
 * A web page's background lane, at the pace (lib/capture/orchestrator.ts). The idle prefetch
 * reads what nobody has scrolled to yet; unpaced, a long page or a feed kept the engine busy
 * until all of it was read, which on a laptop's processor is minutes of fans and battery for
 * paragraphs that may never be looked at. Each background batch is timed; after it the lane
 * rests by the duty cycle, waits for the reader to leave the page alone, and keeps to what is
 * near the screen (the observers' near lane) where the engine is slow, the page has had its
 * ten minutes, or the battery is low.
 */
export interface BackgroundPace {
  /** How long the background lane rests yet, in ms (the scheduler's backgroundDelay);
   *  Infinity while it keeps to what is near the screen. */
  delay(): number;
  /** A background batch came back: it took `ms`, and the engine read `chars` of it. */
  done(ms: number, chars: number): void;
  /** What the engine's status says it runs on: the first guess of its pace, until measured. */
  seed(device: string | undefined): void;
  /** Another document (a route change): its share of the engine's time starts again. */
  newDocument(): void;
  /** Follow the reader's input, and the battery, while a run is on. */
  watch(on: boolean): void;
}

export function createBackgroundPace(): BackgroundPace {
  let pacer = createPacer();
  /** The lane rests until then (performance.now()). */
  let restUntil = 0;
  let lastInput = -Infinity;
  let onBattery = false;
  let lowBattery = false;
  let batteryWatched = false;
  const noteInput = (): void => { lastInput = performance.now(); };
  return {
    delay() {
      if (lowBattery || pacer.limited()) return Infinity;
      const now = performance.now();
      return Math.max(0, restUntil - now, lastInput + pacer.quiet() - now);
    },
    done(ms, chars) {
      pacer.done(ms, chars);
      restUntil = performance.now() + pacer.restAfter(ms, onBattery);
    },
    seed(device) {
      const seed = seedFor(device);
      if (seed !== null && pacer.samples() === 0 && pacer.msPerK() !== seed) pacer = createPacer(seed);
    },
    newDocument: () => pacer.newDocument(),
    watch(on) {
      for (const type of READER_INPUT) {
        if (on) document.addEventListener(type, noteInput, { capture: true, passive: true });
        else document.removeEventListener(type, noteInput, { capture: true });
      }
      if (!on || batteryWatched) return;
      batteryWatched = true;
      // On battery the background takes half its share; low and falling, none.
      void (navigator as { getBattery?: () => Promise<{ charging: boolean; level: number; addEventListener(type: string, listener: () => void): void }> })
        .getBattery?.().then((battery) => {
          const read = (): void => { onBattery = !battery.charging; lowBattery = !battery.charging && battery.level <= LOW_BATTERY; };
          read();
          battery.addEventListener("chargingchange", read);
          battery.addEventListener("levelchange", read);
        }).catch(() => undefined);
    },
  };
}
