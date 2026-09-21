// Test-only deterministic Native Messaging host. No inference HTTP endpoint exists.
// Browser launchers register this executable only in temporary profiles/homes.
import { readFileSync, writeFileSync, appendFileSync, renameSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const CONTRACT = "2.1";
export const FAKE_MODEL = { id: "fake-editlens", ver: "test", calibration: "none" };
const BUCKETS = ["human", "lightly-edited", "heavily-edited", "ai-generated"];
const FLAT = [0.25, 0.25, 0.25, 0.25];

/** The extension's own version. The fake reports it as the component's `app_version`, so a
 *  suite sees a component exactly as new as the build under test and nothing asks for an
 *  update unless the suite asked for an old component on purpose. */
export const EXTENSION_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

/** cyrb53 — same 53-bit hash the extension uses for cache keys. */
export function cyrb53(str, seed = 0) {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Mulberry32 PRNG → deterministic [0,1) stream from a seed. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const round = (x) => Math.round(x * 10000) / 10000;

/** Script-based language id — enough for fixtures: Latin → en, kana → ja, Han → zh, Arabic → ar, Cyrillic → ru. */
export function detectLanguage(text) {
  const letters = (text.match(/\p{L}/gu) ?? []).length;
  if (letters === 0) return ["und", 0];
  const count = (re) => (text.match(re) ?? []).length;
  if (count(/\p{Script=Latin}/gu) / letters >= 0.5) return ["en", 0.99];
  if (count(/[\p{Script=Hiragana}\p{Script=Katakana}]/gu) > 0) return ["ja", 0.97];
  let best = ["und", 0];
  for (const [code, re] of [["zh", /\p{Script=Han}/gu], ["ar", /\p{Script=Arabic}/gu], ["ru", /\p{Script=Cyrillic}/gu]]) {
    const share = count(re) / letters;
    if (share > best[1]) best = [code, round(share)];
  }
  return best;
}

/** One coherent, text-seeded result (one dominant bucket, neighbours share the rest).
 *  `tokens` is how long the text is to the model — four characters a token unless told
 *  otherwise; past 512 the result comes back `truncated`, as the real component's does. */
export function fakeScore(text, tokens = Math.ceil(text.length / 4)) {
  const [lang, prob] = detectLanguage(text);
  if (lang !== "en") {
    return { bucket: 0, probs: FLAT, score: 0, tokens: 0, truncated: false, lang, lang_prob: prob, unsupported: true };
  }
  const rng = mulberry32(cyrb53(text));
  const latent = rng();
  const sigma = 0.14 + rng() * 0.12;
  const logits = [0, 1, 2, 3].map((i) => -((latent - i / 3) ** 2) / (2 * sigma * sigma));
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  const probs = exps.map((e) => round(e / sum));
  let bucket = 0;
  for (let i = 1; i < 4; i++) if (probs[i] > probs[bucket]) bucket = i;
  const score = round(probs.reduce((acc, p, i) => acc + p * i, 0) / 3);
  return { bucket, probs, score, tokens: Math.min(512, tokens), truncated: tokens > 512, lang: "en", lang_prob: 0.99 };
}

export const HOST_NAME = "dev.coderbak.anagram";
export const HOST_SCRIPT = fileURLToPath(import.meta.url);
const atomicWrite = (path, value) => {
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, JSON.stringify(value)); renameSync(temp, path);
};
export function readyRuntime() {
  return { schema_version: 1, state: "ready", active_id: "fake-cpu-fp32", selected_id: "fake-cpu-fp32",
    recommended_id: null, needs_selection: false, error: null,
    candidates: [{ id: "fake-cpu-fp32", label: "Test CPU · FP32", device: "cpu", runtime: "torch",
      precision: "fp32", experimental: false, available: true }],
    benchmark: { status: "idle", budget_s: 30, elapsed_s: 0, measurement_s: 0,
      phase: "ready", current_id: null, completed: 0, total: 0, results: [] } };
}
export function readyComponent(home) {
  return { schema_version: 1, version: EXTENSION_VERSION, home, state: "ready", runtime: readyRuntime(),
    storage: { models_bytes: 100 }, error: null, operation: null,
    download: { status: "completed", bytes_received: 100, total_bytes: 100, file: null, error: null } };
}

/** A filesystem control handle, not a server. Each browser starts the real stdio child.
 * close/resume simulate component loss/recovery without changing its registration.
 * Rules are plain test data: contains + delayMs / tokens / charsPerToken. */
const fixtureHomes = new Set();
process.once("exit", () => { for (const home of fixtureHomes) rmSync(home, { recursive: true, force: true }); });
export async function createNativeFixture(options = {}) {
  const home = mkdtempSync(join(tmpdir(), "anagram-native-fixture-"));
  fixtureHomes.add(home);
  const stateFile = join(home, "state.json"), logFile = join(home, "requests.jsonl");
  atomicWrite(stateFile, { enabled: true, latency: [60, 160], model: FAKE_MODEL,
    contract: CONTRACT, appVersion: EXTENSION_VERSION, rules: [], component: readyComponent(home), ...options });
  writeFileSync(logFile, "");
  let drained = 0;
  const requests = () => readFileSync(logFile, "utf8").split("\n").filter(Boolean).map(JSON.parse);
  const fixture = {
    home, stateFile, logFile, label: "native test fixture",
    state: () => JSON.parse(readFileSync(stateFile, "utf8")),
    setState(patch) { atomicWrite(stateFile, { ...fixture.state(), ...patch }); },
    requests,
    get stats() {
      const rows = requests().filter((r) => r.op === "score");
      const blocks = rows.flatMap((r) => r.payload.blocks ?? []);
      const texts = blocks.map((b) => b.text).filter((t) => typeof t === "string");
      return { requests: rows.length, blocks: blocks.length,
        nonEnglishBlocks: texts.filter((t) => detectLanguage(t)[0] !== "en").length, texts: texts.slice(-500) };
    },
    drainTexts() { const rows = requests(); const texts = rows.slice(drained).filter((r) => r.op === "score").flatMap((r) => r.payload.blocks.map((b) => b.text)); drained = rows.length; return texts; },
    async close() { fixture.setState({ enabled: false }); await new Promise((r) => setTimeout(r, 120)); },
    async resume() { fixture.setState({ enabled: true }); },
    dispose() { fixtureHomes.delete(home); rmSync(home, { recursive: true, force: true }); },
  };
  return fixture;
}

async function serveNative(stateFile, logFile) {
  const readState = () => JSON.parse(readFileSync(stateFile, "utf8"));
  const send = (request, reply) => {
    const bytes = Buffer.from(JSON.stringify({ v: 1, id: request.id, ...reply }));
    const header = Buffer.alloc(4); header.writeUInt32LE(bytes.length);
    process.stdout.write(Buffer.concat([header, bytes]));
  };
  const ok = (request, data) => send(request, { ok: true, status: 200, data });
  const failed = (request, status, code, message) => send(request, { ok: false, status, error: { code, message } });
  // A closed fixture breaks the native pipe, including an otherwise idle connection.
  const monitor = setInterval(() => { try { if (!readState().enabled) process.exit(0); } catch { process.exit(0); } }, 50);
  process.stdin.on("end", () => { clearInterval(monitor); process.exit(0); });
  async function handle(request) {
    const s = readState();
    if (!s.enabled) process.exit(0);
    appendFileSync(logFile, JSON.stringify({ ...request, pid: process.pid }) + "\n");
    const component = s.component;
    if (request.op === "health") {
      if (component.state !== "ready") return failed(request, 503, "not_ready", "Fixture engine not ready");
      return ok(request, { ok: true, contract: s.contract, model: s.model, n_buckets: 4, buckets: BUCKETS,
        languages: ["en"], lid: "fake-script-heuristic", max_tokens: 512, device: "fake", dtype: "none", app_version: s.appVersion });
    }
    if (request.op === "score") {
      if (component.state !== "ready") return failed(request, 503, "not_ready", "Fixture engine not ready");
      const blocks = request.payload?.blocks ?? [];
      let delay = s.latency[0] + Math.random() * (s.latency[1] - s.latency[0]);
      const results = blocks.map((b) => {
        const rules = s.rules.filter((r) => b.text.includes(r.contains));
        for (const rule of rules) delay = Math.max(delay, rule.delayMs ?? 0);
        const tokens = rules.find((r) => r.tokens != null || r.charsPerToken != null);
        return { id: b.id, ...fakeScore(b.text, tokens ? tokens.tokens ?? Math.ceil(b.text.length / tokens.charsPerToken) : undefined) };
      });
      await new Promise((r) => setTimeout(r, delay));
      if (!readState().enabled) process.exit(0);
      return ok(request, { v: CONTRACT, model: s.model, partial: false, results });
    }
    if (request.op === "runtime") return component.runtime ? ok(request, component.runtime) : failed(request, 503, "not_ready", "Runtime unavailable");
    if (request.op.startsWith("runtime.")) {
      const runtime = component.runtime;
      if (!runtime) return failed(request, 503, "not_ready", "Runtime unavailable");
      if (request.op === "runtime.config") {
        if (!runtime.candidates.some((c) => c.id === request.payload.id && c.available)) return failed(request, 422, "invalid", "Unknown configuration");
        Object.assign(runtime, { state: "ready", active_id: request.payload.id, selected_id: request.payload.id, needs_selection: false });
      } else if (request.op === "runtime.benchmark") {
        Object.assign(runtime, { state: "benchmarking", active_id: null });
        Object.assign(runtime.benchmark, { status: "running", phase: "measuring", results: [], completed: 0 });
      } else if (request.op === "runtime.cancel") {
        Object.assign(runtime, { state: runtime.selected_id ? "ready" : "awaiting_selection", active_id: runtime.selected_id });
        Object.assign(runtime.benchmark, { status: "cancelled", phase: "idle", current_id: null });
      }
      component.state = runtime.state; atomicWrite(stateFile, s); return ok(request, runtime);
    }
    if (request.op === "engine.stop") component.state = "stopped";
    else if (request.op === "engine.resume") component.state = component.runtime?.state ?? "needs_models";
    else if (request.op === "models.pause") { component.state = "paused"; component.download.status = "paused"; }
    else if (request.op === "models.download") { component.state = "downloading"; component.download.status = "running"; }
    else if (request.op === "component.update") component.operation = { name: "update", status: "completed", receipt: "fixture-update" };
    else if (request.op !== "status") return failed(request, 400, "unsupported", "Unsupported fixture operation");
    if (request.op !== "status") atomicWrite(stateFile, s); return ok(request, component);
  }
  let incoming = Buffer.alloc(0);
  process.stdin.on("data", (chunk) => {
    incoming = Buffer.concat([incoming, chunk]);
    while (incoming.length >= 4) {
      const size = incoming.readUInt32LE(0);
      if (size > 1_000_000) process.exit(2);
      if (incoming.length < size + 4) break;
      const request = JSON.parse(incoming.subarray(4, size + 4));
      incoming = incoming.subarray(size + 4);
      void handle(request).catch((error) => { process.stderr.write(String(error)); process.exit(2); });
    }
  });
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  if (process.argv[2] !== "--host" || !process.argv[3] || !process.argv[4]) throw new Error("Test native host requires --host STATE LOG");
  await serveNative(process.argv[3], process.argv[4]);
}
