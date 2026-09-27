// test/webengine/parity.mjs — the in-browser engine against Pangram's official inference,
// on WebGPU and on WASM, with the product's speed and memory measured on the way.
//
//   ANAGRAM_MODELKIT=<modelkit dir> ANAGRAM_LID_MODEL=<lid.176.ftz> ANAGRAM_PARITY_SAMPLE=<sample.json> \
//     node test/webengine/parity.mjs [--runtimes webgpu,wasm] [--report out.json] [--clean] [--firefox <binary>]
//
// The sample is test/webengine/parity-sample.py's: the 200 texts test/editlens-parity.py
// scores (100 longer than the model's window) with the official FP32 probabilities and
// the native tokenizer's counts. The real worker build runs in a temporary Chromium
// profile (test/webengine/harness.mjs) that keeps the 1.4 GB model between runs under
// the system temp directory — one profile, reused, removed with --clean — and takes the
// pinned files from a local server rather than the network, verified against the same
// hashes as a real download. Every text's four probabilities must agree with the
// official ones to 1e-4 after the engine's rounding, and the bucket, the verdict word
// and the token count exactly; the `tokens` counts must equal the native engine's. Then
// the product's shapes (1×160, 8×160, 4×448, 32×512 tokens) are timed through the score
// operation, and the browser's processes are watched for their peak resident memory.
// Skips when a path is missing or CI is set; never part of CI (the data is gated).
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initFor, launchChromium, launchFirefox, ROOT, serve } from "./harness.mjs";

const argv = process.argv.slice(2);
const opt = (name, fallback) => { const i = argv.indexOf(`--${name}`); return i < 0 ? fallback : argv[i + 1]; };
const flag = (name) => argv.includes(`--${name}`);
const CUTS = [1 / 6, 1 / 2, 5 / 6];
const TOLERANCE = 1e-4;
const MAX_LENGTH = 512;
const level = (score) => CUTS.filter((cut) => score >= cut).length;
const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const profile = join(tmpdir(), "anagram-webengine-parity-profile");
if (flag("clean")) { rmSync(profile, { recursive: true, force: true }); console.log("removed", profile); process.exit(0); }
if (process.env.CI) { console.log("SKIP  web engine parity — never in CI"); process.exit(0); }
const kit = process.env.ANAGRAM_MODELKIT, lid = process.env.ANAGRAM_LID_MODEL, samplePath = process.env.ANAGRAM_PARITY_SAMPLE;
const missing = [["ANAGRAM_MODELKIT", kit], ["ANAGRAM_LID_MODEL", lid], ["ANAGRAM_PARITY_SAMPLE", samplePath]].filter(([, v]) => !v).map(([k]) => k);
if (missing.length) { console.log(`SKIP  web engine parity — set ${missing.join(", ")}`); process.exit(0); }
const modelPath = join(kit, "onnx", "model.onnx");
for (const path of [modelPath, join(kit, "tokenizer.json"), lid, samplePath]) {
  if (!existsSync(path)) { console.log(`SKIP  web engine parity — missing ${path}`); process.exit(0); }
}
const modelkit = JSON.parse(readFileSync(join(ROOT, "anagramd", "modelkit.json"), "utf8"));
const entry = (path) => modelkit.files.find((f) => f.path === path);
const LID_SHA = "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83";
for (const [path, file] of [["onnx/model.onnx", modelPath], ["tokenizer.json", join(kit, "tokenizer.json")]]) {
  if (statSync(file).size !== entry(path).size_bytes) { console.log(`SKIP  web engine parity — ${file} is not the pinned size`); process.exit(0); }
}
const sample = JSON.parse(readFileSync(samplePath, "utf8"));
const runtimes = opt("runtimes", "webgpu,wasm").split(",").filter(Boolean);
mkdirSync(profile, { recursive: true });

