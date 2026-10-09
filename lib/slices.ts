// lib/slices.ts — long work in slices, with the page's own work let through between them.
//
// A computation written as a generator yields where it may pause. `finish` runs it to its end
// at once, as a function would; `finishInSlices` runs it a few milliseconds at a time and
// hands the main thread back between slices, so a page being read or scrolled does not
// stall while it runs (the PDF reader's structure, as it arrives for a long document).

/** Run `steps` to its end now. */
export function finish<T>(steps: Generator<void, T>): T {
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
  }
}

/** How long a slice runs before the page's own work is let through: half a frame at 60 Hz. */
export const SLICE_MS = 8;

/** Run `steps` to its end, handing the main thread back whenever a slice has run `sliceMs`.
 *  `meter.waited` adds up the time it was handed back, so that what the work itself cost is
 *  the time it took less that (Observers' drain pacing, lib/capture/observers.ts). */
export async function finishInSlices<T>(steps: Generator<void, T>, sliceMs = SLICE_MS, meter?: { waited: number }): Promise<T> {
  let began = performance.now();
  for (;;) {
    const step = steps.next();
    if (step.done) return step.value;
    if (performance.now() - began >= sliceMs) {
      const handed = performance.now();
      await yieldToMain();
      began = performance.now();
      if (meter) meter.waited += began - handed;
    }
  }
}

/** Let the page's own tasks run: scheduler.yield where the browser has it, else a task. */
export function yieldToMain(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  return scheduler?.yield ? scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0));
}
