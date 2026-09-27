// scripts/webengine.mjs — the in-browser engine's files under public-oneclick/vendor/engine/.
//
// Two things, on every oneclick build (scripts/vendor.mjs calls vendorWebEngine in that
// flavor; the engine's own suites call it too):
//   · ONNX Runtime Web, copied verbatim from the pinned onnxruntime-web package: the
//     library module (ort.min.mjs, the build that loads its WebAssembly from files rather
//     than embedding it, so the loader runs from an extension URL under the manifest's
//     CSP), its loader (ort-wasm-simd-threaded.jsep.mjs) and the one binary that carries
//     both execution providers, WebGPU and CPU (ort-wasm-simd-threaded.jsep.wasm);
//   · the engine's worker (worker.min.mjs), bundled by esbuild from lib/webengine/worker.ts
//     the way the diagnostics chunk is. It is our own code with our own JSON data and must
//     take nothing from node_modules: the runtime is imported at run time by URL, and a
//     bundled npm package would need a notice; the metafile check refuses one.
//
//   node scripts/webengine.mjs      rebuild public-oneclick/vendor/engine/
import { build } from "esbuild";
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ONECLICK_PUBLIC } from "./flavor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/** The runtime files, from node_modules/onnxruntime-web/dist. */
export const ORT_FILES = ["ort.min.mjs", "ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];
/** The runtime's licence and the notices of what its WebAssembly links, kept by the document-worker pin. */
const LICENCES = ["LICENSE.onnxruntime-web", "ThirdPartyNotices.onnxruntime-web.txt"];

/** Where the files go, under the root. */
export const ENGINE_DIR = join(ONECLICK_PUBLIC, "vendor", "engine");

export async function vendorWebEngine(root) {
  const out = join(root, ENGINE_DIR);
  rmSync(join(root, ONECLICK_PUBLIC), { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  for (const name of ORT_FILES) copyFileSync(join(root, "node_modules", "onnxruntime-web", "dist", name), join(out, name));
  for (const name of LICENCES) copyFileSync(join(root, "vendor", "document-worker", name), join(out, name));
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
  const sizes = [...ORT_FILES, "worker.min.mjs"].map((name) => `${name} ${(statSync(join(out, name)).size / 1024).toFixed(0)} kB`);
  const version = JSON.parse(readFileSync(join(root, "node_modules", "onnxruntime-web", "package.json"), "utf8")).version;
  console.log(`${ENGINE_DIR}/  ${sizes.join(", ")} (onnxruntime-web ${version}, oneclick flavor)`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await vendorWebEngine(join(HERE, ".."));
}
