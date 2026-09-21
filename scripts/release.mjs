// scripts/release.mjs — build the release assets the installer consumes:
//   dist/anagram.tar.gz          app/ (daemon + uv.lock) · extension/ (chrome-mv3) · bin/anagram · install.sh · VERSION
//   dist/anagram.tar.gz.sha256 · dist/anagram.zip + checksum (Windows component bundle)
//   dist/anagram-{chrome,firefox}-<ver>.zip + checksums   browser packages
//   dist/install.sh · dist/install.ps1 + checksums   native component installers
// Usage: node scripts/release.mjs        (runs the extension build first)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const releaseEnv = { ...process.env, VITE_ANAGRAM_RELEASE_BUILD: "1" };
for (const command of ["build", "zip", "build:firefox", "zip:firefox"]) {
  execFileSync("npm", ["run", command], { cwd: ROOT, stdio: "inherit", env: releaseEnv });
}

rmSync(DIST, { recursive: true, force: true });
const stage = join(DIST, "stage", "anagram");
mkdirSync(join(stage, "bin"), { recursive: true });
mkdirSync(join(stage, "app"), { recursive: true });

// bench.py is NOT in this list. It needs packages from the `bench` extra, which
// `uv sync --no-dev` never installs, and it looks for its checkpoints beside the
// REPOSITORY rather than inside the installation — so in a tarball it is a file that
// cannot be run, whose only other effect was that a developer tool shipped to users.
// (train_head.py is in the same position today: nothing in serve.py imports it. It is
// left here for now — that is a separate decision from this one.)
for (const f of ["serve.py", "scoring.py", "runtime_controller.py", "runtime_adapters.py", "native_host.py", "native_component.py", "download_modelkit.py", "modelkit.json", "train_head.py", "pyproject.toml", "uv.lock", "requirements.txt", "run.sh", "README.md"]) {
  cpSync(join(ROOT, "anagramd", f), join(stage, "app", f));
}
cpSync(join(ROOT, "output", "chrome-mv3"), join(stage, "extension"), { recursive: true });
cpSync(join(ROOT, "output", "firefox-mv2"), join(stage, "extension-firefox"), { recursive: true });
cpSync(join(ROOT, "installer", "anagram"), join(stage, "bin", "anagram"));
for (const f of ["native_registration.py", "NativeLauncher.cs", "maintenance.ps1"]) {
  cpSync(join(ROOT, "installer", f), join(stage, "app", f));
}
const installer = readFileSync(join(ROOT, "install.sh"), "utf8");
writeFileSync(join(stage, "install.sh"), installer);
writeFileSync(join(DIST, "install.sh"), installer);
for (const target of [stage, DIST]) cpSync(join(ROOT, "install.ps1"), join(target, "install.ps1"));
writeFileSync(join(stage, "VERSION"), version + "\n");

execFileSync("tar", ["-czf", join(DIST, "anagram.tar.gz"), "-C", join(DIST, "stage"), "anagram"], { stdio: "inherit" });
execFileSync("python3", ["-c", "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2], 'anagram')", join(DIST, "anagram"), join(DIST, "stage")]);
const sha = createHash("sha256").update(readFileSync(join(DIST, "anagram.tar.gz"))).digest("hex");
writeFileSync(join(DIST, "anagram.tar.gz.sha256"), `${sha}  anagram.tar.gz\n`);
const zip = join(ROOT, "output", `anagram-extension-${version}-chrome.zip`);
if (existsSync(zip)) cpSync(zip, join(DIST, `anagram-chrome-${version}.zip`));
const firefoxZip = join(ROOT, "output", `anagram-extension-${version}-firefox.zip`);
if (!existsSync(firefoxZip)) throw new Error("Firefox release ZIP is missing");
cpSync(firefoxZip, join(DIST, `anagram-firefox-${version}.zip`));
for (const name of ["anagram.zip", "install.sh", "install.ps1", `anagram-chrome-${version}.zip`, `anagram-firefox-${version}.zip`]) {
  const digest = createHash("sha256").update(readFileSync(join(DIST, name))).digest("hex");
  writeFileSync(join(DIST, name + ".sha256"), `${digest}  ${name}\n`);
}
rmSync(join(DIST, "stage"), { recursive: true, force: true });
console.log(`release ${version}: dist/anagram.tar.gz (${sha.slice(0, 12)}…), dist/install.sh${existsSync(zip) ? `, dist/anagram-chrome-${version}.zip` : ""}`);
