// test/server.mjs — end-to-end against the REAL daemon (local-only; needs the model).
//
// Spawns anagramd (or reuses one already listening), then loads the built extension in a
// fresh Chromium profile pointed at THAT daemon, and checks that genuine EditLens verdicts
// flow through: the API answers with sane buckets and refuses what it must refuse, chips
// render a bare ".93", the hover card shows the 4-bucket distribution with the EditLens footer,
// and the popup names the model. The daemon is the only scorer there is.
//
//   node test/server.mjs            (ANAGRAMD_PORT to override 8765)
import { spawn } from "node:child_process";
import { launchExtension, BADGE_SEL, EXT } from "./harness.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = Number(process.env.ANAGRAMD_PORT || 8765);
const BASE = `http://127.0.0.1:${PORT}`;

if (!existsSync(join(EXT, "manifest.json"))) {
  console.error("Build first: npm run build");
  process.exit(2);
}

const checks = [];
const check = (name, ok, note = "") => {
  checks.push([name, !!ok, note]);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${note ? "  —  " + note : ""}`);
};

async function health() {
  try {
    const r = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

// --- 1. daemon up (spawn if needed) ---------------------------------------------------
let daemon = null;
let h = await health();
if (h) {
  console.log(`reusing the anagramd already listening on ${BASE} — this run neither started nor will stop it`);
} else {
  console.log(`starting anagramd on ${BASE}…`);
  daemon = spawn("sh", [join(ROOT, "anagramd", "run.sh"), "--port", String(PORT)], {
    stdio: ["ignore", "inherit", "inherit"],
  });
  const t0 = Date.now();
  while (!h && Date.now() - t0 < 180_000) {
    await new Promise((r) => setTimeout(r, 1000));
    h = await health();
  }
}
check("daemon /health answers with the EditLens model", h?.ok && h.model?.id === "editlens_roberta-large", JSON.stringify(h?.model));
check("daemon reports 4 buckets and contract 2.x", h?.n_buckets === 4 && String(h?.contract).startsWith("2."), `${h?.n_buckets} · ${h?.contract} · ${h?.device}`);

// --- 2. direct API sanity -------------------------------------------------------------
const HUMAN =
  "I got the call around six, right when the rice was starting to catch on the bottom of the pan. " +
  "My brother never rings on weeknights, so I turned the burner off and sat on the floor to listen. " +
  "He talked for twenty minutes about a dog he was thinking of adopting and never mentioned the thing " +
  "we both knew he had rung to say. Afterwards the rice was ruined and I ate it anyway.";
const ZH =
  "这是一个完全用中文写成的段落。模型只在英文数据上训练过，所以这段文字不应该被打分，而应该被标记为不支持的语言。" +
  "检测器应该能够识别出这一点，并且不要给出一个看起来很可信的百分比。";
const AI =
  "In today's rapidly evolving digital landscape, effective communication has become more crucial than " +
  "ever. By leveraging cutting-edge technologies and fostering a culture of collaboration, organizations " +
  "can unlock unprecedented opportunities for growth. This comprehensive approach not only enhances " +
  "productivity but also empowers teams to navigate complex challenges with confidence and agility.";
{
  const r = await fetch(`${BASE}/score`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: "2.1", blocks: [{ id: "h", text: HUMAN }, { id: "a", text: AI }, { id: "e", text: "" }, { id: "z", text: ZH }] }),
  }).then((r) => r.json());
  const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
  check("API: human sample → bucket 0", by.h?.bucket === 0 && by.h.score < 0.2, JSON.stringify(by.h?.probs));
  check("API: AI sample → bucket 3", by.a?.bucket === 3 && by.a.score > 0.8, JSON.stringify(by.a?.probs));
  check("API: empty text → degraded, never cached", by.e?.degraded === true, JSON.stringify(by.e));
  check("API: probs sum to 1", Math.abs(by.h.probs.reduce((s, p) => s + p, 0) - 1) < 0.01);
  check("API: English samples carry lang=en", by.h?.lang === "en" && by.a?.lang === "en", `${by.h?.lang} ${by.h?.lang_prob}`);
  check("API: Chinese sample → unsupported, not scored (fastText lid)", by.z?.unsupported === true && by.z.lang === "zh" && by.z.tokens === 0, JSON.stringify({ lang: by.z?.lang, p: by.z?.lang_prob }));
  check("daemon /health lists languages + lid", Array.isArray(h.languages) && h.languages.includes("en") && typeof h.lid === "string", `${h.languages} · ${h.lid}`);
  check("model version is derived from the weights hash", /^sha256:[0-9a-f]{12}-/.test(h?.model?.ver ?? ""), h?.model?.ver);
  check("model version also digests the rest of the pipeline (tokenizer, window, dtype, gate)",
    /^sha256:[0-9a-f]{12}-p[0-9a-f]{8}-[a-z0-9]+$/.test(h?.model?.ver ?? ""), h?.model?.ver);
}

// --- 2b. hardening: limits, contract, ids, host, content type, origin ------------------
{
  // Header-level cases go through node's own http client: fetch() always attaches some
  // Content-Type to a body, cannot stream without a length, and treats Origin as forbidden.
  const raw = ({ method = "POST", path = "/score", headers = {}, body } = {}) =>
    new Promise((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", () => resolve(-1));
      if (body !== undefined) req.write(body);
      req.end();
    });
  const post = (body, headers = {}) =>
    fetch(`${BASE}/score`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const many = { v: "2.1", blocks: Array.from({ length: h.limits.max_blocks + 1 }, (_, i) => ({ id: `b${i}`, text: "x" })) };
  check("API: too many blocks → 422", (await post(many)).status === 422);
  const long = { v: "2.1", blocks: [{ id: "a", text: "x".repeat(h.limits.max_text_chars + 1) }] };
  check("API: oversized block → 422", (await post(long)).status === 422);
  check("API: duplicate ids → 422", (await post({ v: "2.1", blocks: [{ id: "a", text: HUMAN }, { id: "a", text: AI }] })).status === 422);
  check("API: other contract major → 422", (await post({ v: "9.0", blocks: [{ id: "a", text: HUMAN }] })).status === 422);
  check("API: missing contract version → 422", (await post({ blocks: [{ id: "a", text: HUMAN }] })).status === 422);
  const big = await post(JSON.stringify({ v: "2.1", blocks: [] }).padEnd(h.limits.max_body_bytes + 10, " "));
  check("API: declared Content-Length over the byte cap → 413", big.status === 413);

  // A chunked body declares no length at all, so only counting the bytes as they arrive can
  // stop it — and the answer has to come while the client is still writing.
  const streamed = await new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/score", method: "POST", headers: { "content-type": "application/json", "transfer-encoding": "chunked" } },
      (res) => { res.resume(); finish(res.statusCode); },
    );
    req.on("error", () => finish(-1));
    const chunk = Buffer.alloc(64 * 1024, 0x78);
    const total = Math.round(2.1 * 1024 * 1024);
    let sent = 0;
    const pump = () => {
      while (!done && sent < total) {
        sent += chunk.length;
        if (!req.write(chunk)) return void req.once("drain", pump);
      }
      if (!done) req.end();
    };
    req.write('{"v":"2.1","blocks":[{"id":"a","text":"');
    pump();
  });
  check("API: 2.1 MB streamed with no Content-Length → 413", streamed === 413, `status ${streamed}`);

  const SMALL = JSON.stringify({ v: "2.1", blocks: [{ id: "a", text: HUMAN }] });
  const JSON_CT = { "content-type": "application/json" };
  check("API: POST text/plain → 415", (await raw({ headers: { "content-type": "text/plain" }, body: SMALL })) === 415);
  check("API: POST with no Content-Type → 415", (await raw({ body: SMALL })) === 415);
  check("API: application/json with a charset parameter → 200", (await raw({ headers: { "content-type": "application/json; charset=utf-8" }, body: SMALL })) === 200);
  check("API: Origin https://evil.example → 403", (await raw({ headers: { ...JSON_CT, Origin: "https://evil.example" }, body: SMALL })) === 403);
  check("API: Origin null (sandboxed frame, file://) → 403", (await raw({ headers: { ...JSON_CT, Origin: "null" }, body: SMALL })) === 403);
  check("API: Origin chrome-extension://… → 200", (await raw({ headers: { ...JSON_CT, Origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop" }, body: SMALL })) === 200);
  check("API: the daemon's own Origin (/docs Try it out) → 200", (await raw({ headers: { ...JSON_CT, Origin: BASE }, body: SMALL })) === 200);
  check("API: no Origin at all (curl, the CLI, node) → 200", (await raw({ headers: JSON_CT, body: SMALL })) === 200);
  check("GET /health without an Origin still answers", (await raw({ method: "GET", path: "/health" })) === 200);

  const rebind = await raw({ method: "GET", path: "/health", headers: { Host: "evil.example" } });
  check("Host header not loopback (DNS rebinding) → 400", rebind === 400, `status ${rebind}`);
  const preflight = await fetch(`${BASE}/score`, { method: "OPTIONS", headers: { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" } });
  check("no CORS grant to web origins", !preflight.headers.get("access-control-allow-origin"), `ACAO=${preflight.headers.get("access-control-allow-origin")}`);
}

// --- 3. extension against the daemon --------------------------------------------------
const html = readFileSync(join(__dirname, "selftest.html"), "utf8");
const server = http.createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://localhost:${server.address().port}/selftest.html`;

// backendUrl pins the extension to the daemon this suite is testing — without it the
// extension would talk to whatever happens to listen on the default port.
const { context, extId } = await launchExtension({ backendUrl: BASE, viewport: { width: 1280, height: 900 } });
check("extension service worker loaded", !!extId, extId ?? "");

const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 140)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 140)); });
await page.goto(url, { waitUntil: "domcontentloaded" });
await page.waitForSelector(BADGE_SEL, { timeout: 30000 }).catch(() => {});
for (let i = 0; i < 6; i++) {
  await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.85));
  await page.waitForTimeout(400);
}
// Let every pending chip resolve.
await page
  .waitForFunction(
    (sel) => {
      const hosts = [...document.querySelectorAll(sel)];
      return hosts.length > 0 && hosts.every((h) => !h.shadowRoot?.querySelector(".pill.pending"));
    },
    BADGE_SEL,
    { timeout: 60000 },
  )
  .catch(() => {});

