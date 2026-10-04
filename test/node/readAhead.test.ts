// test/node/readAhead.test.ts — the PDF reader's whole-document reading: how fast, in what
// order and how much of the document it reads in the background (lib/pdf/readAhead.ts), and the
// pace it keeps to, which a web page's background prefetch keeps to as well (lib/capture/pace.ts).
//
// Everything here is arithmetic on one measurement, how long the engine takes for a thousand
// characters, so the cases are the thresholds, the hysteresis, the bounds and the order,
// stated as numbers.
import { describe, expect, it } from "vitest";
import { createPacer, seedFor, type Pacer } from "../../lib/capture/pace";
import { inScope, readingDistance, takeBatch, SLOW_SCOPE } from "../../lib/pdf/readAhead";

const TEN_MINUTES = 10 * 60_000;
/** A batch of `chars` characters the engine read at `msPerK` a thousand. */
const batch = (pacer: Pacer, msPerK: number, chars = 1000): void => pacer.done(msPerK * chars / 1000, chars);

describe("the pacer's measure", () => {
  it("starts between a GPU and a CPU, mid-speed, with nothing measured", () => {
    const pacer = createPacer();
    expect(pacer.msPerK()).toBe(600);
    expect(pacer.samples()).toBe(0);
    expect(pacer.speed()).toBe("mid");
    expect(pacer.limited()).toBe(false);
  });

  it("starts fast up to 400 ms a thousand characters, mid up to 2000, slow past that", () => {
    expect(createPacer(1).speed()).toBe("fast");
    expect(createPacer(400).speed()).toBe("fast");
    expect(createPacer(401).speed()).toBe("mid");
    expect(createPacer(2000).speed()).toBe("mid");
    expect(createPacer(2001).speed()).toBe("slow");
    expect(createPacer(60_000).speed()).toBe("slow");
  });

  it("measures a batch by its characters, not its paragraphs: a short paragraph is not a fast engine", () => {
    const short = createPacer(1000), long = createPacer(1000);
    short.done(150, 100); // 1500 a thousand
    long.done(1500, 1000);
    expect(short.msPerK()).toBe(1250);
    expect(long.msPerK()).toBe(1250);
  });

  it("learns nothing from a batch the engine did not read (cache hits, the language gate)", () => {
    const pacer = createPacer(1000);
    pacer.done(5000, 0);
    expect(pacer.msPerK()).toBe(1000);
    expect(pacer.samples()).toBe(0);
  });

  it("weighs the first three measurements a half and every later one a fifth", () => {
    const pacer = createPacer(1000);
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      batch(pacer, 2000);
      seen.push(pacer.msPerK());
    }
    expect(seen.slice(0, 3)).toEqual([1500, 1750, 1875]);
    expect(seen[3]).toBeCloseTo(0.8 * 1875 + 0.2 * 2000, 9);
    expect(seen[4]).toBeCloseTo(0.8 * seen[3]! + 0.2 * 2000, 9);
    expect(pacer.samples()).toBe(5);
  });

  it("takes a host that answers a 600-character paragraph in two and a half seconds for slow after two batches", () => {
    // What the slow-engine scenario (test/pw/pdf-read-ahead.spec.mjs) relies on: the fixture
    // host at 2.5 s a request, one TALL_PDF paragraph (about 600 characters) a batch.
    const pacer = createPacer();
    expect(pacer.budget()).toBe(0);
    pacer.done(2500, 600);
    expect(pacer.speed()).toBe("mid");
    expect(pacer.limited()).toBe(false);
    pacer.done(2500, 600);
    expect(pacer.speed()).toBe("slow");
    expect(pacer.limited()).toBe(true);
  });
});

