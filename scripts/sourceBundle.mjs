// scripts/sourceBundle.mjs — the source Firefox Add-ons asks for beside the extension.
//
// addons.mozilla.org reviews the source of an extension whose files are bundled or minified,
// and rebuilds it. `npm run source-bundle` writes dist/anagram-source-<version>.zip: `git
// archive` of HEAD, so only what is committed goes in and nothing untracked can, without the
// suites and their data (test/: fixtures, benchmarks), which no build reads, and with
// BUILDING.md at its root saying how to build it. Every file of it passes the machine-path
// guard (scripts/machinePaths.mjs) before the zip is written. A build from the zip's steps
// matches output/firefox-mv2 of this tree byte for byte.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { machinePaths, machinePathsIn } from "./machinePaths.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const git = (...args) => execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
/** What the zip leaves out: the suites and their data. */
const EXCLUDED = ["test"];
const PATHS = [".", ...EXCLUDED.map((path) => `:(exclude)${path}`)];
/** The Node.js the project builds with (docs/DEVELOPMENT.md). */
const NODE = "22";

const { version } = JSON.parse(git("show", "HEAD:package.json"));
const name = `anagram-source-${version}`;
const commit = git("rev-parse", "HEAD").trim();

const BUILDING = `# Building Anagram for Firefox ${version}

This is the source of the Firefox package of Anagram ${version} (commit ${commit}). Built as
below, output/firefox-mv2/ holds the package's files, byte for byte.

1. Install Node.js ${NODE} (this was made with ${process.version}) and its npm, on macOS or Linux.
2. In this folder, run \`npm ci\`. It installs the exact versions in package-lock.json, and
   its postinstall step prepares the vendored files, checking each against its pinned hash.
   It downloads fastText's language identifier (lid.176.ftz) once, from
   dl.fbaipublicfiles.com, and takes no other bytes than the pinned ones.
3. Run \`npm run build:firefox\`.
4. The extension is in output/firefox-mv2/ (manifest.json at its root).

The PDF reader's paragraph worker is committed prebuilt: vendor/document-worker/README.md
says how it is rebuilt from its pinned sources.
`;

if (git("status", "--porcelain", "--untracked-files=no").trim()) {
  console.warn("The working tree has changes that are not committed: the zip holds HEAD, without them.");
}

// The guard, over exactly what goes in: the archive unpacked, and BUILDING.md.
const check = mkdtempSync(join(tmpdir(), "anagram-source-"));
try {
  execFileSync("tar", ["-x", "-C", check], { input: execFileSync("git", ["archive", "--format=tar", "HEAD", "--", ...PATHS], { cwd: ROOT, maxBuffer: 1 << 28 }) });
  const leaks = [...machinePaths(check), ...machinePathsIn(BUILDING).map((path) => `BUILDING.md: ${path}`)];
  if (leaks.length > 0) throw new Error(`The source carries paths of this machine (scripts/machinePaths.mjs):\n  ${leaks.join("\n  ")}`);
} finally {
  rmSync(check, { recursive: true, force: true });
}

mkdirSync(join(ROOT, "dist"), { recursive: true });
const zip = join(ROOT, "dist", `${name}.zip`);
rmSync(zip, { force: true });
git("archive", "--format=zip", `--prefix=${name}/`, `--add-virtual-file=${name}/BUILDING.md:${BUILDING}`, "-o", zip, "HEAD", "--", ...PATHS);
console.log(`dist/${name}.zip  ${(statSync(zip).size / 1e6).toFixed(1)} MB  (HEAD ${commit.slice(0, 7)}, without ${EXCLUDED.join(", ")})`);
