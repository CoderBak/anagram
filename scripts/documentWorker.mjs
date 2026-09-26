// scripts/documentWorker.mjs — Zotero's document-worker, pinned, built and verified.
//
// The PDF reader's paragraphs come from Zotero's document-worker (AGPL-3.0), which has no
// published build: it is a repository with two submodules (Zotero's pdf.js fork, Apache-2.0;
// structured-document-text, AGPL-3.0), an ONNX model pair checked into the tree, and a
// webpack build that emits one Web Worker file. What ships is kept under
// vendor/document-worker/ the way the upstream pdf.js viewer is kept under vendor/pdfjs/:
// the built artefacts are COMMITTED, and upstream.json records the exact commits they came
// from and the SHA-256 of every file, so that every build verifies them and anyone can
// regenerate them with this script. Nothing is downloaded at build time, and nothing ever
// at run time.
//
//   node scripts/documentWorker.mjs             rebuild vendor/document-worker/ from the pin
//   node scripts/documentWorker.mjs --cache <d> …keeping the sources and their node_modules in <d>
//
// The rebuild fetches the three pinned commits as archives from GitHub (a generic User-Agent,
// nothing else), verifies them, drops Anagram's entry (vendor/document-worker/src/) into the
// checkout, runs the worker's own `npm ci` and webpack build, minifies the bundle, copies it
// with the models and the licences into vendor/document-worker/, and writes the hashes back
// into upstream.json. The checkout is left in the cache: test/pdf-bench/zotero-dump.mjs runs
// from it. The ONNX runtime's wasm is not committed: like pdf.js's own data files it comes
// from the npm package (onnxruntime-web, pinned exactly in package.json) at build time, and
// the pin records its hash too.
//
// vendorDocumentWorker(root) is what scripts/vendor.mjs calls on every build: it verifies
// the committed files against the pin and copies what the reader needs into public/vendor/.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR = join(ROOT, "vendor", "document-worker");
const PIN = join(VENDOR, "upstream.json");
const UA = "anagram-vendor/0.1";

/** The model files the block segmentation runs on, as the worker asks for them. */
const MODELS = [
  "block-seg/classifier/model.onnx",
  "block-seg/classifier/stats.bin",
  "block-seg/clusterer/model.onnx",
  "block-seg/clusterer/repair.onnx",
  "block-seg/clusterer/runtime.bin",
];
/** Licences kept beside the artefacts, copied from the checkout: the worker's and its
 *  pdf.js fork's. The ONNX runtime's npm package carries neither its licence (MIT) nor the
 *  notices of the libraries its WebAssembly build links; both are written down here (the
 *  notices are ONNX Runtime's ThirdPartyNotices.txt at the pinned version's tag) and pinned
 *  like the rest. */
const LICENCES = {
  "LICENSE.document-worker": "COPYING",
  "LICENSE.pdf.js": "pdf.js/LICENSE",
};
const ORT_FILES = ["LICENSE.onnxruntime-web", "ThirdPartyNotices.onnxruntime-web.txt"];

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

/** Every file under `dir`, as paths relative to it. */
function list(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const name = prefix + entry.name;
    return entry.isDirectory() ? list(join(dir, entry.name), `${name}/`) : [name];
  }).sort();
}

/**
 * One hash for a set of files: their names and contents, in order. The fork's CMaps,
 * standard fonts and image decoders are the same files pdf.js publishes, so the worker
 * reads them from the reader's copies (public/vendor/) rather than shipping them twice;
 * this is how a build proves they are still the same files.
 */
