// scripts/buildTest.mjs — build the TEST variant of the extension into output-test/.
//
// The shipping build installs with access to no site, and a permission prompt is native
// browser UI that no automation can click. The variant differs in exactly one way: the two
// optional site patterns are REQUIRED host permissions instead (see ANAGRAM_TEST_GRANT_ALL
// in wxt.config.ts), so the very same runtime registration runs and finds everything
// granted. Everything else — the code, the pages, the messages — is identical.
//
//   node scripts/buildTest.mjs             # Chrome MV3  → output-test/chrome-mv3
//   node scripts/buildTest.mjs --firefox   # Firefox MV2 → output-test/firefox-mv2
//   node scripts/buildTest.mjs --all
//
// It is a node script rather than an env var in package.json because `VAR=1 cmd` is not a
// command on Windows, and the suites run there too.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const targets = args.includes("--all")
  ? [[], ["-b", "firefox"]]
  : args.includes("--firefox")
    ? [["-b", "firefox"]]
    : [[]];

// The on-demand chunks first, exactly as `npm run build` does: public/vendor/*.mjs is
// generated, not tracked, so in a fresh checkout it is not there — and a variant built
// without it has no Readability, no DOMPurify and no diagnostics chunk, which shows up as
// twenty-odd checks failing for no visible reason.
const vendor = spawnSync(process.execPath, [join(ROOT, "scripts", "vendor.mjs")], { cwd: ROOT, stdio: "inherit" });
if (vendor.status !== 0) process.exit(vendor.status ?? 1);

for (const target of targets) {
  const run = spawnSync("npx", ["wxt", "build", ...target], {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ANAGRAM_TEST_GRANT_ALL: "1" },
    shell: process.platform === "win32",
  });
  if (run.status !== 0) process.exit(run.status ?? 1);
}
