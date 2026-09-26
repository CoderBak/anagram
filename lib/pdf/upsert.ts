// lib/pdf/upsert.ts — Map and WeakMap getOrInsert() and getOrInsertComputed(), where missing.
//
// pdf.js, and the pdf.js inside Zotero's document-worker, call them, and Firefox 140 ESR
// does not have them (Firefox 153 does): there no PDF opened at all. Installed in the reader
// page by entrypoints/reader/viewer.ts, and first thing in both workers by the start files
// scripts/vendor.mjs writes around them. Nothing is replaced where the browser has them.
type Keyed = { has(key: unknown): boolean; get(key: unknown): unknown; set(key: unknown, value: unknown): unknown };

for (const { prototype } of [Map, WeakMap]) {
  const define = (name: string, value: (this: Keyed, key: unknown, arg: never) => unknown): void => {
    if (typeof (prototype as unknown as Record<string, unknown>)[name] !== "function") {
      Object.defineProperty(prototype, name, { value, writable: true, configurable: true });
    }
  };
  define("getOrInsert", function (key, value: unknown) {
    if (!this.has(key)) this.set(key, value);
    return this.get(key);
  });
  define("getOrInsertComputed", function (key, compute: (key: unknown) => unknown) {
    if (typeof compute !== "function") throw new TypeError("getOrInsertComputed: callback is not a function");
    if (this.has(key)) return this.get(key);
    const value = compute(key);
    this.set(key, value);
    return value;
  });
}

export {};
