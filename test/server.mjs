// test/server.mjs — end-to-end against the REAL backend (local-only; needs the model).
//
// Spawns anagramd (or reuses one already listening), loads the built extension in a
// fresh Chromium profile — backend mode "auto" must pick the daemon up on its own —
// and checks that genuine EditLens verdicts flow through: the daemon's API answers
// with sane buckets, chips render "<n>% AI", the hover card shows the 4-bucket
// distribution with the EditLens footer, and the popup names the model.
//
//   node test/server.mjs            (ANAGRAMD_PORT to override 8765)
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const EXT = join(ROOT, "output", "chrome-mv3");
const PORT = Number(process.env.ANAGRAMD_PORT || 8765);
const BASE = `http://127.0.0.1:${PORT}`;
const BADGE_SEL = '[data-anagram="host"]:not(#anagram-fab)';

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
if (!h) {
  console.log("starting anagramd…");
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
const AI =
  "In today's rapidly evolving digital landscape, effective communication has become more crucial than " +
  "ever. By leveraging cutting-edge technologies and fostering a culture of collaboration, organizations " +
  "can unlock unprecedented opportunities for growth. This comprehensive approach not only enhances " +
  "productivity but also empowers teams to navigate complex challenges with confidence and agility.";
{
  const r = await fetch(`${BASE}/score`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ v: "2.0", blocks: [{ id: "h", text: HUMAN }, { id: "a", text: AI }, { id: "e", text: "" }] }),
  }).then((r) => r.json());
  const by = Object.fromEntries(r.results.map((x) => [x.id, x]));
  check("API: human sample → bucket 0", by.h?.bucket === 0 && by.h.score < 0.2, JSON.stringify(by.h?.probs));
  check("API: AI sample → bucket 3", by.a?.bucket === 3 && by.a.score > 0.8, JSON.stringify(by.a?.probs));
  check("API: empty text → degraded, never cached", by.e?.degraded === true, JSON.stringify(by.e));
  check("API: probs sum to 1", Math.abs(by.h.probs.reduce((s, p) => s + p, 0) - 1) < 0.01);
}

// --- 3. extension against the daemon --------------------------------------------------
const html = readFileSync(join(__dirname, "selftest.html"), "utf8");
const server = http.createServer((_q, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://localhost:${server.address().port}/selftest.html`;

const context = await chromium.launchPersistentContext("", {
  headless: false,
  viewport: { width: 1280, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
const extId = sw ? new URL(sw.url()).host : null;
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
check("chips rendered with real verdicts", chips.length > 5 && verdicts.length === chips.length, `${chips.length} chips, bands: ${[...new Set(chips.map((c) => c.band))].join(",")}`);
check("every chip reads '<n>% AI'", chips.every((c) => /^\d{1,3}% AI( ×\d+)?$/.test(c.num)), chips.slice(0, 4).map((c) => c.num).join(" | "));
check("hover cards carry the 4-bucket distribution", chips.every((c) => c.segs === 4 && c.rows === 4));
check("card footer names EditLens (not the stub)", chips.every((c) => /EditLens/.test(c.foot)), chips[0]?.foot);
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
  check("GET_BACKEND_STATUS → active server", status?.active === "server" && status?.model?.id === "editlens_roberta-large", JSON.stringify(status?.server));
}

await context.close();
server.close();
if (daemon) daemon.kill("SIGTERM");

const failed = checks.filter(([, ok]) => !ok).length;
console.log(`\n${checks.length - failed}/${checks.length} server checks passed`);
process.exit(failed ? 1 : 0);