const chips = await page.evaluate((sel) => {
  const hosts = [...document.querySelectorAll(sel)];
  return hosts.map((h) => ({
    num: h.shadowRoot?.querySelector(".num")?.textContent ?? "",
    band: [...(h.shadowRoot?.querySelector(".pill")?.classList ?? [])].find((c) => c.startsWith("band-")) ?? "",
    segs: h.shadowRoot?.querySelectorAll(".card .dist .seg").length ?? 0,
    rows: h.shadowRoot?.querySelectorAll(".card .dist .drow").length ?? 0,
    foot: h.shadowRoot?.querySelector(".card .foot")?.textContent ?? "",
  }));
}, BADGE_SEL);
const verdicts = chips.filter((c) => c.band !== "band-unknown");
const unsupported = chips.filter((c) => c.band === "band-unsupported");
const scored = chips.filter((c) => c.band !== "band-unsupported");
check("chips rendered with real verdicts", chips.length > 5 && verdicts.length === chips.length, `${chips.length} chips, bands: ${[...new Set(chips.map((c) => c.band))].join(",")}`);
check("every scored chip reads a bare '.93' — an extent on 0-1, never a percentage", scored.every((c) => /^(\.\d{2}|1\.0)( ×\d+)?$/.test(c.num)), scored.slice(0, 4).map((c) => c.num).join(" | "));
check("hover cards carry the 4-bucket distribution", scored.every((c) => c.segs === 4 && c.rows === 4));
check("card footer names EditLens", chips.every((c) => /EditLens/.test(c.foot)), chips[0]?.foot);
check("the Chinese fixture paragraph renders as unsupported ('zh'), no distribution", unsupported.length >= 1 && unsupported.every((c) => /^zh/.test(c.num) && c.segs === 0), unsupported.map((c) => c.num).join(" | "));
check("no page/console errors", errors.length === 0, errors[0] ?? "");

// --- 4. popup names the model ---------------------------------------------------------
if (extId) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`);
  await popup.waitForFunction(() => /Model|Scores/.test(document.getElementById("backend")?.textContent ?? ""), null, { timeout: 10000 }).catch(() => {});
  const text = await popup.evaluate(() => document.getElementById("backend")?.textContent ?? "");
  check("popup shows the live model", /editlens_roberta-large/.test(text), text);
  const status = await popup.evaluate(() =>
    new Promise((resolve) => chrome.runtime.sendMessage({ action: "getBackendStatus" }, resolve)),
  );
  check("GET_BACKEND_STATUS → active server, model named", status?.active === "server" && status?.model?.id === "editlens_roberta-large", JSON.stringify(status?.server));
  check("the extension scored against the daemon this suite spawned", status?.serverUrl === BASE, `${status?.serverUrl} vs ${BASE}`);
}

await context.close();
server.close();
if (daemon) daemon.kill("SIGTERM");

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} server checks passed`);
process.exit(failed ? 1 : 0);
