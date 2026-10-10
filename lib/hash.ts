// lib/hash.ts — string hashes for cache keys.
//
// digest128: what the worker's caches, shared by every page, key by. Collision-resistant —
// a page that could make its own text collide with another page's would set that page's
// verdict (cyrb53 is unkeyed and invertible step by step) — and keyed with the partition the
// text was read in (lib/backend/router.ts), never the site's name itself.
//
// cyrb53 (https://github.com/bryc/code, jshash/experimental/cyrb53.js, public domain,
// © 2018 bryc): 53-bit output, for what stays within one page — the content script's own
// cache of its verdicts (lib/capture/cache.ts) and the reading log's paragraphs within a
// visit (lib/stats/). A 32-bit hash made wrong-chip collisions realistic over a long
// session of heavy browsing: for ~300 unique paragraphs, a collision ~1 in 2^17 at 32 bits,
// against ~1 in 2^37 here.
import { Sha256 } from "./webengine/sha256";

const encoder = new TextEncoder();
/** SHA-256 of `text` (UTF-8), its first 128 bits as hex. */
export function digest128(text: string): string {
  return new Sha256().update(encoder.encode(text)).digest().slice(0, 32);
}

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
