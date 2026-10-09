// test/pw/perf-matrix.spec.mjs — what Anagram costs each kind of page, against no extension.
//
// Not budgets (test/pw/perf.spec.mjs has those): a survey, run by hand when something about
// how Anagram reads or draws changes, printing one PERF line per scenario with both runs and
// what the extension added. Each scenario is opened with Anagram and in a plain browser, with
// every request off this machine refused, and measured by test/perf-kit.mjs.
//
//   ANAGRAM_PERF_MATRIX=1 npx playwright test --project perf --no-deps perf-matrix
//   ONLY=real,idle,bigdom,chatty,spa,menu,paste,startup   scenarios to run (all by default)
//   THROTTLE=4                                     a slow machine (CDP CPU throttling)
//   TOP=6 PAGES=12                                 the corpus pages: the largest, then the
//                                                  largest of each kind
//   SAVE_PROFILE=<prefix>                          keep the CPU profiles (test/perf-kit.mjs)
//   BUILD=<path>                                   another unpacked build, to set against this one
//
// "real" reads the web benchmark's corpus (test/web-bench/corpus.mjs), ~/anagram-bench/webbench/corpus
// unless ANAGRAM_WEB_BENCH says otherwise.
import { readFileSync } from "node:fs";
import { test as base } from "./fixtures.mjs";
import { BADGE_SEL, launchPlain, popupOver, menuReport } from "../harness.mjs";
import { measure, settle, scrollThrough, brief } from "../perf-kit.mjs";

const test = base.extend({});
test.use({ launch: { viewport: { width: 1100, height: 850 } }, tracing: false, ...(process.env.BUILD ? { build: process.env.BUILD } : {}) });
test.skip(!process.env.ANAGRAM_PERF_MATRIX, "a survey run by hand: ANAGRAM_PERF_MATRIX=1");
const THROTTLE = Number(process.env.THROTTLE ?? 1);
const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
const want = (name) => !only || only.includes(name);
const out = (tag, value) => console.log(`PERF ${tag} ${JSON.stringify(value)}`);
const CORPUS = process.env.ANAGRAM_WEB_BENCH ?? `${process.env.HOME}/anagram-bench/webbench/corpus`;
const offline = async (ctx) => { await ctx.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (r) => r.abort()); };