const firefox = opt("firefox");
const { base, close: closeServer } = await serve({ "/kit/": kit, "/lid/": join(lid, "..") }, { pageCsp: !firefox });
const pin = {
  files: [
    { name: "model.onnx", size_bytes: entry("onnx/model.onnx").size_bytes, sha256: entry("onnx/model.onnx").sha256, url: `${base}/kit/onnx/model.onnx` },
    { name: "tokenizer.json", size_bytes: entry("tokenizer.json").size_bytes, sha256: entry("tokenizer.json").sha256, url: `${base}/kit/tokenizer.json` },
  ],
  lid: { name: "lid.176.ftz", size_bytes: 938013, sha256: LID_SHA, url: `${base}/lid/${lid.split("/").pop()}` },
  model: { id: "editlens_roberta-large", calibration: "editlens-4bucket-cosine(0.03,0.15)" },
  license: modelkit.license,
};

/** Peak memory of the browser's processes, by kind, through test/webengine/memwatch.py (phys_footprint, Metal buffers included). */
function watchMemory(substring) {
  const out = join(tmpdir(), `anagram-webengine-memory-${process.pid}.json`);
  const child = spawn("python3", [join(ROOT, "test", "webengine", "memwatch.py"), substring, out, "0.25"], { stdio: "ignore" });
  return {
    stop: async () => {
      child.kill("SIGTERM");
      await new Promise((resolve) => child.on("exit", resolve));
      try {
        const data = JSON.parse(readFileSync(out, "utf8"));
        rmSync(out, { force: true });
        const gib = (n) => +(n / 2 ** 30).toFixed(2);
        return { total: gib(data.total_phys_peak), ...Object.fromEntries(Object.entries(data.kinds).map(([k, v]) => [k, gib(v.phys)])) };
      } catch { return {}; }
    },
  };
}

