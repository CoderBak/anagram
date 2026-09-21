import type { ScoreStore, Stored } from "../../lib/backend/swCache";

/** Deterministic persistent store shared by cache/privacy/race tests. */
export function fakeScoreStore() {
  const rows = new Map<string, Stored>();
  const store: ScoreStore & { rows: typeof rows; cutoffs: number[]; overflows: number } = {
    rows, cutoffs: [], overflows: 0,
    async get(keys) { return keys.map((key) => rows.get(key)); },
    async put(batch) { for (const row of batch) rows.set(row.key, row); },
    async clear() { rows.clear(); },
    async count() { return rows.size; },
    async dropOlderThan(cutoff) {
      store.cutoffs.push(cutoff);
      let removed = 0;
      for (const [key, row] of rows) if (row.t < cutoff) { rows.delete(key); removed++; }
      return removed;
    },
    async dropOldest(max, keep) {
      store.overflows++;
      if (rows.size <= max) return 0;
      const oldest = [...rows.values()].sort((a, b) => a.t - b.t).slice(0, rows.size - keep);
      for (const row of oldest) rows.delete(row.key);
      return oldest.length;
    },
  };
  return store;
}
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