async function control() {
  const browser = await launchPlain({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  await offline(ctx);
  return { ctx, close: () => browser.close() };
}

const WORDS = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings a timetable moved off paper and nobody noticed until the trains ran on time".split(" ");
const words = (seed, n) => Array.from({ length: n }, (_, i) => WORDS[(seed * 7919 + i * 104729) % WORDS.length]).join(" ");
const PAGE = (title, body, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title><style>body{max-width:760px;margin:20px auto;font:16px/1.6 system-ui}</style></head><body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

/** Both runs of one scenario, and the extension's share. */
async function pair(tag, context, url, act) {
  await offline(context);
  const ext = await measure(context, url, { act, throttle: THROTTLE });
  await ext.page.close();
  const c = await control();
  try {
    const ctl = await measure(c.ctx, url, { act, throttle: THROTTLE });
    await ctl.page.close();
    const e = brief(ext), k = brief(ctl);
    out(tag, { ext: e, ctl: k, extra: { script: e.script - k.script, task: e.task - k.task, layout: e.layout - k.layout, style: e.style - k.style, layouts: e.layouts - k.layouts, heapMB: e.heapMB - k.heapMB, nodes: e.nodes - k.nodes }, ourTop: ext.cpu?.top.slice(0, 8), ourLongFrames: ext.ourLongFrames.slice(0, 5), ...(ext.firstChipMs !== undefined ? { firstChipMs: ext.firstChipMs } : {}), ...(ext.frames ? { frames: ext.frames, ctlFrames: ctl.frames } : {}) });
  } finally { await c.close(); }
}

const readAll = async (page) => { await settle(page, { quiet: 2500, most: 20_000 }); await scrollThrough(page, 8, 400); await settle(page, { quiet: 2500, most: 20_000 }); };

test("real heavy pages", async ({ context, pages }) => {
  test.skip(!want("real"));
  test.setTimeout(30 * 60_000);
  const manifest = JSON.parse(readFileSync(`${CORPUS}/manifest.json`, "utf8"));
  const size = (d) => { try { return readFileSync(`${CORPUS}/${d.page}`).length; } catch { return 0; } };
  const sized = manifest.map((d) => ({ ...d, bytes: size(d) })).sort((a, b) => b.bytes - a.bytes);
  const pick = [...sized.slice(0, Number(process.env.TOP ?? 6))];
  for (const type of ["forum", "article", "documentation", "listing", "product", "conversational"]) {
    const d = sized.find((x) => (x.type ?? x.dataset) === type && !pick.includes(x));
    if (d) pick.push(d);
  }
  for (const d of pick.slice(0, Number(process.env.PAGES ?? 99))) {
    const path = `/${d.page.replace(/[^\w.-]/g, "_")}`;
    pages.serve({ [path]: readFileSync(`${CORPUS}/${d.page}`, "utf8") });
    await pair(`real ${d.id} ${d.type ?? d.dataset} ${Math.round(d.bytes / 1024)}KB`, context, pages.url(path), readAll);
  }
});

test("idle: a page read to the end, left open for 30 s", async ({ context, pages }) => {
  test.skip(!want("idle"));
  test.setTimeout(10 * 60_000);
  pages.serve({ "/idle.html": PAGE("idle article", Array.from({ length: 60 }, (_, i) => `<p>${words(i, 90)}.</p>`).join("\n")) });
  const idle = async (page, s) => {
    await readAll(page);
    // From here on: nothing happens on the page.
    const read = async () => Object.fromEntries((await s.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    await s.send("Profiler.stop").catch(() => {});
    await s.send("Profiler.start");
    const m0 = await read();
    await page.waitForTimeout(30_000);
    const m1 = await read();
    const { profile } = await s.send("Profiler.stop");
    await s.send("Profiler.start");
    const { attribute } = await import("../perf-kit.mjs");
    const cpu = attribute(profile);
    return { idle: { scriptMs: Math.round((m1.ScriptDuration - m0.ScriptDuration) * 1000), taskMs: Math.round((m1.TaskDuration - m0.TaskDuration) * 1000), layouts: m1.LayoutCount - m0.LayoutCount, styles: m1.RecalcStyleCount - m0.RecalcStyleCount, ext: cpu.ext, top: cpu.top.slice(0, 6) } };
  };
  await offline(context);
  const ext = await measure(context, pages.url("/idle.html"), { act: idle, throttle: THROTTLE });
  const c = await control();
  try {
    const ctl = await measure(c.ctx, pages.url("/idle.html"), { act: idle, throttle: THROTTLE });
    out("idle", { ext: ext.idle, ctl: ctl.idle });
  } finally { await c.close(); }
});

test("big DOM with little to read: a 20,000-row table and a 5,000-line listing", async ({ context, pages }) => {
  test.skip(!want("bigdom"));
  test.setTimeout(10 * 60_000);
  const rows = Array.from({ length: 20_000 }, (_, i) => `<tr><td>${i}</td><td>item ${i % 97}</td><td>${(i * 37) % 1000}.${i % 100}</td><td>${["ok", "late", "done"][i % 3]}</td><td>2026-0${1 + (i % 9)}-1${i % 10}</td></tr>`).join("");
  const code = Array.from({ length: 5000 }, (_, i) => `<div class="line"><span class="n">${i + 1}</span><span class="k">const</span> <span class="v">value${i}</span> = <span class="f">compute</span>(${i}, ${i % 7});</div>`).join("");
  pages.serve({
    "/table.html": PAGE("big table", `<p>${words(1, 90)}.</p><table>${rows}</table>`),
    "/code.html": PAGE("code listing", `<p>${words(2, 90)}.</p><pre><code>${code}</code></pre>`),
  });
  await pair("bigdom table", context, pages.url("/table.html"), readAll);
  await pair("bigdom code", context, pages.url("/code.html"), readAll);
});

test("pages that never stop changing: a chat and a ticker for 30 s", async ({ context, pages }) => {
  test.skip(!want("chatty"));
  test.setTimeout(10 * 60_000);
  const chat = `let n=0;const log=document.getElementById('log');setInterval(()=>{const d=document.createElement('div');d.className='msg';d.innerHTML='<b>user'+(n%17)+'</b> <span>'+${JSON.stringify(WORDS)}.slice(0,8+(n*7)%30).join(' ')+'</span>';log.append(d);if(log.children.length>200)log.firstElementChild.remove();n++;},300);`;
  const ticker = `const t=document.getElementById('t');setInterval(()=>{t.textContent='EUR/USD '+(1+Math.random()/10).toFixed(5)+' · '+new Date().toISOString();},100);`;
  pages.serve({
    "/chat.html": PAGE("chat", `<p>${words(3, 90)}.</p><div id="log"></div>`, chat),
    "/ticker.html": PAGE("ticker", `<div id="t"></div>${Array.from({ length: 20 }, (_, i) => `<p>${words(i + 50, 90)}.</p>`).join("")}`, ticker),
  });
  const run = async (page) => { await page.waitForTimeout(30_000); };
  await pair("chatty chat", context, pages.url("/chat.html"), run);
  await pair("chatty ticker", context, pages.url("/ticker.html"), run);
});

test("SPA: fifty route changes, what is kept", async ({ context, pages }) => {
  test.skip(!want("spa"));
  test.setTimeout(10 * 60_000);
  const spa = `window.__route=(k)=>{history.pushState({},'', '/spa/'+k);document.querySelector('main').innerHTML=Array.from({length:20},(_,i)=>'<p>Route '+k+' paragraph '+i+': '+${JSON.stringify(WORDS)}.map((w,j)=>${JSON.stringify(WORDS)}[(k*31+i*7+j*13)%${WORDS.length}]).join(' ')+' '+${JSON.stringify(WORDS)}.slice(0,30).join(' ')+'.</p>').join('');};`;
  pages.serve({ "/spa.html": PAGE("spa", `<main></main>`, `${spa}__route(0);`) });
  const run = async (page, s) => {
    await settle(page, { quiet: 2000, most: 10_000 });
    await s.send("HeapProfiler.enable");
    await s.send("HeapProfiler.collectGarbage");
    const h0 = (await s.send("Runtime.getHeapUsage")).usedSize;
    for (let k = 1; k <= 50; k++) { await page.evaluate((k) => window.__route(k), k); await page.waitForTimeout(300); }
    await settle(page, { quiet: 2000, most: 10_000 });
    for (let k = 51; k <= 55; k++) { await page.evaluate((k) => window.__route(k), k); await page.waitForTimeout(300); }
    await page.waitForTimeout(3000);
    await s.send("HeapProfiler.collectGarbage");
    const h1 = (await s.send("Runtime.getHeapUsage")).usedSize;
    return { heldMB: +((h1 - h0) / 1048576).toFixed(1) };
  };
  await offline(context);
  const ext = await measure(context, pages.url("/spa.html"), { act: run, throttle: THROTTLE });
  const c = await control();
  try {
    const ctl = await measure(c.ctx, pages.url("/spa.html"), { act: run, throttle: THROTTLE });
    out("spa", { ext: { heldMB: ext.heldMB, ...brief(ext) }, ctl: { heldMB: ctl.heldMB, ...brief(ctl) } });
  } finally { await c.close(); }
});

test("start-up: a page with nothing to read, and an article among a dozen ad and tracking frames", async ({ context, pages }) => {
  test.skip(!want("startup"));
  test.setTimeout(15 * 60_000);
  // Frames of the page's own origin, so their scripts run on the page's own thread and in its
  // metrics: an ad slot's few words under a picture, and pixels.
  const ads = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`/ad${i}.html`, PAGE(`ad ${i}`, `<a href="#ad"><div style="width:280px;height:200px;background:#c8d">Offer ${i}: save today</div></a>`)]));
  const frames = [...Array.from({ length: 8 }, (_, i) => `<iframe src="/ad${i}.html" width="300" height="250"></iframe>`), ...Array.from({ length: 4 }, () => `<iframe src="/pixel.html" width="1" height="1"></iframe>`)].join("");
  // The same frames from another site, each site's frames in a process of their own, as an
  // ad network's are: measured there (frameProcesses).
  const other = new URL(pages.url("/")).port;
  const elsewhere = frames.replace(/src="\//g, `src="http://127.0.0.1:${other}/`);
  pages.serve({
    ...ads,
    "/pixel.html": PAGE("pixel", ""),
    "/framed.html": PAGE("framed article", `${Array.from({ length: 12 }, (_, i) => `<p>${words(i + 70, 90)}.</p>`).join("")}${frames}`),
    "/xframed.html": PAGE("framed from elsewhere", `${Array.from({ length: 12 }, (_, i) => `<p>${words(i + 70, 90)}.</p>`).join("")}${elsewhere}`),
    "/blank.html": PAGE("nothing to read", `<canvas width="800" height="500"></canvas><button>Play</button>`),
  });
  /** What the frames from 127.0.0.1 cost in the process(es) they run in: read through each
   *  frame, once per process (frames sharing one read the same). */
  const frameProcesses = async (page) => {
    const seen = new Map();
    for (const f of page.frames()) {
      if (!f.url().startsWith("http://127.0.0.1")) continue;
      const s = await page.context().newCDPSession(f).catch(() => null);
      if (!s) continue;
      await s.send("Performance.enable");
      const m = Object.fromEntries((await s.send("Performance.getMetrics")).metrics.map((x) => [x.name, x.value]));
      seen.set(`${m.ScriptDuration}:${m.JSHeapUsedSize}`, { scriptMs: Math.round(m.ScriptDuration * 1000), taskMs: Math.round(m.TaskDuration * 1000), heapMB: Math.round(m.JSHeapUsedSize / 104857.6) / 10, listeners: m.JSEventListeners });
      await s.detach().catch(() => {});
    }
    return [...seen.values()];
  };
  /** When the first chip was drawn, in the page's own time. */
  const firstChip = async (page) => ({ firstChipMs: await page.evaluate(async (sel) => {
    for (let i = 0; i < 1500 && !document.querySelector(sel); i++) await new Promise((r) => setTimeout(r, 10));
    return document.querySelector(sel) ? Math.round(performance.now()) : null;
  }, BADGE_SEL) });
  const quiet = async (page) => { await page.waitForTimeout(3000); };
  const framed = async (page) => { const at = await firstChip(page); await settle(page, { quiet: 2000, most: 15_000 }); return at; };
  const xframed = async (page) => ({ ...(await framed(page)), frames: await frameProcesses(page) });
  for (let i = 0; i < Number(process.env.REPEAT ?? 3); i++) {
    await pair("startup blank", context, pages.url("/blank.html"), quiet);
    await pair("startup framed", context, pages.url("/framed.html"), framed);
    await pair("startup xframed", context, pages.url("/xframed.html"), xframed);
  }
});

test("the toolbar menu over a page of 400 read paragraphs", async ({ context, pages }) => {
  test.skip(!want("menu"));
  test.setTimeout(10 * 60_000);
  pages.serve({ "/many.html": PAGE("many", Array.from({ length: 400 }, (_, i) => `<p>${words(i + 900, 85)}.</p>`).join("\n")) });
  const page = await context.newPage();
  await page.goto(pages.url("/many.html"));
  await settle(page);
  for (let i = 0; i < 60; i++) { await page.evaluate(() => window.scrollBy(0, innerHeight)); await page.waitForTimeout(150); }
  await settle(page, { quiet: 3000, most: 60_000 });
  const times = [];
  for (let k = 0; k < 3; k++) {
    const began = Date.now();
    const menu = await popupOver(page);
    const report = await menuReport(menu);
    times.push(Date.now() - began);
    const lt = await menu.evaluate(() => performance.getEntriesByType("longtask").map((e) => Math.round(e.duration))).catch(() => []);
    out(`menu open ${k}`, { ms: Date.now() - began, read: report?.bands?.reduce((a, b) => a + b, 0), longTasks: lt });
    await menu.close();
  }
});

test("analyze text: 30,000 words", async ({ context, extension }) => {
  test.skip(!want("paste"));
  test.setTimeout(10 * 60_000);
  const text = Array.from({ length: 300 }, (_, i) => `${words(i + 3000, 100)}.`).join("\n\n");
  const r = await measure(context, extension.url("paste.html"), {
    throttle: THROTTLE,
    act: async (page) => {
      // As a paste does: the whole text at once, one input event (fill() types it line by line).
      await page.locator("#text").evaluate((el, text) => { el.value = text; el.dispatchEvent(new Event("input", { bubbles: true })); }, text);
      await page.evaluate(() => { window.__lt.length = 0; });
      const began = Date.now();
      await page.locator("#analyze").click();
      await page.locator("#results").waitFor({ state: "visible", timeout: 180_000 });
      await page.waitForFunction(() => !document.querySelector("#reading .pending"), null, { timeout: 180_000 }).catch(() => {});
      return { analyzeMs: Date.now() - began };
    },
  });
  out("paste 30k", { analyzeMs: r.analyzeMs, ...brief(r), ourLongFrames: r.ourLongFrames.slice(0, 5), top: r.cpu?.top.slice(0, 8) });
});

