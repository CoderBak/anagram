// scripts/buildStamp.mjs — whether a test build in output-test/ is the build of what is here now.
//
// scripts/buildTest.mjs writes a stamp beside each build it finishes: the SHA-256 of every
// file the build is made from (the sources, the configuration and the lockfile, the node
// that ran it). test/test-build.mjs builds again unless the stamp matches what is on disk
// now. Contents, not times: `npm run build` rewrites public/vendor/ with the same bytes, and
// a checkout can leave a file older than the build it changed. A build that fails, or whose
// inputs change while it runs, leaves no stamp, and the next suite builds again.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Everything a build reads from the tree. */
const INPUTS = ["entrypoints", "lib", "public", "scripts", "vendor", "wxt.config.ts", "tsconfig.json", "package.json", "package-lock.json",
  "LICENSE", "THIRD_PARTY_NOTICES.md"];

/** The hash of every input's path and bytes, in a fixed order. */
export function inputsHash(root) {
  const hash = createHash("sha256");
  hash.update(`node ${process.version} ${process.platform} ${process.arch}\n`);
  const walk = (rel) => {
    let stat;
    try { stat = statSync(join(root, rel)); } catch { hash.update(`absent ${rel}\n`); return; }
    if (stat.isDirectory()) {
      for (const name of readdirSync(join(root, rel)).sort()) walk(`${rel}/${name}`);
      return;
    }
    hash.update(`${rel} ${stat.size}\n`);
    hash.update(readFileSync(join(root, rel)));
  };
  for (const input of INPUTS) walk(input);
  return hash.digest("hex");
}

/** Where the stamp of output-test/<dir> is kept: beside it, not in the extension it loads. */
const stampOf = (out, dir) => join(out, `${dir}.stamp`);

export function readStamp(out, dir) {
  try { return JSON.parse(readFileSync(stampOf(out, dir), "utf8")).inputs ?? null; } catch { return null; }
}

export function writeStamp(out, dir, inputs) {
  writeFileSync(stampOf(out, dir), JSON.stringify({ inputs }) + "\n");
}

export function clearStamp(out, dir) {
  rmSync(stampOf(out, dir), { force: true });
}
