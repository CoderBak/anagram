// test/webengine/text-check.mjs — the browser engine's cleaning and tokenizer against the
// engine's Python, on the reference file test/webengine/text-reference.py writes.
//
//   node test/webengine/text-check.mjs <modelkit dir or tokenizer.json> <reference.jsonl>
//
// Every text is cleaned and tokenized by lib/webengine/clean.ts and tokenizer.ts, in
// Node, and each hash and count must equal the Python's. Prints the first mismatches
// and exits 1 on any. Never part of CI: the reference needs the official data.
import { buildSync } from "esbuild";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const [kitArg, referencePath] = process.argv.slice(2);
if (!kitArg || !referencePath) {
  console.error("usage: node test/webengine/text-check.mjs <modelkit dir or tokenizer.json> <reference.jsonl>");
  process.exit(2);
}
const tokenizerPath = statSync(kitArg).isDirectory() ? join(kitArg, "tokenizer.json") : kitArg;
if (!existsSync(tokenizerPath) || !existsSync(referencePath)) {
  console.log("SKIP  text check — tokenizer.json or the reference file is missing");
  process.exit(0);
}

const bundle = join(tmpdir(), `anagram-text-check-${process.pid}.mjs`);
buildSync({
  stdin: { contents: 'export { cleanText } from "./lib/webengine/clean"; export { Tokenizer } from "./lib/webengine/tokenizer";', resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "esm", outfile: bundle, logLevel: "error",
});
const { cleanText, Tokenizer } = await import(pathToFileURL(bundle).href);
const tokenizer = new Tokenizer(JSON.parse(readFileSync(tokenizerPath, "utf8")));
const sha = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");

let n = 0;
const failures = [];
for (const line of readFileSync(referencePath, "utf8").split("\n")) {
  if (!line) continue;
  const row = JSON.parse(line);
  n++;
  const cleaned = cleanText(row.text);
  const problems = [];
  if (sha(cleaned) !== row.clean) problems.push(`clean (length ${cleaned.length} vs ${row.clean_len})`);
  const alone = tokenizer.encode(cleaned, false);
  const special = tokenizer.encode(cleaned, true);
  const following = cleaned ? tokenizer.encode(" " + cleaned, false).length : 0;
  if (sha(alone) !== row.ids) problems.push("ids");
  if (sha(special) !== row.special) problems.push("ids with special tokens");
  if (alone.length !== row.alone) problems.push(`alone ${alone.length} vs ${row.alone}`);
  if (following !== row.following) problems.push(`following ${following} vs ${row.following}`);
  if (problems.length) failures.push(`${JSON.stringify(row.text.slice(0, 80))}: ${problems.join(", ")}`);
}
for (const failure of failures.slice(0, 20)) console.log("MISMATCH  " + failure);
if (failures.length) {
  console.log(`FAIL  text check — ${failures.length} of ${n} texts differ`);
  process.exit(1);
}
console.log(`PASS  text check — ${n} texts: cleaning, ids (with and without special tokens) and both counts identical`);
