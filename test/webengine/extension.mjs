// test/webengine/extension.mjs — the oneclick build scoring for real: background, offscreen
// document, worker, model, in a temporary Chromium profile.
//
//   ANAGRAM_MODELKIT=<modelkit dir> ANAGRAM_LID_MODEL=<lid.176.ftz> [ANAGRAM_PARITY_SAMPLE=<sample.json>] \
//     node test/webengine/extension.mjs [--isolate]
//
// test/oneclick.mjs stops where the engine says it has no model files. This goes on: the
// pinned files are put into the extension origin's OPFS from a local server (the same
// bytes the engine would download, verified by the same hashes; the engine's state file
// says so), `models.download` from the setup page finds them and loads the model, and the
// paste page scores an English text through the ordinary pipeline — background, offscreen
// document, worker — under the extension's real manifest and CSP. The engine's runtime
// snapshot says which provider ran and how many threads the WASM one may use, which is
// what `crossOriginIsolated` in the offscreen document comes to; --isolate adds the
// manifest's cross-origin isolation keys to the test build first, to see whether Chrome
// honours them there. The browser's peak memory while the model loads and scores is
// printed; --idle then waits the engine's shortest idle time (a minute) and checks that
// the offscreen document ended the worker and gave its memory back, and that a score
// brings it back. Skips when the paths are missing or CI is set; never part of CI.
import { chromium } from "playwright";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureTestBuild } from "../test-build.mjs";
import { ROOT, serve, watchMemory } from "./harness.mjs";

const argv = process.argv.slice(2);
if (process.env.CI) { console.log("SKIP  extension scoring — never in CI"); process.exit(0); }
const kit = process.env.ANAGRAM_MODELKIT, lid = process.env.ANAGRAM_LID_MODEL;
if (!kit || !lid || !existsSync(join(kit, "onnx", "model.onnx")) || !existsSync(lid)) {
  console.log("SKIP  extension scoring — set ANAGRAM_MODELKIT and ANAGRAM_LID_MODEL to the pinned files");
  process.exit(0);
}
const modelkit = JSON.parse(readFileSync(join(ROOT, "anagramd", "modelkit.json"), "utf8"));
const entry = (path) => modelkit.files.find((f) => f.path === path);
const FILES = [
  { name: "model.onnx", url: "/kit/onnx/model.onnx", sha256: entry("onnx/model.onnx").sha256, size: entry("onnx/model.onnx").size_bytes },
  { name: "tokenizer.json", url: "/kit/tokenizer.json", sha256: entry("tokenizer.json").sha256, size: entry("tokenizer.json").size_bytes },
  { name: "lid.176.ftz", url: `/lid/${lid.split("/").pop()}`, sha256: "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83", size: 938013 },
];
const samplePath = process.env.ANAGRAM_PARITY_SAMPLE;
const sample = samplePath && existsSync(samplePath) ? JSON.parse(readFileSync(samplePath, "utf8")) : null;
// A text the engine scores in one pass, with its official probabilities when the sample is there.
const chosen = sample?.find((t) => t.length <= 400 && t.length >= 120 && t.text.split(/\s+/).length >= 80) ?? null;
const TEXT = chosen?.text ?? ("The committee met on Tuesday to review the proposal, and after a long discussion about the budget, the timeline and the risks that nobody had wanted to name aloud, it agreed to fund the first phase and to revisit the rest in the spring. " +
  "Several members asked for clearer milestones. The chair promised a written plan within two weeks, and the meeting closed a little after six, with the usual reminders about parking and the next date.");

process.env.ANAGRAM_FLAVOR = "oneclick";
const EXT = ensureTestBuild("oneclick-chrome-mv3");
const manifestPath = join(EXT, "manifest.json");
const original = readFileSync(manifestPath, "utf8");
if (argv.includes("--isolate")) {
  const manifest = JSON.parse(original);
  manifest.cross_origin_embedder_policy = { value: "require-corp" };
  manifest.cross_origin_opener_policy = { value: "same-origin" };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}
const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok: !!ok, note: String(note) }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${note}`}`); };