describe("the pacer's classes change a fifth past the line", () => {
  it("keeps a fast engine fast up to 480, and makes it mid past that", () => {
    const pacer = createPacer(400);
    batch(pacer, 540); // 470
    expect(pacer.msPerK()).toBe(470);
    expect(pacer.speed()).toBe("fast");
    batch(pacer, 600); // 535
    expect(pacer.speed()).toBe("mid");
  });

  it("makes a mid engine fast only under 320", () => {
    const pacer = createPacer(600);
    batch(pacer, 100); // 350: under the line, not a fifth under it
    expect(pacer.msPerK()).toBe(350);
    expect(pacer.speed()).toBe("mid");
    batch(pacer, 100); // 225
    expect(pacer.speed()).toBe("fast");
  });

  it("makes a mid engine slow only over 2400", () => {
    const pacer = createPacer(1900);
    batch(pacer, 2600); // 2250
    expect(pacer.msPerK()).toBe(2250);
    expect(pacer.speed()).toBe("mid");
    expect(pacer.limited()).toBe(false);
    batch(pacer, 2600); // 2425
    expect(pacer.speed()).toBe("slow");
  });

  it("makes a slow engine mid again only under 1600", () => {
    const pacer = createPacer(2100);
    batch(pacer, 1500); // 1800
    expect(pacer.msPerK()).toBe(1800);
    expect(pacer.speed()).toBe("slow");
    batch(pacer, 1500); // 1650
    expect(pacer.speed()).toBe("slow");
    expect(pacer.limited()).toBe(true);
    batch(pacer, 1000); // 1325
    expect(pacer.speed()).toBe("mid");
    expect(pacer.limited()).toBe(false);
  });

  it("goes from fast straight to slow on a pace past both lines", () => {
    const pacer = createPacer(300);
    batch(pacer, 10_000); // 5150
    expect(pacer.speed()).toBe("slow");
  });

  it("is not swung by one odd batch once it has measured a few", () => {
    const pacer = createPacer(250);
    for (let i = 0; i < 6; i++) batch(pacer, 250);
    batch(pacer, 1000); // 0.8 · 250 + 0.2 · 1000 = 400
    expect(pacer.speed()).toBe("fast");
  });

  it("comes back to fast once the engine does", () => {
    const pacer = createPacer(3000);
    expect(pacer.limited()).toBe(true);
    for (let i = 0; i < 20; i++) batch(pacer, 100);
    expect(pacer.speed()).toBe("fast");
    expect(pacer.limited()).toBe(false);
  });
});

