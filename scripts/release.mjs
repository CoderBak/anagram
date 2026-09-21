// scripts/release.mjs — build the release assets the installer consumes:
//   dist/anagram.tar.gz          native app + locked runtime, browser builds and installer
//   dist/anagram.tar.gz.sha256 · dist/anagram.zip + checksum (Windows component bundle)
//   dist/anagram-{chrome,firefox}-<ver>.zip + checksums   browser packages
//   dist/install.sh · dist/install.ps1 + checksums   native component installers
// Usage: node scripts/release.mjs        (builds and packages both browsers)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;

const releaseEnv = { ...process.env, VITE_ANAGRAM_RELEASE_BUILD: "1" };
// WXT's zip command already builds; do not compile each target twice.
for (const command of ["zip", "zip:firefox"]) {
  execFileSync("npm", ["run", command], { cwd: ROOT, stdio: "inherit", env: releaseEnv });
}

rmSync(DIST, { recursive: true, force: true });
const stage = join(DIST, "stage", "anagram");
mkdirSync(join(stage, "bin"), { recursive: true });
mkdirSync(join(stage, "app"), { recursive: true });

// Install runtime files only. The manual research benchmark and its score head
// stay in the repository; dependencies come from pyproject.toml and uv.lock.
for (const f of ["engine.py", "scoring.py", "runtime_controller.py", "runtime_adapters.py", "native_host.py", "native_component.py", "download_modelkit.py", "modelkit.json", "pyproject.toml", "uv.lock", "README.md"]) {
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

// macOS copyfile metadata and xattrs are not part of the installed component.
const tarFlags = process.platform === "darwin" ? ["--no-xattrs"] : [];
execFileSync("tar", [...tarFlags, "-czf", join(DIST, "anagram.tar.gz"), "-C", join(DIST, "stage"), "anagram"], {
  stdio: "inherit", env: { ...process.env, COPYFILE_DISABLE: "1" },
});
execFileSync("python3", ["-c", "import shutil,sys; shutil.make_archive(sys.argv[1], 'zip', sys.argv[2], 'anagram')", join(DIST, "anagram"), join(DIST, "stage")]);
const sha = createHash("sha256").update(readFileSync(join(DIST, "anagram.tar.gz"))).digest("hex");
writeFileSync(join(DIST, "anagram.tar.gz.sha256"), `${sha}  anagram.tar.gz\n`);
for (const browser of ["chrome", "firefox"]) {
  cpSync(join(ROOT, "output", `anagram-extension-${version}-${browser}.zip`),
    join(DIST, `anagram-${browser}-${version}.zip`));
}
for (const name of ["anagram.zip", "install.sh", "install.ps1", `anagram-chrome-${version}.zip`, `anagram-firefox-${version}.zip`]) {
  const digest = createHash("sha256").update(readFileSync(join(DIST, name))).digest("hex");
  writeFileSync(join(DIST, name + ".sha256"), `${digest}  ${name}\n`);
}
rmSync(join(DIST, "stage"), { recursive: true, force: true });
console.log(`release ${version}: native component archives, installers and Chrome/Firefox ZIPs with checksums in dist/ (${sha.slice(0, 12)}…)`);
