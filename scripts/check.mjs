// scripts/check.mjs — every check CI runs, on this machine, in one command: `npm run check`.
//
// The suites live in several runners (tsc, vitest, Playwright, plain node and sh scripts,
// Python's unittest), and running some of them by hand let one go stale unnoticed for days
// (test/native-browser.mjs). This runs them all in CI's order and ends with one line per
// suite. A suite this machine cannot run — no POSIX shell, no Python with the engine's
// packages — is named and said why, never left out in silence.
//
//   npm run check                     # everything
//   npm run check -- --from pw        # start at the browser suites
//   PW_WORKERS=2 npm run check        # fewer browsers at once (a full disk, a small machine)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const posix = process.platform !== "win32";
const python = process.env.ANAGRAMD_PYTHON ?? (existsSync(join(ROOT, "anagramd/.venv/bin/python")) ? join(ROOT, "anagramd/.venv/bin/python") : null);
const workers = process.env.PW_WORKERS ?? "4";

/** name, command, and why it cannot run here (null: it can). */
const SUITES = [
  ["typecheck", "npm run typecheck", null],
  ["build", "npm run build", null],
  ["unit (vitest)", "npx vitest run", null],
  ["walker (test/unit.mjs)", "node test/unit.mjs", null],
  ["installer", "sh test/installer.sh", posix ? null : "needs a POSIX shell"],
  // Needs the network (PyPI and uv's Python builds), and says SKIP without it.
  ["release signature", "sh test/release-signature.sh", posix ? null : "needs a POSIX shell"],
  ["native setup in the browser", "node test/native-browser.mjs", posix ? null : "its stdio launcher fixture is POSIX"],
  ["pw", `npx playwright test --project chromium --workers=${workers}`, null],
  ["pseudo-locale", "node test/pseudo-locale.mjs", null],
  ["backend (Python)", "sh test/backend.sh", !posix ? "needs a POSIX shell" : python ? null : "set ANAGRAMD_PYTHON to a Python with the engine's locked packages (anagramd/uv.lock)"],
];

const from = process.argv.includes("--from") ? process.argv[process.argv.indexOf("--from") + 1] : null;
let started = from === null;
const results = [];
for (const [name, command, cannot] of SUITES) {
  if (!started && name.startsWith(from)) started = true;
  if (!started) continue;
  if (cannot) { results.push([name, `skipped: ${cannot}`]); continue; }
  console.log(`\n=== ${name}: ${command}`);
  const began = Date.now();
  const run = spawnSync(command, { cwd: ROOT, stdio: "inherit", shell: true, env: { ...process.env, ...(python ? { ANAGRAMD_PYTHON: python } : {}) } });
  results.push([name, run.status === 0 ? `passed in ${Math.round((Date.now() - began) / 1000)} s` : `FAILED (exit ${run.status ?? run.signal})`]);
}
console.log("\n=== summary");
for (const [name, outcome] of results) console.log(`${outcome.startsWith("FAILED") ? "✗" : outcome.startsWith("skipped") ? "–" : "✓"} ${name}: ${outcome}`);
process.exit(results.some(([, outcome]) => outcome.startsWith("FAILED")) ? 1 : 0);