describe("the pacer's rest, batches and quiet", () => {
  it("rests as long as the batch took on a fast engine, twice as long on a mid one, about 5.7 times on a slow one", () => {
    expect(createPacer(250).restAfter(1000, false)).toBe(1000); // d = 1/2
    expect(createPacer(600).restAfter(900, false)).toBe(1800); // d = 1/3
    expect(createPacer(3000).restAfter(1500, false)).toBe(Math.round(1500 * 0.85 / 0.15)); // d = .15
    expect(createPacer(250).restAfter(0, false)).toBe(0);
  });

  it("takes half the share on battery", () => {
    expect(createPacer(250).restAfter(1000, true)).toBe(3000); // d = 1/4
    expect(createPacer(600).restAfter(900, true)).toBe(4500); // d = 1/6
    expect(createPacer(3000).restAfter(1000, true)).toBe(Math.round(1000 * 0.925 / 0.075)); // d = .075
  });

  it("rests by the class it keeps, not the line the pace has crossed", () => {
    const pacer = createPacer(400);
    batch(pacer, 540); // 470: past the line, still fast
    expect(pacer.restAfter(1000, false)).toBe(1000);
  });

  it("gives a slow engine a mid one's share once the whole document is asked for, and changes nothing faster", () => {
    expect(createPacer(3000).restAfter(1000, false, true)).toBe(2000);
    expect(createPacer(3000).restAfter(1000, true, true)).toBe(5000);
    expect(createPacer(600).restAfter(900, false, true)).toBe(1800);
    expect(createPacer(250).restAfter(1000, false, true)).toBe(1000);
  });

  it("gives a fast engine about a second of its time a batch, at most 4000 characters, and anything slower one paragraph", () => {
    /** A pacer that has measured one batch at its seed's pace. */
    const measured = (msPerK: number): Pacer => { const p = createPacer(msPerK); batch(p, msPerK); return p; };
    expect(measured(400).budget()).toBe(2500);
    expect(measured(350).budget()).toBe(2857);
    expect(measured(250).budget()).toBe(4000);
    expect(measured(100).budget()).toBe(4000);
    expect(measured(401).budget()).toBe(0);
    expect(measured(3000).budget()).toBe(0);
    const kept = createPacer(400);
    batch(kept, 540); // 470, still fast
    expect(kept.budget()).toBe(Math.round(1_000_000 / 470));
  });

  it("does not take one batch far slower than the pace at its word, and does take two in a row", () => {
    const pacer = createPacer(250);
    batch(pacer, 250);
    batch(pacer, 250 * 6 + 1); // the model loaded again after idling
    expect(pacer.msPerK()).toBe(250);
    expect(pacer.speed()).toBe("fast");
    batch(pacer, 250);
    expect(pacer.msPerK()).toBe(250);
    batch(pacer, 3000);
    batch(pacer, 3000); // a second in a row: the engine is slower now
    expect(pacer.msPerK()).toBeGreaterThan(400);
    expect(pacer.speed()).not.toBe("fast");
  });

  it("tells how long the rest takes at its pace, its rests included: half its time on a GPU, a third on a CPU, half that on battery", () => {
    expect(createPacer(250).timeFor(60_000, false)).toBe(30_000); // 15 s of passes, as much rest
    expect(createPacer(1000).timeFor(60_000, false)).toBe(180_000); // 60 s of passes, a third of the time
    expect(createPacer(1000).timeFor(60_000, true)).toBe(360_000);
    expect(createPacer(3000).timeFor(10_000, false, true)).toBe(90_000); // asked for: a mid engine's share
    expect(createPacer(250).timeFor(0, false)).toBe(0);
  });

  it("reads one paragraph first, whatever the device says, until a batch has been measured", () => {
    const gpu = createPacer(250);
    expect(gpu.speed()).toBe("fast");
    expect(gpu.budget()).toBe(0);
    gpu.done(30, 0); // all cache hits: nothing measured
    expect(gpu.budget()).toBe(0);
    batch(gpu, 250, 300);
    expect(gpu.budget()).toBe(4000);
  });

  it("waits twice a thousand characters' time after the last input, never under half a second or over five", () => {
    expect(createPacer(100).quiet()).toBe(500);
    expect(createPacer(250).quiet()).toBe(500);
    expect(createPacer(400).quiet()).toBe(800);
    expect(createPacer(600).quiet()).toBe(1200);
    expect(createPacer(2500).quiet()).toBe(5000);
    expect(createPacer(30_000).quiet()).toBe(5000);
  });
});

describe("the pacer's limit", () => {
  it("keeps to the pages around once a document has had ten minutes of engine time, on any engine", () => {
    const pacer = createPacer(250);
    pacer.done(TEN_MINUTES, 10_000_000); // 60 a thousand: still fast
    expect(pacer.speed()).toBe("fast");
    expect(pacer.limited()).toBe(false); // exactly ten minutes is not over them
    pacer.done(1, 0); // time the engine read nothing in counts towards the time spent, not the pace
    expect(pacer.limited()).toBe(true);
    expect(pacer.speed()).toBe("fast");
  });

  it("starts a new document's share again and keeps the pace it measured", () => {
    const pacer = createPacer(250);
    pacer.done(TEN_MINUTES + 1, 100_000_000);
    expect(pacer.speed()).toBe("fast");
    expect(pacer.limited()).toBe(true);
    const pace = pacer.msPerK(), samples = pacer.samples();
    pacer.newDocument();
    expect(pacer.msPerK()).toBe(pace);
    expect(pacer.samples()).toBe(samples);
    expect(pacer.speed()).toBe("fast");
    expect(pacer.limited()).toBe(false);
  });

  it("keeps a slow engine limited in a new document", () => {
    const pacer = createPacer(3000);
    pacer.newDocument();
    expect(pacer.limited()).toBe(true);
  });
});

