// scripts/confusables.mjs — lib/dom/confusables.json, from Unicode's confusables.txt.
//
// A text can be disguised by writing Cyrillic or Greek look-alikes inside English words
// (RAID's homoglyph attack): fastText then calls the text Ukrainian and the language gate
// refuses it. modelText (lib/dom/text.ts) folds those letters back to the Latin ones they
// imitate, and this is its table: the letters of UTS #39's confusables.txt, at the pinned
// Unicode version and hash, that are confusable with ONE ASCII letter or digit, from the
// alphabets that imitate Latin letters (SCRIPTS). Nothing else of the file is kept.
//
// confusables.txt maps each character to a prototype: "Ι" (Greek capital iota), "І"
// (Cyrillic) and "1" all go to "l", the prototype of the I-l-1 class. A prototype names a
// class, not the letter meant, so each source takes the ASCII member of its class that has
// its own case: an upper-case source the capital (Ι → I), a lower-case one the small letter
// (ӏ → l); where its class has none, the prototype itself (З → 3).
//
//   node scripts/confusables.mjs                 fetch the pinned file and rewrite the table
//   node scripts/confusables.mjs --file <path>   the same from a copy already on disk
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "lib", "dom", "confusables.json");
export const UNICODE_VERSION = "18.0.0";
export const SOURCE_URL = `https://www.unicode.org/Public/${UNICODE_VERSION}/security/confusables.txt`;
export const SOURCE_SHA256 = "6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92";
/** The alphabets whose letters stand in for Latin ones. */
export const SCRIPTS = ["Greek", "Coptic", "Cyrillic", "Armenian", "Cherokee", "Lisu"];

const ASCII = /^[A-Za-z0-9]$/;
const inScripts = new RegExp(`^[${SCRIPTS.map((s) => `\\p{Script=${s}}`).join("")}]$`, "u");
const codes = (field) => String.fromCodePoint(...field.trim().split(/\s+/).map((h) => parseInt(h, 16)));

/** The table from the text of confusables.txt: { source letter: ASCII letter or digit }. */
export function table(text) {
  const prototype = new Map();
  for (const line of text.split("\n")) {
    const m = /^([0-9A-F][0-9A-F ]*);\s*([0-9A-F][0-9A-F ]*);\s*MA\b/.exec(line);
    if (m) prototype.set(codes(m[1]), codes(m[2]));
  }
  const members = new Map();
  for (const [source, proto] of prototype) {
    if (!members.has(proto)) members.set(proto, [proto]);
    members.get(proto).push(source);
  }
  const out = {};
  for (const [source, proto] of prototype) {
    // One letter of the Basic Multilingual Plane: folding keeps a text's length.
    if (source.length !== 1 || !/\p{L}/u.test(source) || !inScripts.test(source)) continue;
    const ascii = members.get(proto).filter((c) => ASCII.test(c));
    if (ascii.length === 0) continue;
    // Lisu's letters (no case) are shaped like capitals.
    const cased = ascii.find((c) => (/\p{Ll}/u.test(source) ? /[a-z]/ : /[A-Z]/).test(c));
    out[source] = cased ?? (ASCII.test(proto) ? proto : ascii[0]);
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.codePointAt(0) - b.codePointAt(0)));
}

async function main() {
  const at = process.argv.indexOf("--file");
  let bytes;
  if (at > 0) bytes = readFileSync(process.argv[at + 1]);
  else {
    const res = await fetch(SOURCE_URL, { headers: { "User-Agent": "anagram-vendor/0.1" } });
    if (!res.ok) throw new Error(`${SOURCE_URL}: HTTP ${res.status}`);
    bytes = Buffer.from(await res.arrayBuffer());
  }
  const got = createHash("sha256").update(bytes).digest("hex");
  if (got !== SOURCE_SHA256) throw new Error(`confusables.txt has SHA-256 ${got}, the pin is ${SOURCE_SHA256}`);
  const fold = table(bytes.toString("utf8"));
  const data = { unicode: UNICODE_VERSION, source: SOURCE_URL, sha256: SOURCE_SHA256, scripts: SCRIPTS, fold };
  writeFileSync(OUT, `${JSON.stringify(data, null, 1)}\n`);
  console.log(`lib/dom/confusables.json: ${Object.keys(fold).length} letters from Unicode ${UNICODE_VERSION}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
