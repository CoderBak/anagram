// The configuration list (Advanced) in the SHIPPING browser build, with no host grants.
// Deterministic measurements: real model timing is a separate native-real smoke check.
import assert from "node:assert/strict";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchExtension } from "./harness.mjs";
import { createNativeFixture } from "./fake-native.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "output/chrome-mv3");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
assert.equal(manifest.host_permissions, undefined, "Use a shipping build with no host permissions");
const candidates = [
  { id: "torch-cpu-fp32", label: "CPU · FP32", device: "cpu", runtime: "torch", precision: "fp32", experimental: false, available: true },
  { id: "torch-mps-fp16", label: "Apple GPU · FP16", device: "mps", runtime: "torch", precision: "fp16", experimental: false, available: true },
  { id: "onnx-cpu-int8", label: "CPU · INT8", device: "cpu", runtime: "onnx", precision: "int8", experimental: true, available: false, reason: "onnxruntime is not installed" },
];
const results = candidates.slice(0, 2).flatMap((candidate, index) => [1, 8].map((batch_size) => ({
  candidate_id: candidate.id, status: "ok", load_ms: 2400, initialization_ms: 85, hash_ms: 17, warmup_ms: 120,
  latency_ms: batch_size === 1 ? 42.5 - index * 10 : 160 - index * 30,
  throughput_per_s: batch_size === 1 ? 23.5 + index * 10 : 50 + index * 25,
  baseline_rss_bytes: 120_000_000, loaded_rss_bytes: 1_700_000_000, rss_scope: "isolated_process", rss_sample_interval_ms: 50,
  measurement_quality: "sufficient", accelerator_kind: candidate.device === "mps" ? "mps_driver_including_cache" : null,
  peak_rss_bytes: 2_000_000_000, accelerator_bytes: candidate.device === "mps" ? 800_000_000 : null,
  samples: 20, batch_size, tokens_per_text: 128, duration_s: 1.5,
})));
// The engine picked FP32 itself; a benchmark the user started is running.
let state = {
  schema_version: 1, state: "benchmarking", active_id: null, selected_id: candidates[0].id,
  recommended_id: candidates[0].id, fastest_id: null, candidates, error: null,
  benchmark: { report_version: 2, environment: {platform:"deterministic Mac fixture"}, status: "running", budget_s: 30, elapsed_s: 3, measurement_s: 1,
    phase: "measuring", current_id: candidates[0].id, completed: 1, total: 4, results: [] },
};
const fixture = await createNativeFixture();
const setRuntime = (runtime) => fixture.setState({ component: { ...fixture.state().component, state: runtime.state, runtime } });
setRuntime(state);
const mutations = () => fixture.requests().filter((r) => r.op.startsWith("runtime."));
let context;
try {
  const launched = await launchExtension({ nativeFixture: fixture, extDir: EXT, viewport: { width: 1200, height: 900 } });
  context = launched.context;
  const worker = launched.sw, id = launched.extId;
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const openAdvanced = async () => { await page.locator("#advanced > summary").waitFor(); await page.locator("#advanced > summary").click(); };
  await page.goto(`chrome-extension://${id}/onboarding.html`);
  await openAdvanced();
  const panel = page.locator("#runtimeSettings");
  await panel.getByRole("button", { name: "Cancel", exact: true }).waitFor();
  assert.ok((await panel.innerText()).includes("Benchmarking · 1 of 4 done · CPU · FP32"));
  assert.equal(mutations().length, 0, "Opening setup must not launch another benchmark");
  assert.equal(await page.locator("#install").isHidden(), true, "A running local engine is already installed");
  assert.equal(await page.locator("#ready").isHidden(), true, "Not ready while a benchmark runs");
  console.log("PASS a running benchmark is visible over native messaging without starting a duplicate");

  state = { ...state, state: "ready", active_id: candidates[0].id, fastest_id: candidates[1].id,
    benchmark: { ...state.benchmark, status: "completed", phase: "ready", current_id: null, completed: 4, results } };
  setRuntime(state);
  await panel.getByRole("radio", { name: /Apple GPU/ }).waitFor();
  await page.locator("#ready:not([hidden])").waitFor();
  assert.equal(await panel.getByRole("radio", { name: /CPU · FP32/ }).isChecked(), true, "The engine's own choice is the selected row");
  assert.equal(await panel.getByRole("button", { name: "Use selected", exact: true }).isDisabled(), true, "Nothing to apply while the radio matches the selection");
  assert.equal(await panel.getByRole("radio", { name: /CPU · INT8/ }).isDisabled(), true);
  assert.equal(mutations().length, 0, "Benchmark completion never changes the selection");
  const cpuRow = panel.locator(".runtime-row").filter({ hasText: "CPU · FP32" });
  const gpuRow = panel.locator(".runtime-row").filter({ hasText: "Apple GPU" });
  const int8Row = panel.locator(".runtime-row").filter({ hasText: "INT8" });
  assert.ok((await cpuRow.innerText()).includes("42.5 ms · 50 texts/s · 2 GB"), "One line: latency from batch 1, throughput from batch 8, peak memory");
  assert.ok((await cpuRow.innerText()).includes("Active") && (await cpuRow.innerText()).includes("Recommended"));
  assert.ok((await gpuRow.innerText()).includes("Fastest"));
  assert.ok((await int8Row.innerText()).includes("Experimental") && (await int8Row.innerText()).includes("onnxruntime is not installed"));
  assert.equal(await int8Row.locator(".runtime-measured").count(), 0, "No measurement line without a result");
  for (const word of ["samples", "Before libraries", "warmup", "own process"]) assert.ok(!(await panel.innerText()).includes(word), `No ${word} detail`);
  await panel.getByRole("radio", { name: /Apple GPU/ }).check();
  await panel.getByRole("button", { name: "Use selected", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#runtimeSettings .runtime-row[data-active=true]")?.textContent?.includes("Apple GPU"));
  state = fixture.state().component.runtime;
  assert.equal(state.selected_id, candidates[1].id);
  assert.equal(mutations().filter((m) => m.op === "runtime.config").length, 1);
  console.log("PASS the user switches to FP16 explicitly and the applied configuration becomes active");

  await page.goto(`chrome-extension://${id}/options.html`);
  await openAdvanced();
  await panel.getByRole("button", { name: "Run benchmark", exact: true }).waitFor();
  assert.equal(await panel.getByRole("radio", { name: /Apple GPU/ }).isChecked(), true);
  await panel.getByRole("button", { name: "Run benchmark", exact: true }).click();
  await panel.getByRole("button", { name: "Cancel", exact: true }).click();
  await panel.getByRole("button", { name: "Cancel", exact: true }).waitFor({ state: "hidden" });
  await panel.getByRole("button", { name: "Run benchmark", exact: true }).waitFor();
  state = fixture.state().component.runtime;
  assert.equal(state.active_id, candidates[1].id);
  assert.equal(mutations().filter((m) => m.op === "runtime.config").length, 1);
  assert.equal(mutations().filter((m) => m.op === "runtime.benchmark").length, 1);
  assert.equal(mutations().filter((m) => m.op === "runtime.cancel").length, 1);
  console.log("PASS Settings restores the selection, and a cancelled benchmark keeps it");

  assert.equal(await worker.evaluate(async () => (await chrome.permissions.getAll()).origins?.length ?? 0), 0);
  assert.deepEqual(errors, []);
  await page.evaluate(readFileSync(join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8"));
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction((scheme) => document.documentElement.classList.contains("dark") === (scheme === "dark"), colorScheme);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    const accessibility = await page.evaluate(async () => {
      const result = await window.axe.run("#componentSettings", {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      });
      return result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => ({target:n.target,summary:n.failureSummary})) }));
    });
    assert.deepEqual(accessibility, [], `Engine controls must pass WCAG 2.1 A/AA checks in ${colorScheme} mode`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  const artifacts = process.env.ANAGRAM_ARTIFACTS ?? join(ROOT, "test-results/runtime");
  mkdirSync(artifacts, { recursive: true });
  await page.locator("#componentSettings").screenshot({ path: join(artifacts, "runtime-settings.png") });
  await page.setViewportSize({ width: 400, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, "The list must not force the page wider");
  console.log("PASS accessible configuration list renders without page errors or extra browser permissions");
} finally {
  await context?.close();
  fixture.dispose();
}
