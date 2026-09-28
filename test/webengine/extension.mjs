// test/webengine/extension.mjs — the in-browser engine scoring for real: background, offscreen
// document, worker, model, in a temporary Chromium profile.
//
//   ANAGRAM_MODELKIT=<modelkit dir> [ANAGRAM_PARITY_SAMPLE=<sample.json>] \
//     node test/webengine/extension.mjs [--idle] [--warm]
//
// test/inbrowser.mjs stops where the engine says it has no model files. This goes on, on a
// copy of the test build that stands in for a device with no choice (test/test-build.mjs
// deviceBuild), where the in-browser engine is the one in use from install: the
// pinned files are put into the extension origin's OPFS from a local server (the same
// bytes the engine would download, verified by the same hashes; the engine's state file
// says so), `models.download` from the setup page finds them and loads the model, and the
// paste page scores an English text through the ordinary pipeline — background, offscreen
// document, worker — under the extension's real manifest and CSP. The engine's runtime
// snapshot says which provider ran and how many threads the WASM one may use, which is
// what `crossOriginIsolated` in the offscreen document comes to (the manifest's isolation
// keys, wxt.config.ts). The browser's peak memory while the model loads and scores is
// printed; --idle then waits the engine's shortest idle time (a minute) and checks that
// the offscreen document ended the worker and gave its memory back, and that a score
// brings it back. --warm times the first verdict on a page after the idle unload, opened in a
// tab behind (not warmed) and in the tab in front (warmed as it starts to load), and checks
// that a tab switch warms nothing and that a model warmed for nothing is let go again. Skips
// when the paths are missing or CI is set; never part of CI.
import { chromium } from "playwright";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deviceBuild } from "../test-build.mjs";
import { DEVICES } from "../pw/devices.mjs";
import { ROOT, serve, watchMemory } from "./harness.mjs";
import { serveHtml } from "../harness.mjs";
import { NO_MODEL_HOSTS, cancelAutoSetup } from "./model-server.mjs";

const argv = process.argv.slice(2);
if (process.env.CI) { console.log("SKIP  extension scoring — never in CI"); process.exit(0); }
const kit = process.env.ANAGRAM_MODELKIT;
if (!kit || !existsSync(join(kit, "onnx", "model.onnx"))) {
  console.log("SKIP  extension scoring — set ANAGRAM_MODELKIT to the pinned modelkit");
  process.exit(0);
}
const modelkit = JSON.parse(readFileSync(join(ROOT, "anagramd", "modelkit.json"), "utf8"));
const entry = (path) => modelkit.files.find((f) => f.path === path);
const FILES = [
  { name: "model.onnx", url: "/kit/onnx/model.onnx", sha256: entry("onnx/model.onnx").sha256, size: entry("onnx/model.onnx").size_bytes },
  { name: "tokenizer.json", url: "/kit/tokenizer.json", sha256: entry("tokenizer.json").sha256, size: entry("tokenizer.json").size_bytes },
];
const samplePath = process.env.ANAGRAM_PARITY_SAMPLE;
const sample = samplePath && existsSync(samplePath) ? JSON.parse(readFileSync(samplePath, "utf8")) : null;
// A text the engine scores in one pass, with its official probabilities when the sample is there.
const chosen = sample?.find((t) => t.length <= 400 && t.length >= 120 && t.text.split(/\s+/).length >= 80) ?? null;
const TEXT = chosen?.text ?? ("The committee met on Tuesday to review the proposal, and after a long discussion about the budget, the timeline and the risks that nobody had wanted to name aloud, it agreed to fund the first phase and to revisit the rest in the spring. " +
  "Several members asked for clearer milestones. The chair promised a written plan within two weeks, and the meeting closed a little after six, with the usual reminders about parking and the next date.");

