// scripts/release.mjs — build the release assets the installer consumes:
//   dist/anagram.tar.gz          app/ (daemon + uv.lock) · extension/ (chrome-mv3) · bin/anagram · install.sh · VERSION
//   dist/anagram.tar.gz.sha256
//   dist/anagram-chrome-<ver>.zip   the store-submittable extension
//   dist/install.sh              (token placeholder substituted from ANAGRAM_HF_TOKEN when set)
// Usage: node scripts/release.mjs        (runs the extension build first)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

execFileSync("npm", ["run", "build"], { cwd: ROOT, stdio: "inherit" });
execFileSync("npm", ["run", "zip"], { cwd: ROOT, stdio: "inherit" });

rmSync(DIST, { recursive: true, force: true });
const stage = join(DIST, "stage", "anagram");
mkdirSync(join(stage, "bin"), { recursive: true });
mkdirSync(join(stage, "app"), { recursive: true });

// bench.py is NOT in this list. It needs three packages from the `bench` extra, which
// `uv sync --no-dev` never installs, and it looks for its checkpoints beside the
// REPOSITORY rather than inside the installation — so in a tarball it is a file that
// cannot be run, whose only other effect was that a developer tool shipped to users.
// (train_head.py is in the same position today: nothing in serve.py imports it. It is
// left here for now — that is a separate decision from this one.)
for (const f of ["serve.py", "train_head.py", "pyproject.toml", "uv.lock", "requirements.txt", "run.sh", "README.md"]) {
  cpSync(join(ROOT, "anagramd", f), join(stage, "app", f));
}
cpSync(join(ROOT, "output", "chrome-mv3"), join(stage, "extension"), { recursive: true });
cpSync(join(ROOT, "installer", "anagram"), join(stage, "bin", "anagram"));
let installer = readFileSync(join(ROOT, "install.sh"), "utf8");
if (process.env.ANAGRAM_HF_TOKEN) installer = installer.replace("__ANAGRAM_HF_TOKEN__", process.env.ANAGRAM_HF_TOKEN);
writeFileSync(join(stage, "install.sh"), installer);
writeFileSync(join(DIST, "install.sh"), installer);
writeFileSync(join(stage, "VERSION"), version + "\n");

execFileSync("tar", ["-czf", join(DIST, "anagram.tar.gz"), "-C", join(DIST, "stage"), "anagram"], { stdio: "inherit" });
const sha = createHash("sha256").update(readFileSync(join(DIST, "anagram.tar.gz"))).digest("hex");
writeFileSync(join(DIST, "anagram.tar.gz.sha256"), `${sha}  anagram.tar.gz\n`);
const zip = join(ROOT, "output", `anagram-extension-${version}-chrome.zip`);
if (existsSync(zip)) cpSync(zip, join(DIST, `anagram-chrome-${version}.zip`));
rmSync(join(DIST, "stage"), { recursive: true, force: true });
console.log(`release ${version}: dist/anagram.tar.gz (${sha.slice(0, 12)}…), dist/install.sh${existsSync(zip) ? `, dist/anagram-chrome-${version}.zip` : ""}`);
