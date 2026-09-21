// First-run/runtime settings in the SHIPPING browser build, with no host grants.
// Uses deterministic measurements: real model timing is a separate daemon smoke check.
import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXT = join(ROOT, "output/chrome-mv3");
const manifest = JSON.parse(readFileSync(join(EXT, "manifest.json"), "utf8"));
assert.equal(manifest.host_permissions, undefined, "Use a shipping build with no host permissions");
const candidates = [
  { id: "torch-cpu-fp32", label: "CPU · FP32", device: "cpu", runtime: "torch", precision: "fp32", experimental: false, available: true },
  { id: "torch-mps-fp16", label: "Apple GPU · FP16", device: "mps", runtime: "torch", precision: "fp16", experimental: false, available: true },
  { id: "onnx-cpu-int8", label: "CPU · INT8", device: "cpu", runtime: "onnx", precision: "int8", experimental: true, available: true },
];
const results = candidates.flatMap((candidate, index) => [1, 8].map((batch_size) => ({
  candidate_id: candidate.id, status: "ok", load_ms: 2400, warmup_ms: 120,
  latency_ms: batch_size === 1 ? 42.5 - index * 10 : 160 - index * 30,
  throughput_per_s: batch_size === 1 ? 23.5 + index * 10 : 50 + index * 25,
  peak_rss_bytes: 2_000_000_000, accelerator_bytes: candidate.device === "mps" ? 800_000_000 : null,
  samples: 20, batch_size, tokens_per_text: 128, duration_s: 1.5,
})));
let state = {
  schema_version: 1, state: "benchmarking", active_id: null, selected_id: null,
  recommended_id: null, needs_selection: true, candidates, error: null,
  benchmark: { status: "running", budget_s: 30, elapsed_s: 3, measurement_s: 1,
    phase: "measuring", current_id: candidates[0].id, completed: 0, total: 6, results: [] },
};
const mutations = [];
const model = { id: "editlens_roberta-large", ver: "test-fp32", calibration: "editlens" };
const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !origin.startsWith("chrome-extension://")) {
    res.writeHead(403); res.end(); return;
  }
  const headers = { "content-type": "application/json", ...(origin ? { "access-control-allow-origin": origin, vary: "Origin" } : {}) };
  if (req.method === "OPTIONS") {
    res.writeHead(204, { ...headers, "access-control-allow-methods": "GET, POST", "access-control-allow-headers": "content-type", "access-control-allow-private-network": "true" });
    res.end(); return;
  }
  if (req.url === "/health") {
    const ready = state.state === "ready";
    const candidate = candidates.find((c) => c.id === state.active_id);
    res.writeHead(ready ? 200 : 503, headers);
    res.end(JSON.stringify(ready ? { ok: true, contract: "2.1", model,
      n_buckets: 4, buckets: ["human", "light", "heavy", "ai"], max_tokens: 512,
      device: candidate.device, dtype: candidate.precision, app_version: manifest.version } : { detail: "Choose a configuration" }));
    return;
  }
  if (req.method === "POST" && req.url.startsWith("/runtime/")) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = JSON.parse(body);
    mutations.push({ path: req.url, data });
    if (req.url === "/runtime/config") {
      assert.ok(candidates.some((c) => c.id === data.id));
      state = { ...state, state: "ready", active_id: data.id, selected_id: data.id, needs_selection: false };
    } else if (req.url === "/runtime/benchmark") {
      assert.equal(data.budget_s, 30);
      state = { ...state, state: "benchmarking", active_id: null,
        benchmark: { ...state.benchmark, status: "running", phase: "measuring", results: [], completed: 0 } };
    } else if (req.url === "/runtime/cancel") {
      state = { ...state, state: state.selected_id ? "ready" : "awaiting_selection", active_id: state.selected_id,
        benchmark: { ...state.benchmark, status: "cancelled", current_id: null, phase: "idle" } };
    } else {
      res.writeHead(404, headers); res.end("{}"); return;
    }
    res.writeHead(202, headers); res.end(JSON.stringify(state)); return;
  }
  res.writeHead(req.url === "/runtime" ? 200 : 404, headers);
  res.end(JSON.stringify(req.url === "/runtime" ? state : {}));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext("", {
    headless: true, channel: "chromium", viewport: { width: 1200, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--no-default-browser-check"],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker");
  const id = new URL(worker.url()).host;
  await worker.evaluate((serverUrl) => chrome.storage.local.set({ serverUrl, backendTransport: "http" }), base);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/onboarding.html`);
  const panel = page.locator("#runtimeSettings");
  await panel.getByRole("button", { name: "Cancel benchmark", exact: true }).waitFor();
  assert.equal(mutations.length, 0, "Opening onboarding must not launch another benchmark");
  assert.equal(await page.locator("#install").isHidden(), true, "A running setup daemon is already installed");
  assert.notEqual(await page.locator("#row-ready").getAttribute("data-state"), "ok");
  console.log("PASS first-run setup is visible over CORS, without auto-applying or starting a duplicate benchmark");

  state = { ...state, state: "awaiting_selection", recommended_id: candidates[0].id,
    benchmark: { ...state.benchmark, status: "completed", phase: "awaiting_selection", current_id: null, completed: 6, results } };
  await panel.getByRole("radio", { name: /Apple GPU/ }).waitFor();
  await panel.getByRole("button", { name: "Use selected configuration", exact: true }).waitFor({ state: "visible" });
  assert.equal(mutations.length, 0, "Benchmark completion must wait for the user's choice");
  await panel.getByRole("radio", { name: /Apple GPU/ }).check();
  await panel.getByRole("button", { name: "Use selected configuration", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#row-daemon")?.getAttribute("data-state") === "ok");
  assert.equal(state.selected_id, candidates[1].id);
  assert.equal(mutations.filter((m) => m.path === "/runtime/config").length, 1);
  console.log("PASS user selects FP16 explicitly and the applied configuration becomes active");

  await page.goto(`chrome-extension://${id}/options.html`);
  await panel.getByRole("button", { name: "Run benchmark again", exact: true }).waitFor();
  assert.equal(await panel.getByRole("radio", { name: /Apple GPU/ }).isChecked(), true);
  await panel.getByRole("button", { name: "Run benchmark again", exact: true }).click();
  await panel.getByRole("button", { name: "Cancel benchmark", exact: true }).click();
  await panel.getByRole("button", { name: "Run benchmark again", exact: true }).waitFor();
  assert.equal(state.active_id, candidates[1].id);
  assert.equal(mutations.filter((m) => m.path === "/runtime/config").length, 1);
  console.log("PASS settings restores the selection, and a cancelled rerun keeps it");

  state = { ...state, benchmark: { ...state.benchmark, status: "completed", phase: "ready", completed: 6,
    measurement_s: 29.8, elapsed_s: 51.2, results } };
  await panel.getByRole("button", { name: "Refresh status", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("#runtimeSettings table")?.textContent?.includes("42.5 ms"));
  const ramRow = panel.getByRole("row").filter({ hasText: "CPU · FP32" });
  assert.ok((await ramRow.getByRole("cell").nth(1).innerText()).includes("42.5 ms"), "Interactive latency must come from batch 1");
  assert.ok((await ramRow.getByRole("cell").nth(2).innerText()).startsWith("50 texts/s"), "Throughput must come from batch 8");
  assert.ok((await ramRow.getByRole("cell").nth(3).innerText()).includes("Not available"), "Unavailable GPU memory must not appear as zero");
  assert.equal(await worker.evaluate(async () => (await chrome.permissions.getAll()).origins?.length ?? 0), 0);
  assert.deepEqual(errors, []);
  await page.evaluate(readFileSync(join(ROOT, "node_modules/axe-core/axe.min.js"), "utf8"));
  for (const colorScheme of ["light", "dark"]) {
    await page.emulateMedia({ colorScheme });
    await page.waitForFunction((scheme) => document.documentElement.classList.contains("dark") === (scheme === "dark"), colorScheme);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"));
    const accessibility = await page.evaluate(async () => {
      const result = await window.axe.run("#runtimeSettings", {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      });
      return result.violations.map((v) => ({ id: v.id, targets: v.nodes.map((n) => ({target:n.target,summary:n.failureSummary})) }));
    });
    assert.deepEqual(accessibility, [], `Runtime controls must pass WCAG 2.1 A/AA checks in ${colorScheme} mode`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  const artifacts = process.env.ANAGRAM_ARTIFACTS ?? join(ROOT, "test-results/runtime");
  mkdirSync(artifacts, { recursive: true });
  await panel.screenshot({ path: join(artifacts, "runtime-settings.png") });
  await page.setViewportSize({ width: 400, height: 900 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false,
    "The table may scroll inside its region, but must not force the whole page wider");
  console.log("PASS accessible workload metrics render without page errors or extra browser permissions");
} finally {
  await context?.close();
  await new Promise((resolve) => server.close(resolve));
}
