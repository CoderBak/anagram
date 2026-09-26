// lib/hash.ts — shared string hash for cache keys.
//
// cyrb53 (https://github.com/bryc/code, jshash/experimental/cyrb53.js, public domain,
// © 2018 bryc): 53-bit output. Both cache layers key results by hashed normalized text;
// a 32-bit hash (the SW side used FNV-1a) makes wrong-badge collisions realistic
// over a long session of heavy browsing — birthday bound ~1 in 2^16 per ~300
// unique paragraphs vs ~1 in 2^26 here.
export function cyrb53(str: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}
