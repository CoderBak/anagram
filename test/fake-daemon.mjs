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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export const CONTRACT = "2.1";
export const FAKE_MODEL = { id: "fake-editlens", ver: "test", calibration: "none" };
const BUCKETS = ["human", "lightly-edited", "heavily-edited", "ai-generated"];
const FLAT = [0.25, 0.25, 0.25, 0.25];

/** The extension's own version. The fake reports it as the daemon's `app_version`, so a
 *  suite sees a daemon exactly as new as the build under test and nothing asks for an
 *  update unless the suite asked for an old daemon on purpose. */
export const EXTENSION_VERSION = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
).version;

/**
 * The origins anagramd answers CORS for, and nothing else (anagramd/serve.py,
 * EXTENSION_SCHEMES). The fake mirrors that exactly — the headers AND the refusals —
 * because the point of a stand-in is that what passes against it passes against the real
 * one, and since 2026-09-20 the extension holds no host permission for the daemon: if
 * these headers were wrong it could not read a single answer.
 */
const EXTENSION_SCHEMES = ["chrome-extension://", "moz-extension://", "safari-web-extension://"];

/** The request's Origin when it is an extension's, else null. */
function extensionOrigin(req) {
  const origin = req.headers.origin;
  const lower = origin?.trim().toLowerCase();
  return lower && EXTENSION_SCHEMES.some((s) => lower.startsWith(s)) ? origin : null;
}

/** No wildcard, no credentials: the caller's own origin, and the Vary that says so. */
const corsHeaders = (origin) => ({ "access-control-allow-origin": origin, vary: "Origin" });

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
 *  otherwise; past 512 the result comes back `truncated`, as the real daemon's does. */
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

/** How many block texts `stats.texts` keeps (oldest dropped): a 3000-paragraph perf
 *  page must not turn the recorder into a memory leak. */
const MAX_RECORDED_TEXTS = 500;

/**
 * Start the fake on 127.0.0.1. `close()` stops it (the extension then sees "connection
 * refused" = daemon down); start again with the same `port` to bring it back.
 *
 * `stats.preflights` counts the CORS preflights answered — the proof, for a suite driving
 * the SHIPPING build, that a POST really did go out as a cross-origin request rather than
 * on a host permission. `stats.texts` is what the daemon was actually asked about — a suite proving that some
 * paragraph never left the page reads it. `delayFor(text)` returns milliseconds to hold
 * a request for, which parks a chosen paragraph in flight (a stalled daemon) while
 * everything else keeps its ordinary latency. `tokensFor(text)` returns a token count for
 * a chosen text (null = the ordinary four characters a token), which is how a suite makes
 * a short paragraph DENSE: more tokens than the model's window in fewer characters than
 * the extension's window budget.
 *
 * Two knobs stand in for an OLD daemon, the one thing the extension has to tell from an
 * absent one: `cors: false` answers no CORS header and no preflight, the way every daemon
 * before 0.3.3 did, and `appVersion` sets (or, as null, omits) the version `/health`
 * reports.
 */
export function startFakeDaemon({ port = 0, latency = [60, 160], model = FAKE_MODEL, delayFor = null, tokensFor = null, cors = true, appVersion = EXTENSION_VERSION } = {}) {
  const stats = { requests: 0, blocks: 0, nonEnglishBlocks: 0, texts: [], preflights: 0 };
  const server = http.createServer((req, res) => {
    const ext = cors ? extensionOrigin(req) : null;
    const json = (code, body) => {
      res.writeHead(code, { "content-type": "application/json", ...(ext ? corsHeaders(ext) : {}) });
      res.end(JSON.stringify(body));
    };
    // The real daemon's Origin guard: an Origin that is neither an extension's nor its own
    // is 403 with nothing on it, preflight included, so a web page can never read us.
    const origin = req.headers.origin;
    if (origin !== undefined && extensionOrigin(req) === null && origin !== `http://${req.headers.host}`) {
      res.writeHead(403, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ detail: `origin ${origin} is not allowed` }));
    }
    if (req.method === "OPTIONS") {
      if (!ext || !req.headers["access-control-request-method"]) {
        // No CORS, or not a preflight: what a router with no OPTIONS handler answers.
        res.writeHead(405, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ detail: "Method Not Allowed" }));
      }
      stats.preflights++;
      const headers = {
        ...corsHeaders(ext),
        "access-control-allow-methods": "GET, POST",
        "access-control-allow-headers": "content-type",
        "access-control-max-age": "600",
      };
      if ((req.headers["access-control-request-private-network"] ?? "").toLowerCase() === "true") {
        headers["access-control-allow-private-network"] = "true";
      }
      res.writeHead(204, headers);
      return void res.end();
    }
    if (req.method === "GET" && req.url === "/health") {
      return json(200, {
        ok: true, contract: CONTRACT, model, n_buckets: 4, buckets: BUCKETS, languages: ["en"],
        lid: "fake-script-heuristic", max_tokens: 512, device: "fake", dtype: "none",
        ...(appVersion === null ? {} : { app_version: appVersion }),
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
        for (const b of blocks) {
          if (typeof b?.text !== "string") continue;
          if (detectLanguage(b.text)[0] !== "en") stats.nonEnglishBlocks++;
          stats.texts.push(b.text);
        }
        if (stats.texts.length > MAX_RECORDED_TEXTS) {
          stats.texts.splice(0, stats.texts.length - MAX_RECORDED_TEXTS);
        }
        const results = blocks.map((b) =>
          typeof b?.text === "string" && b.text.trim()
            ? { id: b.id, ...fakeScore(b.text, tokensFor?.(b.text) ?? undefined) }
            : { id: b.id, bucket: 0, probs: FLAT, score: 0, tokens: 0, truncated: false, degraded: true },
        );
        // A request is answered no sooner than its slowest block asks for.
        let wait = latency[0] + Math.random() * (latency[1] - latency[0]);
        if (delayFor) {
          for (const b of blocks) {
            const d = typeof b?.text === "string" ? delayFor(b.text) : null;
            if (typeof d === "number" && d > wait) wait = d;
          }
        }
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
