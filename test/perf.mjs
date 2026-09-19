// test/perf.mjs — performance budgets on pathological pages.
//
// A) A STILL page of 3000 paragraphs (~55 words each, unique text) — an order of
//    magnitude beyond a long Wikipedia article. Budgets: first badge within 4s of load,
//    no single main-thread long task over 1s during startup, and the page must keep
//    scoring smoothly while scrolling. Run before/after walker changes.
//
// B) A page that does not hold still: 150 posts that re-render themselves eight times
//    over, touching every paragraph at once. That is what a live feed does to us (dev.to
//    re-renders its Preact islands continuously), and it is what the orchestrator's
//    scan-root bound exists for — without it 600 dirty nodes became 600 separate walks,
//    each paying a whole-document byline survey, and one burst took over a second of
//    main thread. Budgets: what the page is ALREADY doing bounds what we may add.
//
// C) The same page virtualized — 50 posts in, the oldest 50 out, forty times over — with
//    a forced GC at the end: what we still hold must stay proportional to what is in the
//    DOM, not to everything that ever passed through it.
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

// ---- B) a page that re-renders itself under the reader --------------------------------
// Every burst appends an EMPTY span to all 450 paragraphs: 450 dirty nodes, no text
// changed, so nothing is re-scored and what is measured is the SCAN alone.
const POSTS = 150;
const BURSTS = 8;
/** One feed page, built from a post generator so nothing ever copies the DOM (and with it
 *  our own chip hosts) to make a new post. `start` posts to begin with; `__rerender()` is
 *  an island re-render, `__cycle(n)` one turn of a virtualizer. */
