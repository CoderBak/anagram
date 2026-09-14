// test/verify-backend.mjs — prove the chips come from the real model, not the stub.
//
// 1. With anagramd up: load the built extension on the self-test page, read each
//    chip's paragraph text + the probabilities in its hover card, POST the SAME text
//    to the daemon's API directly, and compare. Also counts the daemon's requests.
// 2. With anagramd down: reload; the popup must say the daemon is not running and NO
//    paragraph may carry a verdict (there is no fallback scorer).
//   node test/verify-backend.mjs
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const EXT = join(ROOT, "output", "chrome-mv3");
const BASE = "http://127.0.0.1:8765";
const BADGE_SEL = '[data-anagram="host"]:not(#anagram-fab)';

const health = () => fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => (r.ok ? r.json() : null), () => null);

// --- daemon (spawn, capture its log so we can count requests) ---------------------------
let daemonLog = "";
let daemon = null;
if (!(await health())) {
  daemon = spawn("sh", [join(ROOT, "anagramd", "run.sh")], { stdio: ["ignore", "pipe", "pipe"] });
  daemon.stdout.on("data", (d) => (daemonLog += d));
  daemon.stderr.on("data", (d) => (daemonLog += d));
  for (let i = 0; i < 120 && !(await health()); i++) await new Promise((r) => setTimeout(r, 1000));
} else {
  console.log("(reusing an already-running anagramd — request counting unavailable)");
}
const h = await health();
console.log(`daemon: ${h.model.id} on ${h.device} (${h.dtype})`);

const html = readFileSync(join(__dirname, "selftest.html"), "utf8");
const server = http.createServer((_q, res) => { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); res.end(html); });
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://localhost:${server.address().port}/selftest.html`;

async function readChips(context, expectChips = true) {
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" });
  if (expectChips) {
    await page.waitForSelector(BADGE_SEL, { timeout: 30000 });
    await page.waitForFunction((sel) => {
      const hosts = [...document.querySelectorAll(sel)];
      return hosts.length >= 5 && hosts.every((x) => !x.shadowRoot?.querySelector(".pill.pending"));
    }, BADGE_SEL, { timeout: 60000 });
  } else {
    await page.waitForTimeout(4000);
  }
  const chips = await page.evaluate((sel) => [...document.querySelectorAll(sel)].slice(0, 5).map((host) => {
    const sr = host.shadowRoot;
    // The chip lives in a shadow root, so the parent's light-DOM textContent is the paragraph alone.
    const text = (host.parentElement?.textContent ?? "").replace(/\s+/g, " ").trim();
    const probs = [...sr.querySelectorAll(".card .dist .drow .dv")].map((el) => parseInt(el.textContent, 10));
    return { num: sr.querySelector(".num")?.textContent ?? "", probs, text };
  }), BADGE_SEL);
  const popup = await context.newPage();
  const id = new URL(context.serviceWorkers()[0].url()).host;
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await popup.waitForFunction(() => /Model|Scores/.test(document.getElementById("backend")?.textContent ?? ""), null, { timeout: 10000 }).catch(() => {});
  const backendLine = await popup.evaluate(() => document.getElementById("backend")?.textContent ?? "");
  const verdicts = await page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((h) => {
    const pill = h.shadowRoot?.querySelector(".pill");
    return pill && !pill.classList.contains("band-unknown") && !pill.classList.contains("pending");
  }).length, BADGE_SEL);
  return { chips, backendLine, verdicts };
}

const launch = () => chromium.launchPersistentContext("", {
  headless: false, viewport: { width: 1200, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--no-first-run"],
});

// --- 1. daemon UP ---------------------------------------------------------------------
const before = (daemonLog.match(/score \d+ blocks/g) ?? []).length;
let ctx = await launch();
const up = await readChips(ctx);
await ctx.close();
const after = (daemonLog.match(/score \d+ blocks/g) ?? []).length;
console.log(`\npopup says:  "${up.backendLine}"`);
if (daemon) console.log(`daemon handled ${after - before} scoring requests while the page loaded`);

console.log("\nchip (extension)        card probs H/L/H/AI   |  daemon API on the same text   match?");
const api = await fetch(`${BASE}/score`, { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ v: "2.1", blocks: up.chips.map((c, i) => ({ id: String(i), text: c.text })) }) }).then((r) => r.json());
let allMatch = true;
up.chips.forEach((c, i) => {
  const r = api.results.find((x) => x.id === String(i));
  if (r.unsupported) {
    const match = c.num.startsWith(r.lang) && c.probs.length === 0;
    allMatch &&= match;
    console.log(`${c.num.padEnd(12)} ${"(no verdict)".padEnd(22)} | ${("unsupported: " + r.lang).padEnd(30)} ${match ? "✓" : "✗"}   "${c.text.slice(0, 40)}…"`);
    return;
  }
  const apiProbs = r.probs.map((p) => Math.round(p * 100));
  const apiPct = Math.round(r.score * 100);
  const match = apiProbs.every((p, k) => Math.abs(p - c.probs[k]) <= 1) && Math.abs(apiPct - parseInt(c.num, 10)) <= 1;
  allMatch &&= match;
  console.log(`${c.num.padEnd(12)} ${JSON.stringify(c.probs).padEnd(22)} | ${String(apiPct + "% AI").padEnd(9)} ${JSON.stringify(apiProbs).padEnd(20)} ${match ? "✓" : "✗"}   "${c.text.slice(0, 40)}…"`);
});
console.log(allMatch ? "\n✅ every chip equals the daemon's answer for the same paragraph" : "\n❌ mismatch");

// --- 2. daemon DOWN --------------------------------------------------------------------
if (daemon) {
  daemon.kill("SIGTERM");
  for (let i = 0; i < 20 && (await health()); i++) await new Promise((r) => setTimeout(r, 250));
  ctx = await launch();
  const down = await readChips(ctx, false);
  await ctx.close();
  console.log(`\nwith the daemon stopped, popup says:  "${down.backendLine}"`);
  const honest = /Daemon not running/.test(down.backendLine) && down.verdicts === 0;
  console.log(honest ? "✅ no verdict is shown without the daemon" : `❌ ${down.verdicts} verdict chips rendered without a daemon`);
  allMatch &&= honest;
}
server.close();
process.exit(allMatch ? 0 : 1);