const report = { started: new Date().toISOString(), sample: sample.length, longer_than_512: sample.filter((t) => t.length > MAX_LENGTH).length, runtimes: {} };
const browser = firefox ? await launchFirefox(base, firefox, { prefs: { "dom.webgpu.enabled": true } }) : await launchChromium(base, { profile });
let memory = watchMemory(firefox ? browser.profile : profile);
report.browser = browser.version;
report.isolated = await browser.page.evaluate(() => crossOriginIsolated);
report.adapter = await browser.page.evaluate(() => window.engine.gpu());
console.log(`${report.browser}, cross-origin isolated ${report.isolated}, adapter ${JSON.stringify(report.adapter)}`);
let failed = false;
try {
  const { page } = browser;
  const request = (op, payload) => page.evaluate(([op, payload]) => window.engine.request(op, payload), [op, payload ?? {}]);
  const until = (src, ms) => page.evaluate(([src, ms]) => window.engine.until(new Function("d", "r", `return (${src})(d, r)`), ms), [src, ms ?? 900_000]);
  let t0 = performance.now();
  await page.evaluate((init) => window.engine.start(init), initFor(base, pin));
  let status = await request("status");
  console.log("engine:", status.data.state);
  if (status.data.state === "needs_models" || status.data.state === "paused" || status.data.state === "error") {
    await request(status.data.state === "paused" ? "engine.resume" : "models.download");
    status = await until("(d) => d.download.status === 'completed' || d.state === 'error' || d.state === 'ready'");
    report.download_s = +((performance.now() - t0) / 1000).toFixed(1);
    console.log(`download and verification: ${report.download_s} s (local server, ${status.data.download.status})`);
    if (status.data.state === "error") throw new Error(`engine error: ${JSON.stringify(status.data.error)}`);
  }
  status = await until("(d) => d.state === 'ready' || d.state === 'error'");
  if (status.data.state !== "ready") throw new Error(`engine never ready: ${JSON.stringify(status.data).slice(0, 800)}`);
  report.storage_bytes = status.data.storage.models_bytes;
  report.candidates = status.data.runtime.candidates;
  console.log("candidates:", status.data.runtime.candidates.map((c) => `${c.id}: ${c.available ? "available" : c.reason}`).join("; "));

  for (const runtime of runtimes) {
    const id = `${runtime}:fp32`;
    const out = { id };
    report.runtimes[runtime] = out;
    report.memory_peak_gib_startup ??= await memory.stop();
    memory = watchMemory(firefox ? browser.profile : profile);
    if (!status.data.runtime.candidates.some((c) => c.id === id && c.available)) { out.skipped = "not available"; console.log(`SKIP  ${id} — not available here`); continue; }
    // A cold start of this runtime: stop, then resume, so the load is measured from disk.
    await request("engine.stop");
    await request("runtime.config", { id });
    t0 = performance.now();
    await request("engine.resume");
    status = await until("(d) => d.state === 'ready' || d.state === 'error'");
    if (status.data.state !== "ready" || status.data.runtime.active_id !== id) { out.skipped = `failed to load: ${JSON.stringify(status.data.runtime.error ?? status.data.error)}`; console.log(`FAIL  ${id} — ${out.skipped}`); failed = true; continue; }
    out.cold_start_ms = Math.round(performance.now() - t0);
    const load = status.data.runtime.benchmark.results.find((r) => r.candidate_id === id);
    out.session_create_ms = load?.load_ms;
    out.first_run_ms = load?.warmup_ms;
    out.label = status.data.runtime.candidates.find((c) => c.id === id)?.label;
    console.log(`${id}: cold start ${out.cold_start_ms} ms (session ${out.session_create_ms} ms, first pass ${out.first_run_ms} ms) — ${out.label}`);

    // Parity.
    t0 = performance.now();
    const results = [];
    for (let start = 0; start < sample.length; start += 50) {
      const blocks = sample.slice(start, start + 50).map((t, i) => ({ id: String(start + i), text: t.text }));
      const reply = await request("score", { v: "3.0", blocks });
      if (!reply.ok) throw new Error(`score failed on ${id}: ${JSON.stringify(reply)}`);
      results.push(...reply.data.results);
      out.model_version = reply.data.model.ver;
    }
    out.score_s = +((performance.now() - t0) / 1000).toFixed(1);
    const counts = { data: { alone: [], following: [] } };
    for (let start = 0; start < sample.length; start += 16) {
      const reply = await request("tokens", { v: "3.0", texts: sample.slice(start, start + 16).map((t) => t.text) });
      if (!reply.ok) throw new Error(`tokens failed on ${id}: ${JSON.stringify(reply)}`);
      counts.data.alone.push(...reply.data.alone);
      counts.data.following.push(...reply.data.following);
    }
    const rows = [];
    let dp = 0, ds = 0, exact = 0, gated = 0, bucket = 0, verdict = 0, tokens = 0;
    const failures = [];
    sample.forEach((t, k) => {
      const r = results[k];
      if (r.unsupported) { gated++; console.log(`NOTE  language gate refused ${t.text_id} (${r.lang} ${r.lang_prob})`); return; }
      const diff = Math.max(...r.probs.map((p, i) => Math.abs(p - t.official[i])));
      const officialBucket = t.official.indexOf(Math.max(...t.official));
      const officialScore = t.official.reduce((a, p, i) => a + p * i, 0) / 3;
      const sameBucket = r.bucket === officialBucket, sameLevel = level(r.score) === level(officialScore);
      const sameTokens = r.tokens === Math.min(t.length, MAX_LENGTH) && r.truncated === (t.length > MAX_LENGTH) &&
        counts.data.alone[k] === t.alone && counts.data.following[k] === t.following;
      dp = Math.max(dp, diff); ds = Math.max(ds, Math.abs(r.score - officialScore));
      exact += t.official.map((p) => Number(p.toFixed(4))).every((p, i) => p === r.probs[i]);
      bucket += sameBucket; verdict += sameLevel; tokens += sameTokens;
      const ok = diff <= TOLERANCE && sameBucket && sameLevel && sameTokens;
      if (!ok) failures.push(t.text_id);
      rows.push({ text_id: t.text_id, tokens: t.length, official: t.official, browser: r.probs, native: t.native, max_abs_diff: diff, bucket: [officialBucket, r.bucket], level: [level(officialScore), level(r.score)], ok });
    });
    const compared = sample.length - gated;
    Object.assign(out, { compared, gated, rounded_identical: exact, max_prob_diff: dp, max_score_diff: ds, bucket_agreement: bucket / compared, verdict_agreement: verdict / compared, counts_identical: tokens, failures: failures.length, texts: rows });
    const nativeDiff = Math.max(...rows.map((r) => Math.max(...r.browser.map((p, i) => Math.abs(p - r.native[i])))));
    out.max_prob_diff_vs_native = nativeDiff;
    console.log(`${id}: ${compared} texts in ${out.score_s} s — max |Δp| ${dp.toExponential(2)} vs official (${exact} identical at four places; ${nativeDiff.toExponential(2)} vs native), buckets ${bucket}/${compared}, verdicts ${verdict}/${compared}, counts ${tokens}/${compared}`);
    if (failures.length) { failed = true; console.log(`FAIL  ${id} parity — ${failures.length} texts differ: ${failures.slice(0, 10).join(", ")}`); }
    else console.log(`PASS  ${id} parity`);

    // Speed at the product's shapes, through the score operation (cleaning, gate and tokenization included).
    out.shapes = {};
    const byAlone = [...sample].sort((a, b) => b.alone - a.alone);
    const exactTokens = async (target) => {
      // A prefix of a long text with exactly `target` text tokens, found with the tokens
      // operation; a text whose words jump over the count is passed over for the next.
      for (const t of byAlone.filter((t) => t.alone > target + 20)) {
        const words = t.text.split(" ");
        let lo = 1, hi = words.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          const n = (await request("tokens", { v: "3.0", texts: [words.slice(0, mid).join(" ")] })).data.alone[0];
          if (n < target) lo = mid + 1; else hi = mid;
        }
        const candidate = words.slice(0, lo).join(" ");
        if ((await request("tokens", { v: "3.0", texts: [candidate] })).data.alone[0] === target) return candidate;
      }
      throw new Error(`no prefix of exactly ${target} tokens`);
    };
    const long = sample.filter((t) => t.length > MAX_LENGTH).map((t) => t.text);
    const shapes = { "1x160": [await exactTokens(158)], "8x160": [], "4x448": [], "32x512": long.slice(0, 32) };
    for (let i = 0; i < 8; i++) shapes["8x160"].push(await exactTokens(158 - i));
    for (let i = 0; i < 4; i++) shapes["4x448"].push(await exactTokens(446 - i));
    for (const [shape, texts] of Object.entries(shapes)) {
      const blocks = texts.map((text, i) => ({ id: `s${i}`, text }));
      const times = [];
      let tokensSeen;
      for (let rep = 0; rep < 4; rep++) {
        t0 = performance.now();
        const reply = await request("score", { v: "3.0", blocks });
        times.push(performance.now() - t0);
        if (!reply.ok) throw new Error(`timing score failed: ${JSON.stringify(reply)}`);
        tokensSeen = reply.data.results.map((r) => r.tokens);
      }
      const [first, ...warm] = times;
      out.shapes[shape] = { first_ms: Math.round(first), median_ms: Math.round(median(warm)), texts_per_s: +(texts.length / (median(warm) / 1000)).toFixed(2), tokens: tokensSeen };
      console.log(`${id} ${shape}: first ${Math.round(first)} ms, then ${Math.round(median(warm))} ms (${out.shapes[shape].texts_per_s} texts/s) — tokens ${[...new Set(tokensSeen)].join("/")}`);
    }
    out.memory_peak_gib = await memory.stop();
    memory = watchMemory(firefox ? browser.profile : profile);
    console.log(`${id} peak memory (GiB): ${JSON.stringify(out.memory_peak_gib)}`);
  }
} catch (error) {
  failed = true;
  console.log(`FAIL  web engine parity — ${error?.stack ?? error}`);
} finally {
  report.memory_peak_gib = await memory.stop();
  console.log("peak memory (GiB, phys_footprint):", JSON.stringify(report.memory_peak_gib));
  if (browser.errors.length) console.log("console:", browser.errors.slice(0, 5).join("\n"));
  await browser.close({ keepProfile: !firefox });
  await closeServer();
}
const reportPath = opt("report");
if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 1));
console.log(failed ? "FAIL  web engine parity" : `PASS  web engine parity — ${runtimes.join(", ")}; profile kept at ${profile} (remove with --clean)`);
process.exit(failed ? 1 : 0);
