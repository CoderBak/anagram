// lib/stats/hash.ts — what the log keeps of a text, a site or a title instead of the thing
// itself, where the reader chose that: a salted hash, and a salted near-duplicate sketch.
//
// Both are keyed with a secret that is made on this computer, kept in the extension's own
// storage and never exported (lib/stats/worker.ts). Within one person's log the same text has
// the same hash, so reading it again is seen as reading it again, and a copy edited a little
// has a sketch most of whose slots match. Without the secret neither can be computed for a
// known text, so a file handed over cannot be searched for what its owner read; and an export
// re-keys them again for the file (lib/stats/export.ts), so two files can be told apart unless
// the owner chose to make them linkable. Pure, and synchronous: the worker hashes as it writes.
import { Sha256 } from "../webengine/sha256";
import { cyrb53 } from "../hash";
import { countWords } from "../dom/text";

const encoder = new TextEncoder();

function hexBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** HMAC-SHA-256 of `message` under `key`, as hex (RFC 2104). */
export function hmac(key: Uint8Array, message: string): string {
  let k = key.length > 64 ? hexBytes(new Sha256().update(key).digest()) : key;
  if (k.length < 64) { const padded = new Uint8Array(64); padded.set(k); k = padded; }
  const inner = new Uint8Array(64), outer = new Uint8Array(64);
  for (let i = 0; i < 64; i++) { inner[i] = k[i]! ^ 0x36; outer[i] = k[i]! ^ 0x5c; }
  const innerHash = new Sha256().update(inner).update(encoder.encode(message)).digest();
  return new Sha256().update(outer).update(hexBytes(innerHash)).digest();
}

/** A text's, a site's or a title's salted hash: 64 bits of HMAC-SHA-256, as hex. One log of
 *  a million distinct texts has about one chance in thirty million of two sharing one. */
export function keyedHash(key: Uint8Array, value: string): string {
  return hmac(key, value).slice(0, 16);
}

/** Slots in a sketch, and the bits kept of each (b-bit MinHash). */
const SKETCH_SLOTS = 32;
const SHINGLE_WORDS = 5;

/** The seeds of a key's sketches: one 32-bit value per slot, from the key. */
function seedsOf(key: Uint8Array): number[] {
  const hex = hmac(key, "anagram sketch seeds 1") + hmac(key, "anagram sketch seeds 2") + hmac(key, "anagram sketch seeds 3") + hmac(key, "anagram sketch seeds 4");
  return Array.from({ length: SKETCH_SLOTS }, (_, i) => parseInt(hex.slice(i * 8, i * 8 + 8), 16) | 0);
}
const seedCache = new WeakMap<Uint8Array, number[]>();

/** The words of a text as a sketch reads them: lower case, letters and digits only. */
function wordsOf(text: string): string[] {
  return text.toLowerCase().normalize("NFKC").split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * A text's near-duplicate sketch: for each of 32 keyed hash functions, the low 16 bits of the
 * least hash of its five-word shingles, as 64 bytes in base64url. The share of slots two
 * sketches have in common estimates how much of their shingles the texts share (Jaccard).
 */
export function sketchOf(key: Uint8Array, text: string): string {
  let seeds = seedCache.get(key);
  if (!seeds) { seeds = seedsOf(key); seedCache.set(key, seeds); }
  const words = wordsOf(text);
  const shingles = new Set<string>();
  if (words.length <= SHINGLE_WORDS) shingles.add(words.join(" "));
  else for (let i = 0; i + SHINGLE_WORDS <= words.length; i++) shingles.add(words.slice(i, i + SHINGLE_WORDS).join(" "));
  const min = new Array<number>(SKETCH_SLOTS).fill(Infinity);
  for (const shingle of shingles) {
    for (let s = 0; s < SKETCH_SLOTS; s++) {
      const h = cyrb53(shingle, seeds[s]!);
      if (h < min[s]!) min[s] = h;
    }
  }
  const bytes = new Uint8Array(SKETCH_SLOTS * 2);
  min.forEach((h, s) => {
    const low = Number.isFinite(h) ? h % 65536 : 0;
    bytes[s * 2] = low >> 8; bytes[s * 2 + 1] = low & 255;
  });
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** How alike two sketches say their texts are: the share of slots that match, from 0 to 1. */
export function sketchSimilarity(a: string, b: string): number {
  const decode = (s: string): Uint8Array => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  const x = decode(a), y = decode(b);
  if (x.length !== y.length || x.length === 0) return 0;
  let same = 0;
  for (let s = 0; s < x.length; s += 2) if (x[s] === y[s] && x[s + 1] === y[s + 1]) same++;
  return same / (x.length / 2);
}

/** A text's first twelve words. */
export function headOf(text: string): string {
  const out: string[] = [];
  for (const part of text.trim().split(/\s+/)) {
    if (out.length === 12) break;
    out.push(part);
  }
  return out.join(" ");
}

export { countWords };