const EXT = deviceBuild("linux-cpu", DEVICES["linux-cpu"]);
const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok: !!ok, note: String(note) }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : ` — ${note}`}`); };

const { base, close: closeServer } = await serve({ "/kit/": kit }, { csp: null, isolate: false });
const profile = mkdtempSync(join(tmpdir(), "anagram-webengine-ext-"));
const context = await chromium.launchPersistentContext(profile, {
  headless: process.env.HEADED !== "1", channel: "chromium",
  // Installing starts the model's download on this device (lib/webengine/autoSetup.ts): Hugging Face resolves to nothing here.
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run", "--no-default-browser-check", NO_MODEL_HOSTS],
  env: { ...process.env, HOME: profile },
});
const problems = [];
try {
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
  sw.on("console", (m) => { if (m.type() === "error") problems.push(`worker: ${m.text()}`); });
  const extId = new URL(sw.url()).host;
  console.log(`Chromium ${context.browser()?.version()}, extension ${extId}`);
  // What installing started is cancelled before the files are put in its place.
  await cancelAutoSetup(context, extId);

  // Seed the engine's store: the same files, verified by the same hashes. From the engine
  // page, the one extension page whose connect-src is the manifest's (every other page
  // tightens it to 'self' with a meta tag); it is closed again before the engine is asked
  // for the model, so that only the offscreen document answers the background's port. The
  // engine, started at install, verifies the files it finds when asked for them.
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
  check(`the offscreen worker is cross-origin isolated (${threads} WASM thread${threads === 1 ? "" : "s"})`, threads > 1, wasm?.label);
  check("the GPU is the automatic pick", runtime?.active_id === "webgpu:fp32", runtime?.active_id);

  // The background reads the engine's health afresh (a health read while the model loaded
  // says "not ready" for a second and a half), as the setup page does once it shows ready.
  const health = await setup.evaluate(() => chrome.runtime.sendMessage({ action: "getBackendStatus", probe: true }));
  check("the background reports the engine up on WebGPU, FP32", health?.active === "server" && health?.server?.device === "webgpu" && health?.server?.dtype === "fp32", JSON.stringify(health).slice(0, 300));

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
    // A text not scored yet: the first one's verdict is answered from the cache.
    await paste.fill("#text", `${TEXT} The minutes were approved without changes.`);
    await paste.click("#analyze");
    for (let i = 0; i < 120 && reply?.data?.state !== "ready"; i++) {
      await new Promise((r) => setTimeout(r, 500));
      reply = await request("status");
    }
    check("a score brings the engine back", reply?.data?.state === "ready" && reply.data.runtime?.active_id === "webgpu:fp32", JSON.stringify(reply?.data).slice(0, 300));
    await request("engine.settings", { idle_unload_s: 300 });
  }

  if (argv.includes("--warm")) {
    // The first verdict on a page Anagram reads, the engine let go while idle: opened in a tab
    // behind (not warmed, as every page was before lib/backend/warmup.ts), then in the tab in
    // front (warmed as it starts loading). Headless Chromium never hides a tab, so both read.
    reply = await request("engine.settings", { idle_unload_s: 60 });
    const state = async () => (await request("status"))?.data?.state;
    /** Waits for the engine to say `want`, asking afresh each time; its last word. */
    const until = async (want, seconds) => {
      let now;
      for (let i = 0; i < seconds * 4; i++) { now = await state(); if (now === want) break; await new Promise((r) => setTimeout(r, 250)); }
      return now;
    };
    const paragraphs = (tag) => [1, 2, 3].map((n) => `<p>${tag} ${n}. ${TEXT}</p>`).join("");
    const site = await serveHtml({
      "/cold.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>cold</title></head><body>${paragraphs("Behind")}</body></html>`,
      "/warm.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>warm</title></head><body>${paragraphs("In front")}</body></html>`,
      "/short.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>short</title></head><body><p>Nothing here to read.</p></body></html>`,
    });
    // The first settled chip, in milliseconds from the navigation's start.
    const clock = () => {
      const started = setInterval(() => {
        const pill = [...document.querySelectorAll('[data-anagram="host"]:not(#anagram-fab)')].map((h) => h.shadowRoot?.querySelector(".pill")).find((p) => p && !p.classList.contains("pending"));
        if (pill) { window.__firstVerdict = performance.now(); clearInterval(started); }
      }, 5);
    };
    const firstVerdict = async (page) => {
      await page.waitForFunction(() => window.__firstVerdict !== undefined, undefined, { timeout: 60_000, polling: 50 });
      return Math.round(await page.evaluate(() => window.__firstVerdict));
    };
    try {
      const behind = await context.newPage();
      await behind.addInitScript(clock);
      const front = await context.newPage();
      await front.addInitScript(clock);
      await front.bringToFront();
      check("the model is let go after the idle time", (await until("idle", 120)) === "idle");
      await behind.goto(site.url("/short.html"));
      await new Promise((r) => setTimeout(r, 3000));
      const afterBehind = await state();
      check("a page opening in a tab behind does not warm the engine", afterBehind === "idle", afterBehind);
      await behind.goto(site.url("/cold.html"));
      const cold = await firstVerdict(behind);
      console.log(`first verdict after an idle unload, not warmed (a tab behind): ${cold} ms`);
      check("the model is let go after the idle time (before the switches)", (await until("idle", 120)) === "idle");
      await behind.bringToFront();
      await new Promise((r) => setTimeout(r, 3000));
      await front.bringToFront();
      await new Promise((r) => setTimeout(r, 3000));
      const afterSwitch = await state();
      check("switching tabs does not warm it", afterSwitch === "idle", afterSwitch);
      await front.goto(site.url("/warm.html"));
      const warm = await firstVerdict(front);
      console.log(`first verdict after an idle unload, warmed (the tab in front): ${warm} ms (${cold - warm} ms sooner)`);
      check("the first verdict after an idle unload comes sooner when the page's opening warms the engine", warm < cold, `${warm} vs ${cold} ms`);
      // Warmed, and nothing to read there: the model loads, and is let go after the idle time.
      check("the model is let go after the idle time (before a page with nothing to read)", (await until("idle", 120)) === "idle");
      const warmedAt = Date.now();
      await front.goto(site.url("/short.html"));
      const warmed = await until("ready", 15);
      check("a page with nothing to read, opening in front, warms the engine all the same", warmed === "ready", warmed);
      const released = await until("idle", 120);
      check("…and the warmed model, never asked for, is let go after the idle time", released === "idle" && Date.now() - warmedAt >= 60_000, `${released} after ${Math.round((Date.now() - warmedAt) / 1000)} s`);
    } finally {
      await site.close();
      await request("engine.settings", { idle_unload_s: 300 });
    }
  }
  check("no errors in the worker or the pages", problems.length === 0, problems.join(" | "));
} catch (error) {
  check("no exception", false, String(error?.stack ?? error));
} finally {
  await context.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  await closeServer();
}
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