function treeDigest(dir, keep = () => true) {
  const hash = createHash("sha256");
  for (const name of list(dir)) {
    if (!keep(name)) continue;
    hash.update(`${name}\0${sha256(join(dir, name))}\n`);
  }
  return hash.digest("hex");
}
const SHARED = {
  cmaps: { fork: "pdf.js/external/bcmaps", keep: (n) => n.endsWith(".bcmap") },
  standard_fonts: { fork: "pdf.js/external/standard_fonts", keep: (n) => !/^(README|LICENSE)/.test(n) },
  // The decoders live in two folders in the fork and one in the distribution: hashed by basename.
  wasm: { fork: "pdf.js/external", keep: (n) => /^(openjpeg\/)?openjpeg\.wasm$|^(jbig2\/)?jbig2\.wasm$/.test(n) },
};
function sharedDigest(dir, keep) {
  const hash = createHash("sha256");
  for (const name of list(dir)) {
    if (!keep(name)) continue;
    hash.update(`${name.slice(name.lastIndexOf("/") + 1)}\0${sha256(join(dir, name))}\n`);
  }
  return hash.digest("hex");
}

// ---- verify and copy (every build) ----------------------------------------------------------

export function vendorDocumentWorker(root) {
  const pin = JSON.parse(readFileSync(join(root, "vendor/document-worker/upstream.json"), "utf8"));
  const source = join(root, "vendor/document-worker");
  const expected = Object.keys(pin.files).sort();
  const present = list(source).filter((n) => !n.startsWith("src/") && n !== "upstream.json" && n !== "README.md").sort();
  if (JSON.stringify(present) !== JSON.stringify(expected)) throw new Error(`document-worker vendor inventory does not match its pin: have ${present.join(", ")}; pin ${expected.join(", ")}`);
  for (const [name, digest] of Object.entries(pin.files)) {
    if (sha256(join(source, name)) !== digest) throw new Error(`Modified document-worker artefact: ${name}. Rebuild with scripts/documentWorker.mjs.`);
  }
  const ort = join(root, "node_modules/onnxruntime-web");
  const installed = JSON.parse(readFileSync(join(ort, "package.json"), "utf8")).version;
  if (installed !== pin.onnxruntime_web.version) throw new Error(`onnxruntime-web ${pin.onnxruntime_web.version} is pinned; ${installed} is installed`);
  const wasm = join(ort, pin.onnxruntime_web.file);
  if (sha256(wasm) !== pin.onnxruntime_web.sha256) throw new Error(`onnxruntime-web ${installed} ships a different ${pin.onnxruntime_web.file} than the pin records`);
  for (const [name, digest] of Object.entries(pin.shared)) {
    const mine = sharedDigest(join(root, "public/vendor", name), SHARED[name].keep);
    if (mine !== digest) throw new Error(`public/vendor/${name} no longer matches the pdf.js fork's copy that document-worker was built with; vendor the fork's files or re-pin`);
  }
  const output = join(root, "public/vendor/document-worker");
  rmSync(output, { recursive: true, force: true });
  mkdirSync(join(output, "onnx"), { recursive: true });
  let bytes = 0;
  for (const name of expected) {
    mkdirSync(dirname(join(output, name)), { recursive: true });
    cpSync(join(source, name), join(output, name));
    bytes += statSync(join(output, name)).size;
  }
  cpSync(wasm, join(output, "onnx", "ort-wasm-simd-threaded.wasm"));
  bytes += statSync(wasm).size;
  console.log(`vendor/document-worker/  ${expected.length + 1} files, ${(bytes / 1024).toFixed(1)} kB (onnxruntime-web ${installed})`);
}

// ---- rebuild (by hand, when the pin moves) -------------------------------------------------

async function fetchArchive(url, target, expected) {
  if (!existsSync(target)) {
    console.log(`fetching ${url}`);
    const response = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  }
  const digest = sha256(target);
  if (expected && digest !== expected) throw new Error(`${target}: SHA-256 ${digest}, pin says ${expected}`);
  return digest;
}

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit", shell: process.platform === "win32" });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed in ${cwd}`);
}

