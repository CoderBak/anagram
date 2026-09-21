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
// D) A page of clamped review cards — sixty of them, three paragraphs each behind a 150 px
//    clamp, their pictures arriving as the reader reaches them: the shape of a Steam or
//    Goodreads review page, and the one shape where a chip's place depends on measuring the
//    page. Budget: LAYOUTS, counted by the browser, against the same page with no extension.
//    Measuring one box and moving its chips, then measuring the next, made the page lay
//    itself out again between every pair — 443 layouts more than the control, one per chip
//    and one per observer tick — where reading every woken box first and writing to all of
//    them afterwards costs 229.
//
// E) The PDF reader on a thirty-page two-column paper: it shows the REAL pages, so what
//    it costs is its own shape — time to the first page drawn, time to every page's text
//    layer (they are all built up front, which is what makes the units and browser find
//    work over the whole document), the long tasks that building them costs, and the
//    canvases still holding a bitmap after a scroll to the end and back.
//
//   node test/perf.mjs
import { launchExtension, launchPlain, serveHtml, BADGE_SEL } from "./harness.mjs";
import { createNativeFixture } from "./fake-native.mjs";

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

const fixture = await createNativeFixture();
const server = await serveHtml({ "/perf.html": html });

const { context } = await launchExtension({ nativeFixture: fixture, viewport: { width: 1100, height: 850 } });
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
await fixture.close();

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

const fixtureB = await createNativeFixture();
const serverB = await serveHtml({ "/feed.html": FEED_HTML });
const { context: ctxB } = await launchExtension({ nativeFixture: fixtureB, viewport: { width: 1100, height: 850 } });
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
await fixtureB.close();

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

const fixtureC = await createNativeFixture();
const serverC = await serveHtml({ "/virt.html": feedHtml(WINDOW_POSTS) });
const { context: ctxC } = await launchExtension({ nativeFixture: fixtureC, viewport: { width: 1100, height: 850 } });
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
await fixtureC.close();

const heldMB = (heapAfter - heapBefore) / 1048576;
// Measured on this fixture: 0.8 MB of growth after 2000 posts have passed through, hosts
// exactly the posts in the DOM, no range over a node that has left it.
checks.push(
  [`virtualized feed: heap growth after ${CYCLES * WINDOW_POSTS} posts < 8MB`, heldMB < 8, `${heldMB.toFixed(1)}MB (${(heapBefore / 1048576).toFixed(1)} → ${(heapAfter / 1048576).toFixed(1)})`],
  ["virtualized feed: chips bounded by the posts in the DOM", held.hosts > 0 && held.hosts <= held.posts, `${held.hosts} chips for ${held.posts} posts`],
  ["virtualized feed: no highlight range over a node that left the DOM", held.detached === 0, `${held.detached} of ${held.ranges} ranges`],
);

// ---- D) clamped review cards: what does keeping one chip under each box cost? ----------
// Every paragraph of a clamped review ends out of sight, so the layer has to measure the
// box and the last line of each of its paragraphs to know which single chip belongs under
// it. The budget is the browser's own LayoutCount against the same page with no extension:
// a count, not a duration, so it says the same thing on a slow machine as on a fast one.
const CARDS = 60;
const CARD_PARAS = 3;
const SCREENS = 12;
/** At most this many layouts per chip over the control. One is the chip's own insertion,
 *  which any placement pays; the rest is the settling. Measured on this fixture: 1.27 with
 *  the boxes settled together, 2.46 when each box was settled on its own. */
const LAYOUTS_PER_CHIP = 1.6;

