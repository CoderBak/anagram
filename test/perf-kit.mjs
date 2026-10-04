// test/perf-kit.mjs — what the extension costs a page, attributed (test/pw/perf-matrix.spec.mjs).
//
// One scenario in one browser context: the browser's own main-thread totals before and after
// (CDP Performance.getMetrics: script, layout, style, the whole task time), the long tasks and
// long animation frames the page saw, and a CPU profile whose samples are split by who ran —
// the extension's scripts (any frame of theirs on the stack), the page's, the garbage
// collector, the engine's own work. SAVE_PROFILE=<prefix> keeps each profile, with the long
// tasks and a mark in the profile to map them by (a busy function the page names), for
// attributing one long task to the code that ran in it.
import { BADGE_SEL } from "./harness.mjs";

const INIT = () => {
  window.__lt = [];
  window.__loaf = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: "longtask", buffered: true });
  } catch {}
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) {
        if (e.duration < 50) continue;
        window.__loaf.push({ start: Math.round(e.startTime), duration: Math.round(e.duration), blocking: Math.round(e.blockingDuration),
          scripts: e.scripts.map((s) => ({ url: s.sourceURL, fn: s.sourceFunctionName, invoker: s.invoker, duration: Math.round(s.duration), layout: Math.round(s.forcedStyleAndLayoutDuration) })) });
      }
    }).observe({ type: "long-animation-frame", buffered: true });
  } catch {}
};

let saved = 0;
const METRICS = ["ScriptDuration", "TaskDuration", "LayoutDuration", "RecalcStyleDuration", "LayoutCount", "RecalcStyleCount", "JSHeapUsedSize", "Nodes", "JSEventListeners"];

/** Samples of a CPU profile by who ran: the extension's scripts (any frame of theirs on the
 *  stack), the page's, the garbage collector, the engine's own work, idle. */
export function attribute(profile) {
  const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map();
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
  const ours = new Map(), cache = new Map();
  const whose = (id) => {
    if (cache.has(id)) return cache.get(id);
    let out = null;
    for (let x = id; x !== undefined; x = parent.get(x)) {
      const f = nodes.get(x).callFrame;
      if (f.url.startsWith("chrome-extension://")) { out = x; break; }
    }
    cache.set(id, out);
    return out;
  };
  const totals = { ext: 0, page: 0, gc: 0, program: 0, idle: 0 };
  const extTop = new Map();
  for (let i = 0; i < profile.samples.length; i++) {
    const id = profile.samples[i], dt = (profile.timeDeltas[i + 1] ?? profile.timeDeltas[i]) / 1000;
    const leaf = nodes.get(id).callFrame;
    const mine = whose(id);
    if (mine !== null) {
      totals.ext += dt;
      // The extension frame nearest the leaf, by function and file.
      const f = nodes.get(mine).callFrame;
      const lf = leaf.url.startsWith("chrome-extension://") ? leaf : f;
      const key = `${lf.functionName || "(anon)"} ${lf.url.split("/").pop()}:${lf.lineNumber}:${lf.columnNumber}`;
      extTop.set(key, (extTop.get(key) ?? 0) + dt);
    } else if (leaf.functionName === "(garbage collector)") totals.gc += dt;
    else if (leaf.functionName === "(idle)") totals.idle += dt;
    else if (leaf.functionName === "(program)") totals.program += dt;
    else totals.page += dt;
  }
  for (const k of Object.keys(totals)) totals[k] = Math.round(totals[k]);
  return { ...totals, top: [...extTop].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => `${Math.round(v)}ms ${k}`) };
}

