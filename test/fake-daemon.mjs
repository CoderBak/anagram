// test/fake-daemon.mjs — a TEST-ONLY stand-in for anagramd that speaks contract 2.1.
//
// The extension ships no scoring fallback of its own: without a daemon it shows
// "Unavailable" and waits. Suites that need deterministic verdicts without the model
// (e2e, scenarios, perf, screenshots, the playground) point the extension at this
// server through test/harness.mjs. Scores are seeded by the paragraph text, so they
// are stable across runs; non-Latin text comes back `unsupported`, like the real
// language gate. Nothing in here is reachable from the shipped extension.
//
//   node test/fake-daemon.mjs [port]     # standalone (default 8766) for manual poking
import http from "node:http";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const CONTRACT = "2.1";
export const FAKE_MODEL = { id: "fake-editlens", ver: "test", calibration: "none" };
const BUCKETS = ["human", "lightly-edited", "heavily-edited", "ai-generated"];
const FLAT = [0.25, 0.25, 0.25, 0.25];

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

/** One coherent, text-seeded result (one dominant bucket, neighbours share the rest). */
export function fakeScore(text) {
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
  const tokens = Math.ceil(text.length / 4);
  return { bucket, probs, score, tokens: Math.min(512, tokens), truncated: tokens > 512, lang: "en", lang_prob: 0.99 };
}

/**
 * Start the fake on 127.0.0.1. `close()` stops it (the extension then sees "connection
 * refused" = daemon down); start again with the same `port` to bring it back.
 */
export function startFakeDaemon({ port = 0, latency = [60, 160], model = FAKE_MODEL } = {}) {
  const stats = { requests: 0, blocks: 0 };
  const server = http.createServer((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "GET" && req.url === "/health") {
      return json(200, {
        ok: true, contract: CONTRACT, model, n_buckets: 4, buckets: BUCKETS, languages: ["en"],
        lid: "fake-script-heuristic", max_tokens: 512, device: "fake", dtype: "none",
      });
    }
    if (req.method === "POST" && req.url === "/score") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return json(400, { error: "invalid JSON" });
        }
        const blocks = Array.isArray(parsed?.blocks) ? parsed.blocks : [];
        stats.requests++;
        stats.blocks += blocks.length;
        const results = blocks.map((b) =>
          typeof b?.text === "string" && b.text.trim()
            ? { id: b.id, ...fakeScore(b.text) }
            : { id: b.id, bucket: 0, probs: FLAT, score: 0, tokens: 0, truncated: false, degraded: true },
        );
        const wait = latency[0] + Math.random() * (latency[1] - latency[0]);
        setTimeout(() => json(200, { v: CONTRACT, session: parsed.session ?? null, model, partial: false, results }), wait);
      });
      return;
    }
    json(404, { error: "not found" });
  });
  return new Promise((resolveStart) => {
    server.listen(port, "127.0.0.1", () => {
      const p = server.address().port;
      resolveStart({
        url: `http://127.0.0.1:${p}`,
        port: p,
        stats,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const d = await startFakeDaemon({ port: Number(process.argv[2] || 8766) });
  console.log(`fake anagramd listening on ${d.url}  (GET /health, POST /score) — Ctrl+C to stop`);
}
