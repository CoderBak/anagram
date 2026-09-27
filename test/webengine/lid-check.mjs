// test/webengine/lid-check.mjs — the browser's fastText port against the native gate, on
// the reference file test/webengine/lid-reference.py writes.
//
//   node test/webengine/lid-check.mjs <lid.176.ftz> <reference.jsonl>
//
// Every text is predicted by lib/webengine/fasttext.ts in Node. The label must be the
// same, and the probability the same after the engine's rounding to three places; the
// largest raw difference is reported. Exits 1 on any disagreement. Never part of CI.
import { buildSync } from "esbuild";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..");
const [modelPath, referencePath] = process.argv.slice(2);
if (!modelPath || !referencePath) {
  console.error("usage: node test/webengine/lid-check.mjs <lid.176.ftz> <reference.jsonl>");
  process.exit(2);
}
if (!existsSync(modelPath) || !existsSync(referencePath)) {
  console.log("SKIP  language-gate check — lid.176.ftz or the reference file is missing");
  process.exit(0);
}
const bundle = join(tmpdir(), `anagram-lid-check-${process.pid}.mjs`);
buildSync({
  stdin: { contents: 'export { FastText } from "./lib/webengine/fasttext"; export { pyRound } from "./lib/webengine/scoring";', resolveDir: ROOT, loader: "ts" },
  bundle: true, format: "esm", outfile: bundle, logLevel: "error",
});
const { FastText, pyRound } = await import(pathToFileURL(bundle).href);
const began = performance.now();
const lid = new FastText(new Uint8Array(readFileSync(modelPath)));
const loadMs = performance.now() - began;

let n = 0, labels = 0, rounded = 0, maxDiff = 0;
const failures = [];
const t0 = performance.now();
for (const line of readFileSync(referencePath, "utf8").split("\n")) {
  if (!line) continue;
  const row = JSON.parse(line);
  n++;
  const got = lid.predict(row.text.replace(/\n/g, " ")) ?? { label: "und", prob: 0 };
  const sameLabel = got.label === row.label;
  const sameRounded = pyRound(got.prob, 3) === pyRound(row.prob, 3);
  labels += sameLabel;
  rounded += sameRounded;
  maxDiff = Math.max(maxDiff, Math.abs(got.prob - row.prob));
  if (!sameLabel || !sameRounded) failures.push(`${JSON.stringify(row.text.slice(0, 60))}: native ${row.label} ${row.prob.toFixed(6)}, browser ${got.label} ${got.prob.toFixed(6)}`);
}
const ms = performance.now() - t0;
for (const failure of failures.slice(0, 20)) console.log("MISMATCH  " + failure);
console.log(`load ${loadMs.toFixed(0)} ms, ${n} texts in ${ms.toFixed(0)} ms (${(ms / n).toFixed(3)} ms each), max |Δprob| ${maxDiff.toExponential(2)}`);
if (failures.length) {
  console.log(`FAIL  language gate — ${failures.length} of ${n} decisions differ (${labels} labels, ${rounded} rounded probabilities agree)`);
  process.exit(1);
}
console.log(`PASS  language gate — ${n} texts: labels and rounded probabilities identical`);