describe("seedFor", () => {
  it("guesses a GPU's pace from the engine's device, and a CPU's", () => {
    for (const device of ["webgpu", "cuda", "mps", "Metal", "ROCm", "DirectML", "dml", "gpu:0"]) expect(seedFor(device), device).toBe(250);
    for (const device of ["cpu", "CPU", "wasm"]) expect(seedFor(device), device).toBe(1000);
  });

  it("says nothing where the device says nothing it knows", () => {
    for (const device of [undefined, "", "fake", "none"]) expect(seedFor(device), String(device)).toBeNull();
  });

  it("puts a GPU's guess in the fast class and a CPU's in the mid one", () => {
    expect(createPacer(seedFor("webgpu")!).speed()).toBe("fast");
    expect(createPacer(seedFor("cpu")!).speed()).toBe("mid");
  });
});

describe("readingDistance", () => {
  it("counts pages ahead once and pages behind twice", () => {
    expect(readingDistance(5, 5)).toBe(0);
    expect(readingDistance(6, 5)).toBe(1);
    expect(readingDistance(9, 5)).toBe(4);
    expect(readingDistance(4, 5)).toBe(2);
    expect(readingDistance(1, 5)).toBe(8);
  });

  it("turns round when the reader reads up the document", () => {
    expect(readingDistance(4, 5, false)).toBe(1);
    expect(readingDistance(6, 5, false)).toBe(2);
    expect(readingDistance(5, 5, false)).toBe(0);
  });

  it("orders a document outward from the page being read, two pages ahead for each one behind", () => {
    const pages = Array.from({ length: 10 }, (_, i) => i + 1);
    const order = (current: number, down: boolean): number[] =>
      [...pages].sort((a, b) => readingDistance(a, current, down) - readingDistance(b, current, down) || a - b);
    expect(order(5, true)).toEqual([5, 6, 4, 7, 8, 3, 9, 10, 2, 1]);
    expect(order(5, false)).toEqual([5, 4, 3, 6, 2, 1, 7, 8, 9, 10]);
    expect(order(1, true)).toEqual(pages);
  });
});

describe("inScope", () => {
  it("reads every page where the reader is not limited", () => {
    for (const page of [1, 2, 50, 300]) expect(inScope(page, 1, false)).toBe(true);
  });

  it("reads two pages behind and six ahead where it is", () => {
    expect(SLOW_SCOPE).toEqual({ behind: 2, ahead: 6 });
    const read = Array.from({ length: 30 }, (_, i) => i + 1).filter((page) => inScope(page, 10, true));
    expect(read).toEqual([8, 9, 10, 11, 12, 13, 14, 15, 16]);
    expect(Array.from({ length: 30 }, (_, i) => i + 1).filter((page) => inScope(page, 1, true))).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

describe("takeBatch", () => {
  const p = (n: number, tag = String(n)) => ({ text: "x".repeat(n), tag });

  it("takes nothing from nothing", () => {
    expect(takeBatch([], 4000)).toEqual([]);
  });

  it("takes exactly one paragraph on a budget of none, however short", () => {
    expect(takeBatch([p(1, "a"), p(1, "b")], 0).map((x) => x.tag)).toEqual(["a"]);
  });

  it("takes one paragraph that is over the budget by itself", () => {
    expect(takeBatch([p(9000, "long"), p(10, "short")], 4000).map((x) => x.tag)).toEqual(["long"]);
  });

  it("takes paragraphs in the order given while they fit, up to the budget exactly", () => {
    expect(takeBatch([p(4, "a"), p(6, "b"), p(1, "c")], 10).map((x) => x.tag)).toEqual(["a", "b"]);
    expect(takeBatch([p(4, "a"), p(4, "b"), p(4, "c")], 10).map((x) => x.tag)).toEqual(["a", "b"]);
  });

  it("stops at the first paragraph that does not fit rather than reaching past it", () => {
    expect(takeBatch([p(4, "a"), p(8, "b"), p(1, "c")], 10).map((x) => x.tag)).toEqual(["a"]);
  });
});
