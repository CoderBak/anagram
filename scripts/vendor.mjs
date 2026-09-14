// scripts/vendor.mjs — prebuild the on-demand vendor chunks into public/vendor/.
//
// Readability (main-content scope) and DOMPurify (Google Docs reading mode) are only
// needed on demand, so they are NOT bundled into the content script that runs on every
// page. They are built here as minified ESM files, shipped as web-accessible resources,
// and loaded with a dynamic import() of their extension URL (lib/lazy.ts) the first
// time a feature needs them. Runs on postinstall and before every build.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, statSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "public", "vendor");
mkdirSync(OUT, { recursive: true });

const chunks = {
  // @mozilla/readability is CommonJS; a tiny ESM wrapper gives it named exports.
  "readability.min.mjs": `
    import mod from "@mozilla/readability";
    export const Readability = mod.Readability;
    export const isProbablyReaderable = mod.isProbablyReaderable;
  `,
  "purify.min.mjs": `export { default } from "dompurify";`,
};

for (const [file, contents] of Object.entries(chunks)) {
  await build({
    stdin: { contents, resolveDir: ROOT, loader: "js" },
    bundle: true,
    format: "esm",
    minify: true,
    target: ["chrome110", "firefox128"],
    outfile: join(OUT, file),
    logLevel: "error",
  });
  console.log(`vendor/${file}  ${(statSync(join(OUT, file)).size / 1024).toFixed(1)} kB`);
}