const feedHtml = (start) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>feed under load</title>
<style>body{max-width:740px;margin:20px auto;font:15px/1.6 system-ui}.post{border-top:1px solid #ddd;padding:12px 0}
.row{display:flex;gap:8px;align-items:center;font-size:13px}img.avatar{width:22px;height:22px}</style></head><body>
<main id="feed"></main>
<script>
const VOCAB=${JSON.stringify("the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings a timetable moved off paper and nobody noticed until the trains ran on time".split(" "))};
const words=(seed,n)=>Array.from({length:n},(_,i)=>VOCAB[(seed*37+i*11)%VOCAB.length]).join(" ");
const feed=document.getElementById("feed");
let seq=0;
function post(){
  const i=seq++;
  const d=document.createElement("div");d.className="post";d.id="post-"+i;
  d.innerHTML='<div class="row"><a href="/user/u'+i+'"><img class="avatar" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>'+
    '<a href="/user/u'+i+'">Author '+i+'</a><time datetime="2026-09-11T10:00:00Z">3h ago</time></div>'+
    '<p class="body">Item '+i+': '+words(i,24)+'.</p><p class="body">Item '+(i+9000)+': '+words(i+9000,26)+'.</p>'+
    '<p class="body">Item '+(i+18000)+': '+words(i+18000,22)+'.</p>';
  feed.appendChild(d);
}
for(let i=0;i<${start};i++)post();
// One re-render: every paragraph in the page gains an empty element, the way a framework
// re-renders an island without changing a word of what it says.
window.__rerender=()=>{for(const p of document.querySelectorAll("#feed p.body"))p.appendChild(document.createElement("span"));};
// One turn of a virtualizer: a screenful in, the screenful that left the top out.
window.__cycle=(n)=>{for(let k=0;k<n;k++)post();while(feed.children.length>n)feed.firstElementChild.remove();};
</script></body></html>`;
const FEED_HTML = feedHtml(POSTS);

const daemonB = await startFakeDaemon();
const serverB = await serveHtml({ "/feed.html": FEED_HTML });
const { context: ctxB } = await launchExtension({ backendUrl: daemonB.url, viewport: { width: 1100, height: 850 } });
const feedPage = await ctxB.newPage();
await feedPage.addInitScript(() => {
  window.__longTasks = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration));
  }).observe({ entryTypes: ["longtask"] });
});
await feedPage.goto(serverB.url("/feed.html"), { waitUntil: "load" });
await feedPage.waitForSelector(BADGE_SEL, { timeout: 15000 });
await feedPage.waitForTimeout(2500); // let the first scan settle before measuring bursts
await feedPage.evaluate(() => { window.__longTasks.length = 0; });
for (let i = 0; i < BURSTS; i++) {
  await feedPage.evaluate(() => window.__rerender());
  await feedPage.waitForTimeout(1500); // past the observer's debounce and its max wait
}
const burst = await feedPage.evaluate(() => ({
  count: window.__longTasks.length,
  worst: Math.max(0, ...window.__longTasks),
  total: window.__longTasks.reduce((a, b) => a + b, 0),
}));
await ctxB.close();
await serverB.close();
await daemonB.close();

// Measured on this fixture: bounded, the eight bursts cost ~0.2 s of long tasks with the
// worst under 150 ms; one walk per dirty node cost 8 s with single bursts over 1 s.
checks.push(
  ["re-render burst: worst long task < 500ms", burst.worst < 500, `${burst.worst}ms`],
  [`re-render: ${BURSTS} bursts of ${POSTS * 3} dirty nodes cost < 3000ms of long tasks`, burst.total < 3000, `${burst.total}ms in ${burst.count} long tasks`],
);

// ---- C) a virtualized feed: what do we still hold when it has scrolled past? -----------
// 50 posts in, the oldest 50 out, forty times over — 2000 posts through a DOM that never
// holds more than 50. Everything we keep is keyed by a live unit (text nodes, badge hosts,
// highlight ranges, viewport observation), so after a forced GC the heap must be where it
// started and the live counts must match the DOM, not the history.
const CYCLES = 40;
const WINDOW_POSTS = 50;

const daemonC = await startFakeDaemon();
const serverC = await serveHtml({ "/virt.html": feedHtml(WINDOW_POSTS) });
const { context: ctxC } = await launchExtension({ backendUrl: daemonC.url, viewport: { width: 1100, height: 850 } });
const virtPage = await ctxC.newPage();
const cdp = await virtPage.context().newCDPSession(virtPage);
await cdp.send("HeapProfiler.enable");
await virtPage.goto(serverC.url("/virt.html"), { waitUntil: "load" });
await virtPage.waitForSelector(BADGE_SEL, { timeout: 15000 });
await virtPage.waitForTimeout(3000);
await cdp.send("HeapProfiler.collectGarbage");
const heapBefore = (await cdp.send("Runtime.getHeapUsage")).usedSize;
for (let c = 0; c < CYCLES; c++) {
  await virtPage.evaluate((n) => { window.__cycle(n); window.scrollTo(0, document.body.scrollHeight); }, WINDOW_POSTS);
  await virtPage.waitForTimeout(350);
}
await virtPage.waitForTimeout(3000);
await cdp.send("HeapProfiler.collectGarbage");
await virtPage.waitForTimeout(400);
await cdp.send("HeapProfiler.collectGarbage"); // a second pass frees what the first made unreachable
const heapAfter = (await cdp.send("Runtime.getHeapUsage")).usedSize;
const held = await virtPage.evaluate((sel) => {
  let ranges = 0;
  let detached = 0;
  if (typeof CSS !== "undefined" && CSS.highlights) {
    for (const [, hl] of CSS.highlights) {
      for (const r of hl) {
        ranges++;
        if (!r.startContainer.isConnected || !r.endContainer.isConnected) detached++;
      }
    }
  }
  return {
    posts: document.querySelectorAll("#feed .post").length,
    hosts: document.querySelectorAll(sel).length,
    ranges,
    detached,
  };
}, BADGE_SEL);
await ctxC.close();
await serverC.close();
await daemonC.close();

const heldMB = (heapAfter - heapBefore) / 1048576;
// Measured on this fixture: 0.8 MB of growth after 2000 posts have passed through, hosts
// exactly the posts in the DOM, no range over a node that has left it.
checks.push(
  [`virtualized feed: heap growth after ${CYCLES * WINDOW_POSTS} posts < 8MB`, heldMB < 8, `${heldMB.toFixed(1)}MB (${(heapBefore / 1048576).toFixed(1)} → ${(heapAfter / 1048576).toFixed(1)})`],
  ["virtualized feed: chips bounded by the posts in the DOM", held.hosts > 0 && held.hosts <= held.posts, `${held.hosts} chips for ${held.posts} posts`],
  ["virtualized feed: no highlight range over a node that left the DOM", held.detached === 0, `${held.detached} of ${held.ranges} ranges`],
);

console.log(`page: ${N} paragraphs`);
for (const [name, ok, note] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}  —  ${note}`);
const pass = checks.every(([, ok]) => ok);
console.log(pass ? "✅ PERF BUDGET MET" : "❌ PERF BUDGET EXCEEDED");
process.exit(pass ? 0 : 1);