/** Open `url` in `ctx`, run `act(page)`, and say what it cost. */
export async function measure(ctx, url, { act = async () => {}, throttle = 1, profile = true, before = async () => {} } = {}) {
  const page = await ctx.newPage();
  await page.addInitScript(INIT);
  const s = await ctx.newCDPSession(page);
  await s.send("Performance.enable");
  if (throttle > 1) await s.send("Emulation.setCPUThrottlingRate", { rate: throttle });
  if (profile) {
    await s.send("Profiler.enable");
    await s.send("Profiler.setSamplingInterval", { interval: 500 });
  }
  await before(page);
  const read = async () => Object.fromEntries((await s.send("Performance.getMetrics")).metrics.filter((m) => METRICS.includes(m.name)).map((m) => [m.name, m.value]));
  const m0 = await read();
  if (profile) await s.send("Profiler.start");
  const began = Date.now();
  if (url) await page.goto(url, { waitUntil: "load", timeout: 60_000 });
  // The profiler's clock against the page's: one reading of each, side by side.
  // A mark in the profile: a busy function of a name nothing else has, whose start the page says.
  const clock = async () => ({ epoch: await page.evaluate(() => { const anagramProfileMark = () => { const t = performance.now(); while (performance.now() - t < 30) {} return performance.timeOrigin + t; }; return anagramProfileMark(); }) });
  const sync = url ? await clock() : null;
  const extra = await act(page, s);
  const wall = Date.now() - began;
  const prof = profile ? (await s.send("Profiler.stop")).profile : null;
  if (prof && process.env.SAVE_PROFILE) {
    const lt = await page.evaluate(() => (window.__lt ?? []).map(([start, d]) => [performance.timeOrigin + start, d])).catch(() => []);
    (await import("node:fs")).writeFileSync(`${process.env.SAVE_PROFILE}.${saved++}.json`, JSON.stringify({ ...prof, sync, lt }));
  }
  const m1 = await read();
  const seen = await page.evaluate((sel) => ({ lt: window.__lt ?? [], loaf: window.__loaf ?? [], chips: document.querySelectorAll(sel).length }), BADGE_SEL).catch(() => ({ lt: [], loaf: [], chips: 0 }));
  const d = {};
  for (const k of METRICS) d[k] = /Duration$/.test(k) ? Math.round((m1[k] - m0[k]) * 1000) : k === "JSHeapUsedSize" ? Math.round(m1[k] / 1048576) : m1[k] - (k.endsWith("Count") ? m0[k] : 0);
  const ourFrames = seen.loaf.filter((f) => f.scripts.some((x) => x.url.startsWith("chrome-extension://")));
  return {
    page, session: s, wall, metrics: d, chips: seen.chips,
    longTasks: { n: seen.lt.length, max: Math.max(0, ...seen.lt.map((t) => t[1])), total: seen.lt.reduce((a, t) => a + t[1], 0) },
    ourLongFrames: ourFrames.map((f) => ({ start: f.start, duration: f.duration, scripts: f.scripts.filter((x) => x.url.startsWith("chrome-extension://")).map((x) => `${x.fn || x.invoker} ${x.duration}ms (layout ${x.layout})`) })),
    cpu: prof ? attribute(prof) : null,
    ...(extra ?? {}),
  };
}

/** Wait until no chip has appeared for `quiet` ms (or `most` ms have passed). */
export async function settle(page, { quiet = 2000, most = 20_000 } = {}) {
  const began = Date.now();
  let last = -1, since = Date.now();
  while (Date.now() - began < most) {
    const n = await page.evaluate((sel) => document.querySelectorAll(`${sel}`).length, BADGE_SEL).catch(() => 0);
    if (n !== last) { last = n; since = Date.now(); }
    if (Date.now() - since >= quiet) break;
    await page.waitForTimeout(250);
  }
}

export async function scrollThrough(page, screens = 10, pause = 400) {
  for (let i = 0; i < screens; i++) {
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9)));
    await page.waitForTimeout(pause);
  }
}

export const brief = (r) => ({ wall: r.wall, chips: r.chips, cpu: r.cpu && { ext: r.cpu.ext, page: r.cpu.page, gc: r.cpu.gc, program: r.cpu.program }, script: r.metrics.ScriptDuration, task: r.metrics.TaskDuration, layout: r.metrics.LayoutDuration, style: r.metrics.RecalcStyleDuration, layouts: r.metrics.LayoutCount, styles: r.metrics.RecalcStyleCount, heapMB: r.metrics.JSHeapUsedSize, nodes: r.metrics.Nodes, listeners: r.metrics.JSEventListeners, longTasks: r.longTasks, ourLongFrames: r.ourLongFrames.length });
