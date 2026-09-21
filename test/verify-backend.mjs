// test/verify-backend.mjs — prove every chip is the daemon's own answer for that paragraph.
//
// 1. With anagramd up: load the built extension on the self-test page, read each
//    chip's paragraph text + the probabilities in its hover card, POST the SAME text
//    to the daemon's API directly, and compare. Also counts the daemon's requests.
// 2. With anagramd down: reload; the popup must say the daemon is not running and NO
//    paragraph may carry a verdict (there is no fallback scorer).
//
//   node test/verify-backend.mjs                   a private daemon on a free port
//   ANAGRAMD_PORT=8801 node test/verify-backend.mjs    a private daemon THERE (busy → error)
//   ANAGRAMD_REUSE=1 node test/verify-backend.mjs      the daemon already on 8765
//
// By default the daemon is this run's OWN, on a port nothing is using — part 2 below STOPS
// the daemon to prove the extension shows nothing without one, and that is not a thing to
// do to a daemon somebody else started. Reusing a running one has to be asked for
// (test/daemon-port.mjs), and then part 2 is skipped and nothing is stopped. The extension
// is pointed at the chosen port before any page opens either way.
import { spawn } from "node:child_process";
import { launchExtension, BADGE_SEL } from "./harness.mjs";
import { resolveDaemon } from "./daemon-port.mjs";
import { finishTestSetup, testRuntimeConfig } from "./runtime-ready.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const healthOf = (base) => fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) }).then((r) => (r.ok ? r.json() : null), () => null);
// A refusal here is a sentence for a person to read, not a stack trace; exit 2 is the
// code this script already uses for "did not run", as against a mismatch's 1.
const target = await resolveDaemon(healthOf).catch((e) => {
  console.error(e.message);
  process.exit(2);
});
const PORT = target.port;
const BASE = target.base;
const health = () => healthOf(BASE);

// --- daemon (ours unless we were told to borrow one; its log is where the request count
//     comes from, which is why a borrowed daemon cannot be counted) ---------------------
let daemonLog = "";
let daemon = null;
const runtimeConfig = target.start ? testRuntimeConfig() : null;
process.on("exit", () => runtimeConfig?.cleanup());
if (target.start) {
  daemon = spawn("sh", [join(ROOT, "anagramd", "run.sh"), "--port", String(PORT), "--runtime-config", runtimeConfig.path], { stdio: ["ignore", "pipe", "pipe"] });
  daemon.stdout.on("data", (d) => (daemonLog += d));
  daemon.stderr.on("data", (d) => (daemonLog += d));
  await finishTestSetup(BASE, health).catch((error) => {
    daemon.kill("SIGTERM");
    throw error;
  });
} else {
  console.log(`(reusing the anagramd already listening on ${BASE} — this run neither started nor will stop it; request counting and the daemon-down half are skipped)`);
}
const h = await health();
if (!h) {
  console.error(`no anagramd answered on ${BASE} — its log so far:\n${daemonLog.slice(-2000)}`);
  daemon?.kill("SIGTERM");
  process.exit(2);
}
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
  // A scored verdict: not "Unavailable" (band-unknown), not still "analyzing…" (pending),
  // and not an "unsupported language" chip — the page's Chinese paragraphs are settled by
  // the content script's own language gate and appear with no daemon at all, by design.
  const verdicts = await page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((h) => {
    const pill = h.shadowRoot?.querySelector(".pill");
    return pill && !pill.classList.contains("band-unknown") && !pill.classList.contains("pending") && !pill.classList.contains("band-unsupported");
  }).length, BADGE_SEL);
  return { chips, backendLine, verdicts };
}

const launch = async () => (await launchExtension({ backendUrl: BASE, viewport: { width: 1200, height: 800 } })).context;

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
  // The chip writes the score the way lib/render/score.ts does — ".93", "1.0" — so the
  // daemon's own number is written the same way before the two are compared.
  const hundredths = Math.round(r.score * 100);
  const apiScore = hundredths >= 100 ? "1.0" : `.${String(hundredths).padStart(2, "0")}`;
  const chipScore = c.num.replace(/ ×\d+$/, "");
  const match = apiProbs.every((p, k) => Math.abs(p - c.probs[k]) <= 1) && Math.abs(hundredths - Math.round(parseFloat(chipScore) * 100)) <= 1;
  allMatch &&= match;
  console.log(`${c.num.padEnd(12)} ${JSON.stringify(c.probs).padEnd(22)} | ${apiScore.padEnd(9)} ${JSON.stringify(apiProbs).padEnd(20)} ${match ? "✓" : "✗"}   "${c.text.slice(0, 40)}…"`);
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
