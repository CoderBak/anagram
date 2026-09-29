// scripts/lintFirefox.mjs — Mozilla's add-on linter over the Firefox build.
//
// `web-ext lint` runs the checks addons.mozilla.org runs on an upload. Here it runs on
// output/firefox-mv2: any error fails, and so does any warning beyond those accepted below.
// Each accepted warning was read and kept on purpose, counted, so that one more of the same
// kind in the same file is looked at too: fix it, or raise the count with its reason.
//
//   npm run lint:firefox            # builds the Firefox target first
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = join(ROOT, "output", "firefox-mv2");

const INNER_HTML = /^Unsafe assignment to innerHTML$/;
const IMPORT = /^Unsafe call to import for argument 0$/;
/** The warnings Anagram's Firefox build carries on purpose, and how many of each. */
const ACCEPTED = [
  {
    code: "UNSAFE_VAR_ASSIGNMENT", message: INNER_HTML, file: /^(content-scripts\/content\.js|chunks\/reader-[\w-]+\.js)$/, count: 8,
    why: "The chip card and the selection card (lib/render/badge.ts, selectionCard.ts): markup " +
      "built from our own messages, band labels and numbers. No page text goes into it.",
  },
  {
    code: "UNSAFE_VAR_ASSIGNMENT", message: INNER_HTML, file: /^vendor\/(purify|defuddle)\.min\.mjs$/, count: 4,
    why: "DOMPurify and Defuddle as published: DOMPurify parses markup to sanitize it, and " +
      "Defuddle writes only what DOMPurify returned.",
  },
  {
    code: "UNSAFE_VAR_ASSIGNMENT", message: INNER_HTML, file: /^vendor\/pdfjs\/web\/viewer\.mjs$/, count: 1,
    why: "The unmodified, hash-pinned PDF.js viewer (vendor/pdfjs/).",
  },
  {
    code: "UNSAFE_VAR_ASSIGNMENT", message: IMPORT,
    file: /^(content-scripts\/content\.js|chunks\/reader-[\w-]+\.js|vendor\/(pdfjs\.min|pdf\.worker)\.mjs|vendor\/pdfjs\/web\/viewer\.mjs|vendor\/document-worker\/worker\.js)$/,
    count: 9,
    why: "import() of files packaged with the extension: our on-demand chunks (runtime.getURL), " +
      "PDF.js's worker and decoders, and the document worker's modules. Nothing remote.",
  },
  {
    code: "UNSAFE_VAR_ASSIGNMENT", message: IMPORT, file: /^vendor\/engine\/(ort\.jspi\.min|worker\.min)\.mjs$/, count: 2,
    why: "ONNX Runtime Web as published: import() of its Emscripten glue, ort-wasm-simd-threaded.jspi.mjs, " +
      "from the extension's own vendor/engine/; and the engine's worker importing that runtime by its " +
      "extension URL (lib/webengine/session.ts). Nothing remote.",
  },
  {
    code: "DANGEROUS_EVAL", file: /^vendor\/(engine\/ort-wasm-simd-threaded\.jspi\.mjs|document-worker\/worker\.js)$/, count: 2,
    why: "ONNX Runtime Web as published, its loader in the engine and inside the document worker's " +
      "bundle: Emscripten embind's method caller builds a function with new Function. The " +
      "extension's CSP has no 'unsafe-eval', so that path throws rather than runs; neither " +
      "reaches it (test/webengine/engine-browser.mjs runs the engine's worker under that CSP, " +
      "and the PDF reader suites run the document worker).",
  },
];

if (!existsSync(join(SOURCE, "manifest.json"))) {
  console.error(`No Firefox build in ${SOURCE}: run npm run build:firefox first.`);
  process.exit(2);
}

const run = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["--no-install", "web-ext", "lint", "--source-dir", SOURCE, "--output", "json", "--no-config-discovery"],
  // No update check: the lint itself is offline.
  { cwd: ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env: { ...process.env, NO_UPDATE_NOTIFIER: "1" }, shell: process.platform === "win32" },
);
let report;
try {
  report = JSON.parse(run.stdout);
} catch {
  console.error(run.stdout, run.stderr);
  console.error("web-ext lint gave no report.");
  process.exit(2);
}

const line = (m) => `  ${m.code}  ${m.file ?? ""}${m.line ? `:${m.line}` : ""}  ${m.message}`;
const errors = report.errors ?? [];
const warnings = report.warnings ?? [];
const matches = (entry, m) => entry.code === m.code && entry.file.test(m.file ?? "") && (!entry.message || entry.message.test(m.message));
const unexpected = warnings.filter((m) => !ACCEPTED.some((entry) => matches(entry, m)));
const over = [], under = [];
for (const entry of ACCEPTED) {
  const found = warnings.filter((m) => matches(entry, m));
  if (found.length > entry.count) over.push(`${entry.count} accepted, ${found.length} found:\n${found.map(line).join("\n")}`);
  else if (found.length < entry.count) under.push(`${entry.code} ${entry.file}: ${entry.count} accepted, ${found.length} left`);
}

if (errors.length) console.log(`Errors:\n${errors.map(line).join("\n")}`);
if (unexpected.length) console.log(`Warnings scripts/lintFirefox.mjs does not accept:\n${unexpected.map(line).join("\n")}`);
if (over.length) console.log(`More of an accepted warning than scripts/lintFirefox.mjs counts:\n${over.join("\n")}`);
if (under.length) console.log(`Fewer than accepted (lower the count):\n  ${under.join("\n  ")}`);
const failed = errors.length > 0 || unexpected.length > 0 || over.length > 0;
console.log(`web-ext lint: ${errors.length} errors, ${warnings.length} warnings (${warnings.length - unexpected.length} accepted), ${(report.notices ?? []).length} notices`);
console.log(failed ? "❌ FIREFOX LINT FAILURES" : "✅ FIREFOX LINT GREEN");
process.exit(failed ? 1 : 0);
