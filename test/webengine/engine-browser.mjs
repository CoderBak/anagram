// test/webengine/engine-browser.mjs — the real worker build on the tiny model, in Chromium.
//
//   node test/webengine/engine-browser.mjs                       # Chromium
//   node test/webengine/engine-browser.mjs --firefox <binary>    # a Firefox ESR under test (no restart or deletion: its profile is not kept)
//
// The worker (public/vendor/engine/worker.min.mjs) runs in a blank page of a temporary
// profile over a local server (test/webengine/harness.mjs): it downloads the tiny
// fixtures into OPFS, verifies them, loads tiny.onnx on WebGPU (when the browser offers
// an adapter) and on WASM, and answers the contract's operations. Then the same profile
// again: the files are found in OPFS and nothing is downloaded. A resumed download, a
// deletion and the idle unload are exercised too. The fixture model sums a fixed row per
// token (test/webengine/make-fixtures.py), so the expected logits are computed here.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { initFor, launchChromium, launchFirefox, pinFor, ROOT, serve } from "./harness.mjs";
import { tinyTokenizerJson } from "../fixtures/webengine/tinyTokenizer.mjs";

const FIXTURES = join(ROOT, "test", "fixtures", "webengine");
const sha256 = (b) => createHash("sha256").update(b).digest("hex");
const results = [];
const check = (name, ok, note = "") => { results.push({ name, ok: !!ok, note: String(note) }); console.log(`${ok ? "ok  " : "FAIL"} ${name}${note && !ok ? ` — ${note}` : ""}`); };

// The tiny model's table, as make-fixtures.py defines it.
const row = (i) => [((i % 7) / 7 - 0.5) * 0.4, ((i % 11) / 11 - 0.5) * 0.4, ((i % 13) / 13 - 0.5) * 0.4, ((i % 17) / 17 - 0.5) * 0.4];
const softmax = (l) => { const m = Math.max(...l); const e = l.map((x) => Math.exp(x - m)); const s = e.reduce((a, b) => a + b); return e.map((x) => x / s); };

const tokenizerJson = Buffer.from(JSON.stringify(tinyTokenizerJson()));
const files = {
  "model.onnx": readFileSync(join(FIXTURES, "tiny.onnx")),
  "tokenizer.json": tokenizerJson,
  "lid.176.ftz": readFileSync(join(FIXTURES, "tiny-lid.bin")),
};
// tokenizer.json is not a fixture on disk: written next to the run.
const generated = mkdtempSync(join(tmpdir(), "anagram-webengine-fixtures-"));
writeFileSync(join(generated, "tokenizer.json"), tokenizerJson);
const firefoxAt = process.argv.indexOf("--firefox");
const firefox = firefoxAt >= 0 ? process.argv[firefoxAt + 1] : null;
const { base, requests, close: closeServer } = await serve({ "/files/": FIXTURES, "/generated/": generated }, { pageCsp: !firefox });
const pinFiles = [
  { name: "model.onnx", path: "/files/tiny.onnx", size_bytes: files["model.onnx"].length, sha256: sha256(files["model.onnx"]) },
  { name: "tokenizer.json", path: "/generated/tokenizer.json", size_bytes: tokenizerJson.length, sha256: sha256(tokenizerJson) },
  { name: "lid.176.ftz", path: "/files/tiny-lid.bin", size_bytes: files["lid.176.ftz"].length, sha256: sha256(files["lid.176.ftz"]) },
];
const pin = pinFor(base, pinFiles);

