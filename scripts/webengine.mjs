// scripts/webengine.mjs — the in-browser engine's files under public-oneclick/vendor/engine/.
//
// Three things, on every oneclick build (scripts/vendor.mjs calls vendorWebEngine in that
// flavor; the engine's own suites call it too):
//   · ONNX Runtime Web, copied verbatim from the npm package installed under the alias
//     onnxruntime-web-engine (package.json): the engine's own pin, apart from the
//     onnxruntime-web that Zotero's document-worker is built with and verified against
//     (scripts/documentWorker.mjs), because the engine needs a newer one. From 1.29 the
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
//     faster than its Asyncify one. JSPI needs Chrome 137 or Firefox 139, and Firefox
//     140 ESR ships without it, so the package's plain WebAssembly build (ort.wasm.min.mjs,
//     ort-wasm-simd-threaded.mjs and .wasm: the CPU provider only) goes beside it for a
//     browser that has no JSPI; lib/webengine/session.ts picks. The package carries no
//     licence file: its MIT licence is the document-worker pin's copy (the same text at
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
//   node scripts/webengine.mjs      rebuild public-oneclick/vendor/engine/
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ONECLICK_PUBLIC } from "./flavor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The engine's runtime package: an alias of onnxruntime-web (package.json). */
export const ORT_PACKAGE = "onnxruntime-web-engine";
/** The runtime files, from node_modules/onnxruntime-web-engine/dist. */
export const ORT_FILES = ["ort.jspi.min.mjs", "ort-wasm-simd-threaded.jspi.mjs", "ort-wasm-simd-threaded.jspi.wasm", "ort.wasm.min.mjs", "ort-wasm-simd-threaded.mjs", "ort-wasm-simd-threaded.wasm"];

/** Where the files go, under the root. */
export const ENGINE_DIR = join(ONECLICK_PUBLIC, "vendor", "engine");

/** The language identifier the package carries: download_modelkit.py's LID_URL and LID_ENTRY. */
export const LID = {
  name: "lid.176.ftz",
  url: "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz",
  size_bytes: 938013,
  sha256: "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83",
};
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
  rmSync(join(root, ONECLICK_PUBLIC), { recursive: true, force: true });
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
    target: ["chrome110", "firefox128"],
    outfile: join(out, "worker.min.mjs"),
    logLevel: "error",
    metafile: true,
  });
  const foreign = Object.values(metafile.outputs).flatMap((o) => Object.keys(o.inputs)).filter((id) => id.includes("node_modules/"));
  if (foreign.length > 0) throw new Error(`${ENGINE_DIR}/worker.min.mjs bundles code from node_modules, which needs a notice and its own chunk:\n  ${foreign.join("\n  ")}`);
  const sizes = [...ORT_FILES, "worker.min.mjs", LID.name].map((name) => `${name} ${(statSync(join(out, name)).size / 1024).toFixed(0)} kB`);
  console.log(`${ENGINE_DIR}/  ${sizes.join(", ")} (onnxruntime-web ${version}, oneclick flavor)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await vendorWebEngine(join(HERE, ".."));
}
