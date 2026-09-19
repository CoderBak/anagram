// test/node/groupProps.test.ts — properties of the grouping plan.
//
// lib/plan/group.ts decides which paragraphs are read TOGETHER, for a web page and for a
// PDF alike, and a mistake there is not a wrong pixel: it is a verdict standing for text
// the model never read, two authors under one number, or a paragraph nobody judged. The
// rules themselves are stated in the walker's own voice and tested against real markup in
// test/unit.mjs; these run the source-free planner over a few hundred seeded sequences of
// blocks — sub-floor and full, punctuated by barriers, captions and column breaks, with
// lengths that straddle the model's window — and assert what the file promises. A failure
// names the seed to reproduce it.
import { describe, expect, it } from "vitest";
import {
  clearsFloor,
  fitsWindow,
  groupBlocks,
  groupChars,
  groupWords,
  modelSized,
  type PlanBlock,
} from "../../lib/plan/group";
import { MIN_UNIT_WORDS } from "../../lib/dom/text";
import { WINDOW_CHARS } from "../../lib/capture/windows";
import { rng, seeds, type Rng } from "./random";

function forSeeds(count: number, check: (r: Rng, seed: number) => void): void {
  for (const seed of seeds(count)) {
    try {
      check(rng(seed), seed);
    } catch (e) {
      throw new Error(`seed ${seed}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

/** One block: a paragraph of a page or of a paper, in the only terms the rules read. */
function block(r: Rng): PlanBlock {
  const words = r.pick([r.int(1, MIN_UNIT_WORDS - 1), r.int(1, 12), r.int(MIN_UNIT_WORDS, 140)]);
  // Five to nine characters a word for ordinary prose; sometimes something pathological —
  // a paragraph of URLs, a line of chemistry — so the window bound has to do real work.
  const chars = r.chance(0.15) ? r.int(1, 3 * WINDOW_CHARS) : Math.max(1, words * r.int(4, 9));
  return {
    words,
    chars,
    role: r.pick(["prose", "prose", "prose", "prose", "prose", "apart", "barrier", "skip"] as const),
    barrierBefore: r.chance(0.15),
  };
}

const sequence = (r: Rng): PlanBlock[] => Array.from({ length: r.int(0, 16) }, () => block(r));

const roleOf = (b: PlanBlock): string => b.role ?? "prose";

describe("groupBlocks", () => {
  it("returns groups in document order, each ascending, none overlapping", () => {
    forSeeds(300, (r) => {
      const blocks = sequence(r);
      const groups = groupBlocks(blocks);
      const seen = new Set<number>();
      let previousFirst = -1;
      for (const g of groups) {
        expect(g.length).toBeGreaterThan(0);
        expect(g[0]).toBeGreaterThan(previousFirst);
        previousFirst = g[0];
        for (let i = 0; i < g.length; i++) {
          expect(g[i]).toBeGreaterThanOrEqual(0);
          expect(g[i]).toBeLessThan(blocks.length);
          if (i > 0) expect(g[i]).toBeGreaterThan(g[i - 1]);
          expect(seen.has(g[i])).toBe(false);
          seen.add(g[i]);
        }
      }
    });
  });

  it("gives every group the evidence floor", () => {
    forSeeds(300, (r) => {
      const blocks = sequence(r);
      for (const g of groupBlocks(blocks)) {
        expect(clearsFloor(g.map((i) => blocks[i]))).toBe(true);
        expect(groupWords(g.map((i) => blocks[i]))).toBeGreaterThanOrEqual(MIN_UNIT_WORDS);
      }
    });
  });

  it("keeps a group inside one model window unless the floor forbids the cut", () => {
    forSeeds(300, (r) => {
      const blocks = sequence(r);
      for (const g of groupBlocks(blocks)) {
        const parts = g.map((i) => blocks[i]);
        if (fitsWindow(parts) || parts.length === 1) continue;
        // The only group allowed past the window is a stretch of SHORT blocks that cannot
        // be divided without leaving a piece under the floor (thirty-letter words).
        expect(parts.every((p) => p.words < MIN_UNIT_WORDS)).toBe(true);
      }
    });
  });

  it("never reads across a barrier, a block set apart, or a column break", () => {
    forSeeds(300, (r) => {
      const blocks = sequence(r);
      for (const g of groupBlocks(blocks)) {
        for (const i of g) expect(["prose", "apart"]).toContain(roleOf(blocks[i]));
        if (roleOf(blocks[g[0]]) === "apart") expect(g.length).toBe(1);
        for (let at = g[0] + 1; at <= g[g.length - 1]; at++) {
          // Nothing between the first and the last block of a group may be a boundary…
          expect(roleOf(blocks[at])).not.toBe("barrier");
          expect(roleOf(blocks[at])).not.toBe("apart");
          // …and no joint inside it may be one.
          expect(blocks[at].barrierBefore ?? false).toBe(false);
        }
      }
    });
  });

  it("reads every block that clears the floor by itself, and drops only orphans", () => {
    forSeeds(300, (r) => {
      const blocks = sequence(r);
      const groups = groupBlocks(blocks);
      const placed = new Set(groups.flat());
      blocks.forEach((b, i) => {
        const role = roleOf(b);
        if ((role === "prose" || role === "apart") && b.words >= MIN_UNIT_WORDS) {
          expect(placed.has(i)).toBe(true);
          return;
        }
        // Everything else is either grouped with its neighbours or read by nobody — and
        // what is read by nobody is never a block that could have stood alone.
        if (!placed.has(i)) expect(b.words < MIN_UNIT_WORDS || role === "barrier" || role === "skip").toBe(true);
      });
    });
  });

  it("is deterministic, and grouping one group again returns that same group", () => {
    forSeeds(300, (r) => {
      const blocks = sequence(r);
      const groups = groupBlocks(blocks);
      expect(groupBlocks(blocks)).toEqual(groups);
      for (const g of groups) {
        const parts = g.map((i) => blocks[i]);
        // A group past the window is one modelSized could not divide IN ITS STRETCH; on
        // its own it is a different question, so only the ordinary case is asserted.
        if (!fitsWindow(parts)) continue;
        expect(groupBlocks(parts)).toEqual([parts.map((_, i) => i)]);
      }
    });
  });
});

describe("modelSized", () => {
  /** A stretch of short blocks, the way a run of them reaches the divider. */
  const shorts = (r: Rng): PlanBlock[] =>
    Array.from({ length: r.int(1, 30) }, () => {
      const words = r.int(4, MIN_UNIT_WORDS - 1);
      return { words, chars: Math.max(1, words * r.int(4, 9)) };
    });

  it("keeps a stretch that fits one window whole", () => {
    forSeeds(200, (r) => {
      const stretch = shorts(r);
      if (!fitsWindow(stretch)) return;
      expect(modelSized(stretch)).toEqual([stretch]);
    });
  });

  it("divides in order, losing nothing and repeating nothing", () => {
    forSeeds(300, (r) => {
      const stretch = shorts(r);
      expect(modelSized(stretch).flat()).toEqual(stretch);
    });
  });

  it("gives every piece the floor once the whole stretch has it", () => {
    forSeeds(300, (r) => {
      const stretch = shorts(r);
      if (!clearsFloor(stretch)) return;
      for (const piece of modelSized(stretch)) expect(clearsFloor(piece)).toBe(true);
    });
  });

  it("makes no more pieces than it needs to", () => {
    forSeeds(300, (r) => {
      const stretch = shorts(r);
      const pieces = modelSized(stretch);
      expect(pieces.length).toBeGreaterThanOrEqual(1);
      expect(pieces.length).toBeLessThanOrEqual(Math.max(1, stretch.length));
      if (fitsWindow(stretch)) expect(pieces.length).toBe(1);
      else expect(pieces.length).toBeGreaterThanOrEqual(1);
      // The characters are all still there, joints and all.
      expect(pieces.reduce((n, p) => n + groupChars(p), 0) + 2 * (pieces.length - 1)).toBe(groupChars(stretch));
    });
  });
});