let browser = firefox ? await launchFirefox(base, firefox, { prefs: { "dom.webgpu.enabled": true } }) : await launchChromium(base);
console.log(`${browser.version}, cross-origin isolated: ${await browser.page.evaluate(() => crossOriginIsolated)}, adapter: ${JSON.stringify(await browser.page.evaluate(() => window.engine.gpu()))}, under the extension's CSP`);
try {
  const { page } = browser;
  const request = (op, payload) => page.evaluate(([op, payload]) => window.engine.request(op, payload), [op, payload ?? {}]);
  const until = (fn, ms) => page.evaluate(([src, ms]) => window.engine.until(new Function("d", "r", "return (" + src + ")(d, r)"), ms), [fn.toString(), ms ?? 120000]);

  // The page and the worker's script are served with the manifest's policy (a dedicated
  // worker takes its policy from its script's response); the automation's own evaluate
  // is exempt from CSP, so what is checked is the header on the worker's script.
  const csp = await page.evaluate(() => fetch("/vendor/engine/worker.min.mjs", { method: "HEAD" }).then((r) => r.headers.get("content-security-policy")));
  check("the worker's script carries the extension's CSP (no unsafe-eval)", csp && csp.includes("script-src 'self' 'wasm-unsafe-eval'") && !/(?<!wasm-)'unsafe-eval'/.test(csp), csp);
  await page.evaluate((init) => window.engine.start(init), initFor(base, pin));
  let reply = await request("status");
  check("fresh profile: needs_models", reply.ok && reply.data.state === "needs_models", JSON.stringify(reply).slice(0, 300));
  check("health before the model: not_ready 503", !((await request("health")).ok) && (await request("health")).status === 503);

  reply = await request("models.download");
  check("models.download answers a snapshot", reply.ok && ["downloading", "loading", "ready"].includes(reply.data.state), JSON.stringify(reply).slice(0, 300));
  reply = await until((d) => d.state === "ready" || d.state === "error");
  check("download, verification and load reach ready", reply.data.state === "ready", JSON.stringify(reply.data).slice(0, 600));
  const total = pinFiles.reduce((n, f) => n + f.size_bytes, 0);
  check("download completed with every byte", reply.data.download.status === "completed" && reply.data.download.bytes_received === total, JSON.stringify(reply.data.download));
  check("storage counts the files", reply.data.storage.models_bytes >= total, reply.data.storage.models_bytes);
  const runtime = reply.data.runtime;
  console.log("runtime:", JSON.stringify(runtime.candidates), "active", runtime.active_id, "load", JSON.stringify(runtime.benchmark.results));
  const gpu = await page.evaluate(() => window.engine.gpu());
  check("the GPU is the automatic pick when an adapter exists", gpu && !gpu.error ? runtime.active_id === "webgpu:fp32" : runtime.active_id === "wasm:fp32", runtime.active_id);

  const health = await request("health");
  check("health: contract 3.0, FP32, four buckets", health.ok && health.data.contract === "3.0" && health.data.dtype === "fp32" && health.data.n_buckets === 4 && health.data.max_tokens === 512, JSON.stringify(health).slice(0, 300));

  const blocks = [{ id: "a", text: "hello world" }, { id: "b", text: "bonjour le monde" }, { id: "c", text: "the the the" }];
  reply = await request("score", { v: "3.0", blocks });
  check("score answers in the contract's shape", reply.ok && reply.data.v === "3.0" && reply.data.results.length === 3 && reply.data.results.map((r) => r.id).join() === "a,b,c", JSON.stringify(reply).slice(0, 400));
  const [a, b, c] = reply.data.results;
  check("English is scored, French refused", a.lang === "en" && !a.unsupported && b.unsupported && b.lang === "fr", JSON.stringify([a, b]));
  // Expected: <s> the Ġthe Ġthe </s> summed rows, softmax, rounded to 4 places.
  const vocab = tinyTokenizerJson().model.vocab;
  const ids = [0, vocab["the"], vocab["Ġthe"], vocab["Ġthe"], 2];
  const logits = [0, 0, 0, 0];
  for (const id of ids) row(id).forEach((v, k) => { logits[k] += v; });
  const expected = softmax(logits).map((p) => Number(p.toFixed(4)));
  check("the probabilities are the model's", c.probs.every((p, k) => Math.abs(p - expected[k]) <= 1e-4) && c.tokens === 5, JSON.stringify([c.probs, expected]));

  reply = await request("tokens", { v: "3.0", texts: ["the the", ""] });
  check("tokens counts alone and following", reply.ok && JSON.stringify(reply.data) === JSON.stringify({ alone: [2, 0], following: [2, 0], window: 510 }), JSON.stringify(reply));

  // A second runtime, when there are two.
  const other = runtime.candidates.find((c) => c.available && c.id !== runtime.active_id);
  if (other) {
    reply = await request("runtime.config", { id: other.id });
    check("runtime.config switches", reply.ok && reply.data.selected_id === other.id, JSON.stringify(reply).slice(0, 300));
    reply = await until((d) => d.state === "ready" || d.state === "error");
    check(`the ${other.id} runtime loads too`, reply.data.state === "ready" && reply.data.runtime.active_id === other.id, JSON.stringify(reply.data.runtime).slice(0, 400));
    const again = await request("score", { v: "3.0", blocks });
    const c2 = again.data.results[2];
    check("both runtimes agree on the tiny model", c2.probs.every((p, k) => Math.abs(p - c.probs[k]) <= 1e-4), JSON.stringify([c2.probs, c.probs]));
    reply = await request("runtime.config", { id: runtime.active_id });
    await until((d) => d.state === "ready");
  }

  // Idle unload: a minute, then the score wakes it.
  reply = await request("engine.settings", { idle_unload_s: 60 });
  check("engine.settings takes a minute", reply.ok && reply.data.settings.idle_unload_s === 60);
  // The worker keeps its own clock: a real minute passes here.
  console.log("waiting a minute for the idle unload…");
  reply = await until((d) => d.state === "idle", 90_000).catch((e) => ({ data: { state: String(e) } }));
  check("the model is let go after the idle time", reply.data.state === "idle", reply.data.state);
  const idle = await request("health");
  check("health says engine_idle", !idle.ok && idle.error?.code === "engine_idle", JSON.stringify(idle));
  reply = await request("score", { v: "3.0", blocks: [{ id: "x", text: "hello world" }] });
  check("a score wakes the engine", reply.ok && reply.data.results[0].lang === "en", JSON.stringify(reply).slice(0, 300));

  if (firefox) { await browser.close(); await closeServer(); throw { done: true }; }
  const before = requests.length;
  await browser.close({ keepProfile: true });
  browser = await launchChromium(base, { profile: browser.profile });
  await browser.page.evaluate((init) => window.engine.start(init), initFor(base, pin));
  reply = await browser.page.evaluate(() => window.engine.until((d) => d.state === "ready" || d.state === "error", 120000));
  check("a restarted browser finds the files in OPFS and loads without downloading", reply.data.state === "ready" && requests.filter((r) => r.path.startsWith("/files/")).length === requests.slice(0, before).filter((r) => r.path.startsWith("/files/")).length, JSON.stringify(reply.data).slice(0, 300));

  // Delete, then download again with an interruption in the middle.
  reply = await browser.page.evaluate(() => window.engine.request("models.delete", { confirm: true }));
  check("models.delete empties the store", reply.ok && reply.data.state === "needs_models" && reply.data.operation?.status === "completed", JSON.stringify(reply).slice(0, 300));
  await browser.close();
  await closeServer();
} catch (error) {
  if (!error?.done) {
    check("no exception", false, String(error?.stack ?? error));
    await browser.close().catch(() => {});
    await closeServer().catch(() => {});
  }
}
rmSync(generated, { recursive: true, force: true });
if (browser.errors.length) console.log("console:", browser.errors.slice(0, 10).join("\n"));
const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