const cardWords = (seed, n) => {
  const VOCAB = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings a timetable moved off paper and nobody noticed until the trains ran on time".split(" ");
  return Array.from({ length: n }, (_, i) => VOCAB[(seed * 37 + i * 11) % VOCAB.length]).join(" ");
};
const CARDS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>clamped review cards</title>
<style>body{max-width:760px;margin:20px auto;font:15px/1.6 system-ui}
.card{border-top:1px solid #ddd;padding:12px 0}.lockup{font-size:13px;color:#666}
.clamp{max-height:150px;overflow:hidden}
img.shot{display:block;width:100%;height:0;background:#e8e8e8}
.more{font:inherit;border:0;background:none;color:#06c;padding:0}</style></head><body>
<main>${Array.from({ length: CARDS }, (_, i) =>
  `<article class="card"><div class="lockup">Reviewer ${i} · 1,204 hrs on record</div><div class="clamp"><img class="shot" alt="">` +
  Array.from({ length: CARD_PARAS }, (_, k) => `<p>Review ${i}.${k}: ${cardWords(i * 7 + k, 110)}.</p>`).join("") +
  `</div><button type="button" class="more">Read more</button></article>`).join("\n")}</main>
<script>
// The pictures arrive as the reader reaches them, the way a review page loads them: each
// one grows its own card, which is what moves a chip into or out of a clipped box.
const io = new IntersectionObserver((entries) => {
  for (const e of entries) {
    if (!e.isIntersecting) continue;
    io.unobserve(e.target);
    setTimeout(() => { e.target.style.height = "120px"; }, 250);
  }
}, { rootMargin: "300px" });
for (const img of document.querySelectorAll("img.shot")) io.observe(img);
</script></body></html>`;

/** One pass over the cards page, with the extension or without it, counting the browser's
 *  own layouts from before the page loads to the end of the scroll. */
async function cardsPass(withExt) {
  const fixtureD = withExt ? await createNativeFixture() : null;
  const serverD = await serveHtml({ "/cards.html": CARDS_HTML });
  let browser = null;
  let ctx;
  if (withExt) {
    ({ context: ctx } = await launchExtension({ nativeFixture: fixtureD, viewport: { width: 1100, height: 850 } }));
  } else {
    browser = await launchPlain({ headless: true });
    ctx = await browser.newContext({ viewport: { width: 1100, height: 850 } });
  }
  const p = await ctx.newPage();
  const session = await ctx.newCDPSession(p);
  await session.send("Performance.enable");
  const read = async () => Object.fromEntries((await session.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const m0 = await read();
  await p.goto(serverD.url("/cards.html"), { waitUntil: "load" });
  if (withExt) await p.waitForSelector(BADGE_SEL, { timeout: 20000 }).catch(() => {});
  await p.waitForTimeout(3000);
  for (let i = 0; i < SCREENS; i++) {
    await p.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9)));
    await p.waitForTimeout(400);
  }
  await p.waitForTimeout(2500);
  const m1 = await read();
  const seen = await p.evaluate((sel) => {
    const boxes = [...document.querySelectorAll(".clamp")];
    const under = (b) => {
      let n = 0;
      for (let el = b.nextElementSibling; el && el.matches(sel); el = el.nextElementSibling) n++;
      return n;
    };
    return {
      chips: [...document.querySelectorAll(sel)].filter((h) => h.id !== "anagram-fab").length,
      boxes: boxes.length,
      withOne: boxes.filter((b) => under(b) === 1).length,
      withMore: boxes.filter((b) => under(b) > 1).length,
    };
  }, BADGE_SEL);
  await ctx.close();
  await browser?.close();
  await serverD.close();
  await fixtureD?.close();
  return { layouts: m1.LayoutCount - m0.LayoutCount, ...seen };
}

const cardsExt = await cardsPass(true);
const cardsCtl = await cardsPass(false);
const extraLayouts = cardsExt.layouts - cardsCtl.layouts;
const budget = Math.round(cardsExt.chips * LAYOUTS_PER_CHIP);
checks.push(
  [
    `clamped cards: ${cardsExt.chips} chips in ${CARDS} boxes cost < ${budget} layouts over the control`,
    cardsExt.chips > 0 && extraLayouts < budget,
    `${extraLayouts} extra layouts (${cardsExt.layouts} vs ${cardsCtl.layouts}), ${(extraLayouts / Math.max(1, cardsExt.chips)).toFixed(2)} per chip`,
  ],
  [
    "clamped cards: exactly one chip under every box, never two",
    cardsExt.withOne === cardsExt.boxes && cardsExt.withMore === 0,
    `${cardsExt.withOne} of ${cardsExt.boxes} boxes with one chip under them, ${cardsExt.withMore} with more`,
  ],
);

// ---- E) the PDF reader: a thirty-page two-column paper --------------------------------
// Measure first rendered page/text, initial visible-page analysis, and retained canvases.
// Whole-document extraction is no longer performed at open; these numbers must not be
// interpreted as the time or coverage for analyzing all thirty pages.
const PDF_PAGES = 30;
// PDF.js 5.7.284 keeps max(10, 2 * visiblePages + 1) page views. At this fixed viewport
// fewer than five pages are visible, so its ten-view cache is the relevant bound.
const MAX_LIVE_CANVASES = 10;
{
  const { servePdfs, buildTwoColumnPdf, handOverPdf } = await import("./pdf-fixture.mjs");
  const fixtureE = await createNativeFixture();
  const pdfs = await servePdfs({ "/paper.pdf": buildTwoColumnPdf(PDF_PAGES) });
  const { context: ctxE } = await launchExtension({ nativeFixture: fixtureE, viewport: { width: 1200, height: 900 } });
  const reader = await ctxE.newPage();
  await reader.addInitScript(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration));
    }).observe({ entryTypes: ["longtask"] });
  });
  // Include the authorized source handoff in the time from the user's click.
  await reader.goto(pdfs.url("/paper.pdf"), { waitUntil: "load" }).catch(() => {});
  await reader
    .waitForFunction(() => !!document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".action"), null, { timeout: 30000 })
    .catch(() => {});
  const startedAt = Date.now();
  await handOverPdf(reader, { timeout: 30000 });
  await reader.waitForFunction(() => window.PDFViewerApplication?.pdfViewer.getPageView(0)?.renderingState === 3, null, { timeout: 30000 });
  const firstPageMs = Date.now() - startedAt;
  await reader.waitForSelector("#viewer .textLayer span", { timeout: 30000 });
  const firstTextMs = Date.now() - startedAt;
  const initialLayers = await reader.locator("#viewer .textLayer").count();
  // Wait for one real mapped analysis pass before sampling its cost.
  await reader.waitForFunction(() => performance.getEntriesByName("anagram-reflow").length > 0);
  const building = await reader.evaluate(() => Math.max(0, ...window.__longTasks));
  // These reflow samples cover only the initially rendered pages, before the sweep.
  const marks = await reader.evaluate(() => {
    const runs = performance.getEntriesByName("anagram-reflow").map((e) => e.duration);
    return {
      handoffMs: Math.round(performance.getEntriesByName("anagram-handoff")[0]?.duration ?? 0),
      reflowMs: Math.round(runs.reduce((a, b) => a + b, 0)),
      worstReflowMs: Math.round(Math.max(0, ...runs)),
    };
  });

  // To the end of the document and back — the canvases in between must not be kept.
  await reader.evaluate(async () => {
    const pages = [...document.querySelectorAll(".page")];
    for (const el of pages) {
      el.scrollIntoView();
      await new Promise((r) => setTimeout(r, 40));
    }
    for (const el of [...pages].reverse()) {
      el.scrollIntoView();
      await new Promise((r) => setTimeout(r, 40));
    }
  });
  await reader.waitForTimeout(1500);
  const held = await reader.evaluate(() => ({
    pages: document.querySelectorAll(".page").length,
    spans: document.querySelectorAll(".textLayer span").length,
    live: [...document.querySelectorAll(".page canvas")].filter((c) => c.width > 0 && c.height > 0).length,
  }));
  await ctxE.close();
  await pdfs.close();
  await fixtureE.close();

  checks.push(
    [`PDF reader: first page drawn < 6000ms (${PDF_PAGES} pages)`, firstPageMs < 6000, `${firstPageMs}ms`],
    ["PDF reader: first visible text layer present < 6000ms", firstTextMs < 6000, `${firstTextMs}ms`],
    ["PDF reader: opening does not build text layers for the entire document", initialLayers > 0 && initialLayers < PDF_PAGES, `${initialLayers} of ${PDF_PAGES} pages initially materialized`],
    ["PDF reader: worst long task during initial visible-page rendering < 1000ms", building < 1000, `${building}ms`],
    [
      `PDF reader: canvases bounded after scrolling to the end and back (<= ${MAX_LIVE_CANVASES})`,
      held.live > 0 && held.live <= MAX_LIVE_CANVASES,
      `${held.live} of ${held.pages} pages still hold a bitmap`,
    ],
    ["PDF reader: initial rendered-page reflow < 400ms", marks.reflowMs < 400, `${marks.reflowMs}ms total, worst run ${marks.worstReflowMs}ms`],
    ["PDF reader: each initial rendered-page reflow < 200ms", marks.worstReflowMs < 200, `${marks.worstReflowMs}ms`],
    ["PDF reader: the bytes cross the last hop < 500ms", marks.handoffMs < 500, `${marks.handoffMs}ms`],
  );
}

console.log(`page: ${N} paragraphs`);
for (const [name, ok, note] of checks) console.log(`${ok ? "PASS" : "FAIL"}  ${name}  —  ${note}`);
const pass = checks.every(([, ok]) => ok);
console.log(pass ? "✅ PERF BUDGET MET" : "❌ PERF BUDGET EXCEEDED");
process.exit(pass ? 0 : 1);