const { base, close: closeServer } = await serve({ "/kit/": kit, "/lid/": join(lid, "..") }, { csp: null, isolate: false });
const profile = mkdtempSync(join(tmpdir(), "anagram-webengine-ext-"));
const context = await chromium.launchPersistentContext(profile, {
  headless: process.env.HEADED !== "1", channel: "chromium",
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--no-default-browser-check"],
  env: { ...process.env, HOME: profile },
});
const problems = [];
try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  sw.on("console", (m) => { if (m.type() === "error") problems.push(`worker: ${m.text()}`); });
  const extId = new URL(sw.url()).host;
  console.log(`Chromium ${context.browser()?.version()}, extension ${extId}`);

  // Seed the engine's store: the same files, verified by the same hashes. From the engine
  // page, the one extension page whose connect-src is the manifest's (every other page
  // tightens it to 'self' with a meta tag); it is closed again before the engine is asked
  // anything, so that only the offscreen document answers the background's port.
  const seed = await context.newPage();
  await seed.goto(`chrome-extension://${extId}/engine.html`);
  const t0 = Date.now();
  const seeded = await seed.evaluate(async ({ base, files }) => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle("anagram-engine", { create: true });
    const sizes = {};
    for (const file of files) {
      const response = await fetch(base + file.url);
      if (!response.ok) throw new Error(`${file.url}: ${response.status}`);
      const handle = await dir.getFileHandle(file.name, { create: true });
      const writable = await handle.createWritable();
      await response.body.pipeTo(writable);
      sizes[file.name] = (await handle.getFile()).size;
    }
    const state = { schema_version: 1, initialized: true, download_pending: false, download_paused: false, download_failed: false,
      engine_stopped: false, models_deleted: false, idle_unload_s: 300, selected_id: null, verified: Object.fromEntries(files.map((f) => [f.name, f.sha256])) };
    const handle = await dir.getFileHandle("state.json", { create: true });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(state));
    await writable.close();
    return sizes;
  }, { base, files: FILES });
  check("the model files are in the extension's OPFS", FILES.every((f) => seeded[f.name] === f.size), `${JSON.stringify(seeded)} in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await seed.close();

  // The setup page asks the engine to take the files and load the model.
  const setup = await context.newPage();
  setup.on("pageerror", (e) => problems.push(`onboarding: ${e.message}`));
  await setup.goto(`chrome-extension://${extId}/onboarding.html`);
  const request = (op, payload = {}) => setup.evaluate(([op, payload]) => chrome.runtime.sendMessage({ action: "anagram.nativeRequest", op, payload }), [op, payload]);
  const memory = watchMemory(profile);
  let reply = await request("status");
  check("the engine answers through the offscreen document", reply?.ok && reply.data?.home === "opfs:anagram-engine", JSON.stringify(reply).slice(0, 200));
  const began = Date.now();
  reply = await request("models.download");
  check("models.download finds the verified files and loads the model", reply?.ok && ["loading", "ready", "downloading"].includes(reply.data?.state), JSON.stringify(reply).slice(0, 300));
  for (let i = 0; i < 600 && reply?.data?.state !== "ready" && reply?.data?.state !== "error"; i++) {
    await new Promise((r) => setTimeout(r, 500));
    reply = await request("status");
  }
  const loadS = ((Date.now() - began) / 1000).toFixed(1);
  check("the engine is ready", reply?.data?.state === "ready", JSON.stringify(reply?.data).slice(0, 600));
  const runtime = reply?.data?.runtime;
  const wasm = runtime?.candidates?.find((c) => c.id === "wasm:fp32");
  const threads = Number(/(\d+) thread/.exec(wasm?.label ?? "")?.[1] ?? 0);
  console.log(`ready in ${loadS} s (download ${reply?.data?.download?.status}); active ${runtime?.active_id}; ${runtime?.candidates?.map((c) => `${c.id}: ${c.label}`).join(" | ")}`);
  console.log(`load: ${JSON.stringify(runtime?.benchmark?.results)}`);
  check(`the offscreen worker ${argv.includes("--isolate") ? "is" : "is not"} cross-origin isolated (${threads} WASM thread${threads === 1 ? "" : "s"})`, argv.includes("--isolate") ? threads > 1 : threads === 1, wasm?.label);
  check("the GPU is the automatic pick", runtime?.active_id === "webgpu:fp32", runtime?.active_id);

  // The paste page scores through the ordinary pipeline.
  const paste = await context.newPage();
  paste.on("pageerror", (e) => problems.push(`paste: ${e.message}`));
  await paste.goto(`chrome-extension://${extId}/paste.html`);
  await paste.fill("#text", TEXT);
  const scoring = Date.now();
  await paste.click("#analyze");
  await paste.waitForFunction(() => !document.getElementById("results").hidden || (document.getElementById("status").textContent && !/Analyzing|分析中/.test(document.getElementById("status").textContent)), undefined, { timeout: 120_000 });
  const seen = await paste.evaluate(() => ({ hidden: document.getElementById("results").hidden, summary: document.getElementById("summary").textContent, status: document.getElementById("status").textContent, items: [...document.querySelectorAll("#windows li p:first-child")].map((p) => p.textContent) }));
  check("the paste page shows a verdict", !seen.hidden && seen.summary.length > 0, JSON.stringify(seen).slice(0, 300));
  console.log(`paste: ${seen.summary} (${((Date.now() - scoring) / 1000).toFixed(1)} s, ${seen.items.length} pass${seen.items.length === 1 ? "" : "es"})`);
  if (chosen) {
    const score = chosen.official.reduce((a, p, i) => a + p * i, 0) / 3;
    const shown = /·\s*(\.\d+|1\.0)/.exec(seen.summary)?.[1];
    const wanted = score.toFixed(2).replace(/^0/, "");
    check("the verdict's score is the official one to two places", shown !== undefined && Math.abs(Number(shown) - Number(wanted)) <= 0.011, `${shown} vs ${wanted} (${chosen.text_id})`);
  }
  const health = await setup.evaluate(() => chrome.runtime.sendMessage({ action: "getBackendStatus", probe: true }));
  check("the background reports the engine up on WebGPU, FP32", health?.active === "server" && health?.server?.device === "webgpu" && health?.server?.dtype === "fp32", JSON.stringify(health).slice(0, 300));
  console.log(`peak memory while loading and scoring (GiB, phys_footprint): ${JSON.stringify(await memory.stop())}`);

  if (argv.includes("--idle")) {
    reply = await request("engine.settings", { idle_unload_s: 60 });
    check("engine.settings takes a minute", reply?.ok && reply.data?.settings?.idle_unload_s === 60, JSON.stringify(reply).slice(0, 200));
    console.log("waiting a minute for the idle unload…");
    for (let i = 0; i < 90 && reply?.data?.state !== "idle"; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      reply = await request("status");
    }
    check("the model is let go after the idle time", reply?.data?.state === "idle", reply?.data?.state);
    await new Promise((r) => setTimeout(r, 3000));
    const watch = watchMemory(profile);
    await new Promise((r) => setTimeout(r, 2000));
    const idle = await watch.stop();
    console.log(`memory once idle (GiB): ${JSON.stringify(idle)}`);
    check("the idle engine's worker is ended and its memory given back", idle.renderer < 0.5 && idle["gpu-process"] < 0.5, JSON.stringify(idle));
    await paste.click("#analyze");
    await paste.waitForFunction(() => !/Analyzing|分析中/.test(document.getElementById("status").textContent ?? ""), undefined, { timeout: 120_000 });
    reply = await request("status");
    check("a score brings the engine back", reply?.data?.state === "ready" && reply.data.runtime?.active_id === "webgpu:fp32", JSON.stringify(reply?.data).slice(0, 300));
    await request("engine.settings", { idle_unload_s: 300 });
  }
  check("no errors in the worker or the pages", problems.length === 0, problems.join(" | "));
} catch (error) {
  check("no exception", false, String(error?.stack ?? error));
} finally {
  await context.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await closeServer();
  writeFileSync(manifestPath, original);
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