async function rebuild(cache) {
  const pin = JSON.parse(readFileSync(PIN, "utf8"));
  mkdirSync(cache, { recursive: true });
  const archive = (repo, commit) => `${repo.replace("https://github.com/", "https://codeload.github.com/")}/tar.gz/${commit}`;
  const checkout = join(cache, `document-worker-${pin.commit.slice(0, 7)}`);
  const unpack = (tarball, into) => {
    mkdirSync(into, { recursive: true });
    run("tar", ["-xzf", tarball, "-C", into, "--strip-components=1"]);
  };
  const main = join(cache, `document-worker-${pin.commit}.tar.gz`);
  pin.archive_sha256 = await fetchArchive(archive(pin.repository, pin.commit), main, pin.archive_sha256);
  if (!existsSync(join(checkout, "package.json"))) unpack(main, checkout);
  for (const [name, sub] of Object.entries(pin.submodules)) {
    const tarball = join(cache, `${name}-${sub.commit}.tar.gz`);
    sub.archive_sha256 = await fetchArchive(archive(sub.repository, sub.commit), tarball, sub.archive_sha256);
    if (!existsSync(join(checkout, name, "package.json"))) unpack(tarball, join(checkout, name));
  }

  // Anagram's entry, beside the worker's own sources, built by the worker's own toolchain.
  cpSync(join(VENDOR, "src"), join(checkout, "anagram"), { recursive: true });
  if (!existsSync(join(checkout, "node_modules"))) run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], checkout);
  run("npx", ["webpack", "--mode", "production", "--config", "anagram/webpack.config.cjs"], checkout);

  // Minified here: the worker's bundle is unminified by design (Zotero reads it in its
  // own tree), and a third of the size is a third of the extension's parse time.
  const { build } = await import("esbuild");
  for (const name of Object.keys(pin.files)) if (!ORT_FILES.includes(name)) rmSync(join(VENDOR, name), { force: true });
  await build({
    entryPoints: [join(checkout, "build", "anagram-worker.js")],
    minify: true, bundle: false, outfile: join(VENDOR, "worker.js"), logLevel: "error",
    banner: { js: `/* Zotero document-worker ${pin.commit.slice(0, 7)} (AGPL-3.0, https://github.com/zotero/document-worker) with its pdf.js fork ${pin.submodules["pdf.js"].commit.slice(0, 7)} (Apache-2.0) and onnxruntime-web ${pin.onnxruntime_web.version} (MIT); built by scripts/documentWorker.mjs. */` },
  });
  for (const name of MODELS) {
    mkdirSync(dirname(join(VENDOR, name)), { recursive: true });
    cpSync(join(checkout, "src/pdf/structure/model", name), join(VENDOR, name));
  }
  for (const [name, from] of Object.entries(LICENCES)) cpSync(join(checkout, from), join(VENDOR, name));

  pin.files = {};
  for (const name of ["worker.js", ...MODELS, ...Object.keys(LICENCES), ...ORT_FILES].sort()) pin.files[name] = sha256(join(VENDOR, name));
  pin.shared = {};
  for (const [name, { fork, keep }] of Object.entries(SHARED)) pin.shared[name] = sharedDigest(join(checkout, fork), keep);
  const ortVersion = JSON.parse(readFileSync(join(checkout, "node_modules/onnxruntime-web/package.json"), "utf8")).version;
  if (ortVersion !== pin.onnxruntime_web.version) throw new Error(`the worker's lockfile installs onnxruntime-web ${ortVersion}; pin ${pin.onnxruntime_web.version} in upstream.json and package.json`);
  pin.onnxruntime_web.sha256 = sha256(join(checkout, "node_modules/onnxruntime-web", pin.onnxruntime_web.file));
  writeFileSync(PIN, `${JSON.stringify(pin, null, 2)}\n`);
  console.log(`vendor/document-worker rebuilt from ${pin.commit.slice(0, 7)}; checkout kept in ${checkout}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const at = process.argv.indexOf("--cache");
  await rebuild(at >= 0 ? process.argv[at + 1] : join(ROOT, ".cache", "document-worker"));
}
