// scripts/webengine.mjs — the in-browser engine's files under public/vendor/engine/.
//
// Three things, on every build (scripts/vendor.mjs calls vendorWebEngine; the engine's own
// suites call it too):
//   · ONNX Runtime Web, copied verbatim from the npm package (package.json): the one pin,
//     which Zotero's document-worker is built with and verified against too
//     (scripts/documentWorker.mjs), and whose one WebAssembly binary it reads. From 1.29 the
//     JSPI build reads a model's external data from a Blob one tensor at a time, straight
//     onto the GPU, so the weights never sit whole in the worker's memory
//     (lib/webengine/onnx.ts, session.ts). What is copied: the library module of its
//     native WebGPU execution provider in the JSPI build (ort.jspi.min.mjs, the variant
//     that loads its WebAssembly from files rather than embedding it, so the loader runs
//     from an extension URL under the manifest's CSP), its loader
//     (ort-wasm-simd-threaded.jspi.mjs) and the one binary that carries both execution
//     providers, WebGPU and CPU (ort-wasm-simd-threaded.jspi.wasm). Not the package's
//     default JSEP build: on this model its WebGPU kernels answer wrongly
//     (test/webengine/parity.mjs found every text off; ORT 1.27 and 1.30 alike), the
//     native provider answers as the CPU does, and its JSPI variant runs several times
//     faster than its Asyncify one. JSPI is in Chrome 137 and in
//     Firefox 153, the manifests' minimums, so the package's plain WebAssembly build is not
//     copied: this one binary serves the CPU path and the document-worker too. The package carries no licence file: its
//     MIT licence is the document-worker pin's copy (the same text at
//     every tag) and the notices of the libraries its WebAssembly links are ONNX Runtime's
//     ThirdPartyNotices.txt at the installed version's tag, kept in scripts/licences/.
//   · the engine's worker (worker.min.mjs), bundled by esbuild from lib/webengine/worker.ts
//     the way the diagnostics chunk is. It is our own code with our own JSON data and must
//     take nothing from node_modules: the runtime is imported at run time by URL, and a
//     bundled npm package would need a notice; the metafile check refuses one.
//   · fastText's language identifier (lid.176.ftz, CC BY-SA 3.0, listed in
//     THIRD_PARTY_NOTICES.md), which the engine reads from the package instead of
//     downloading it: fastText's host sends no CORS headers, so a download would need a host
//     permission. Fetched once from its pinned address into .cache/ (gitignored, never
//     committed), checked against the pinned size and SHA-256 on every build, and the build
//     fails on any other bytes. lib/webengine/pin.ts pins the same file for the engine, which
//     checks it again whenever it loads the model.
//
//   node scripts/webengine.mjs      rebuild public/vendor/engine/
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The runtime package (package.json): the engine's and the PDF document-worker's. */
export const ORT_PACKAGE = "onnxruntime-web";
/** The runtime files, from node_modules/onnxruntime-web/dist. */
export const ORT_FILES = ["ort.jspi.min.mjs", "ort-wasm-simd-threaded.jspi.mjs", "ort-wasm-simd-threaded.jspi.wasm"];

/** Where the files go, under the root. */
export const ENGINE_DIR = join("public", "vendor", "engine");

/** The language identifier the package carries, as the engine contract pins it. */
const { path: lidName, url: lidUrl, size_bytes: lidSize, sha256: lidSha } =
  JSON.parse(readFileSync(new URL("../anagramd/contract.json", import.meta.url), "utf8")).language_id;
export const LID = { name: lidName, url: lidUrl, size_bytes: lidSize, sha256: lidSha };
const LID_CACHE = join(".cache", "fasttext", LID.name);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pinned = (bytes) => bytes.length === LID.size_bytes && sha256(bytes) === LID.sha256;

/** lid.176.ftz from the cache, fetched from its pinned address when it is not there; refuses other bytes. */
export async function packagedLid(root) {
  const cached = join(root, LID_CACHE);
  if (existsSync(cached)) {
    if (pinned(readFileSync(cached))) return cached;
    rmSync(cached);
  }
  console.log(`fetching ${LID.url}`);
  const response = await fetch(LID.url, { headers: { "User-Agent": "anagram-vendor/0.1" }, redirect: "follow" });
  if (!response.ok) throw new Error(`${LID.url}: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!pinned(bytes)) throw new Error(`${LID.url} is not the pinned ${LID.name}: ${bytes.length} bytes, SHA-256 ${sha256(bytes)}; the pin says ${LID.size_bytes} bytes, ${LID.sha256}`);
  mkdirSync(join(root, ".cache", "fasttext"), { recursive: true });
  writeFileSync(`${cached}.part`, bytes);
  renameSync(`${cached}.part`, cached);
  return cached;
}

export async function vendorWebEngine(root) {
  const out = join(root, ENGINE_DIR);
  const version = JSON.parse(readFileSync(join(root, "node_modules", ORT_PACKAGE, "package.json"), "utf8")).version;
  const notices = join(root, "scripts", "licences", `ThirdPartyNotices.onnxruntime-web-${version}.txt`);
  if (!existsSync(notices)) throw new Error(`${ORT_PACKAGE} is onnxruntime-web ${version}: put ONNX Runtime's ThirdPartyNotices.txt at tag v${version} in ${notices}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const name of ORT_FILES) copyFileSync(join(root, "node_modules", ORT_PACKAGE, "dist", name), join(out, name));
  copyFileSync(join(root, "vendor", "document-worker", "LICENSE.onnxruntime-web"), join(out, "LICENSE.onnxruntime-web"));
  copyFileSync(notices, join(out, "ThirdPartyNotices.onnxruntime-web.txt"));
  copyFileSync(await packagedLid(root), join(out, LID.name));
  const { metafile } = await build({
    entryPoints: [join(root, "lib", "webengine", "worker.ts")],
    bundle: true,
    format: "esm",
    minify: true,
    target: ["chrome110", "firefox128", "safari27"],
    outfile: join(out, "worker.min.mjs"),
    logLevel: "error",
    metafile: true,
  });
  const foreign = Object.values(metafile.outputs).flatMap((o) => Object.keys(o.inputs)).filter((id) => id.includes("node_modules/"));
  if (foreign.length > 0) throw new Error(`${ENGINE_DIR}/worker.min.mjs bundles code from node_modules, which needs a notice and its own chunk:\n  ${foreign.join("\n  ")}`);
  const sizes = [...ORT_FILES, "worker.min.mjs", LID.name].map((name) => `${name} ${(statSync(join(out, name)).size / 1024).toFixed(0)} kB`);
  console.log(`${ENGINE_DIR}/  ${sizes.join(", ")} (onnxruntime-web ${version})`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await vendorWebEngine(join(HERE, ".."));
}
