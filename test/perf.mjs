// test/perf.mjs — performance budget on a pathological page.
//
// 3000 paragraphs (~55 words each, unique text) — an order of magnitude beyond
// a long Wikipedia article. Budgets: first badge within 4s of load, no single
// main-thread long task over 1s during startup, and the page must keep scoring
// smoothly while scrolling. Run before/after walker changes.
//
//   node test/perf.mjs
import { launchExtension, serveHtml, BADGE_SEL } from "./harness.mjs";
import { startFakeDaemon } from "./fake-daemon.mjs";

const N = 3000;

const words = (seed) => {
  const VOCAB = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings".split(" ");
  let out = [];
  for (let i = 0; i < 55; i++) out.push(VOCAB[(seed * 31 + i * 7) % VOCAB.length]);
  return `Paragraph ${seed}: ` + out.join(" ") + ".";
};
let body = "";
for (let i = 0; i < N; i++) body += `<p>${words(i)}</p>\n`;
const html = `<!doctype html><body style="max-width:720px;margin:30px auto;font:15px/1.6 system-ui">${body}</body>`;

const daemon = await startFakeDaemon();
const server = await serveHtml({ "/perf.html": html });

const { context } = await launchExtension({ backendUrl: daemon.url, viewport: { width: 1100, height: 850 } });
const page = await context.newPage();
await page.addInitScript(() => {
  window.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration));
  }).observe({ entryTypes: ["longtask"] });
});

const t0 = Date.now();
await page.goto(server.url("/perf.html"), { waitUntil: "domcontentloaded" });
await page.waitForSelector(BADGE_SEL, { timeout: 15000 });
const firstBadgeMs = Date.now() - t0;

// scroll a few screens — scoring must keep up without freezing the page
await page.evaluate(async () => {
  for (let i = 0; i < 10; i++) { scrollBy(0, innerHeight * 0.9); await new Promise((r) => setTimeout(r, 250)); }
});
await page.waitForTimeout(2500);

const stats = await page.evaluate((sel) => ({
  badges: document.querySelectorAll(sel).length,
  longTasks: window.__longTasks,
  worst: Math.max(0, ...window.__longTasks),
}), BADGE_SEL);
await context.close();
await server.close();
await daemon.close();

const checks = [
  ["first badge < 4000ms", firstBadgeMs < 4000, `${firstBadgeMs}ms`],
  ["worst main-thread long task < 1000ms", stats.worst < 1000, `${stats.worst}ms of ${stats.longTasks.length} long tasks`],
  ["scroll keeps scoring (>= 60 badges after 10 screens)", stats.badges >= 60, `${stats.badges} badges`],
];
console.log(`page: ${N} paragraphs`);
for (const [name, ok, note] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}  —  ${note}`);
const pass = checks.every(([, ok]) => ok);
console.log(pass ? "✅ PERF BUDGET MET" : "❌ PERF BUDGET EXCEEDED");
process.exit(pass ? 0 : 1);
