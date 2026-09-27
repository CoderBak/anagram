// scripts/oneclick.mjs — run a command as the oneclick flavor (scripts/flavor.mjs).
//
//   node scripts/oneclick.mjs npm run build      → output/oneclick-chrome-mv3
//
// A node script rather than `ANAGRAM_FLAVOR=oneclick …` in package.json because that is
// not a command on Windows (see scripts/buildTest.mjs).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const [command, ...args] = process.argv.slice(2);
if (!command) {
  console.error("usage: node scripts/oneclick.mjs <command> [args…]");
  process.exit(2);
}
const run = spawnSync(command, args, {
  cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
  stdio: "inherit",
  env: { ...process.env, ANAGRAM_FLAVOR: "oneclick" },
  shell: process.platform === "win32",
});
process.exit(run.status ?? 1);
