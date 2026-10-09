// Performance budgets on pathological pages. These measure time, so they run as their own
// project, one test at a time and after everything else (playwright.config.mjs):
//
//   npm run test:perf
//
// A) A STILL page of 3000 paragraphs (~80 words each, unique text) — an order of
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
//    it costs is its own shape — time to the first page drawn and to its text layer, that
//    opening builds the text layers of the pages drawn only (the whole document's text is
//    read from the document itself, lib/pdf/readAhead.ts), the long tasks that drawing them
//    costs, and the canvases still holding a bitmap after a scroll to the end and back.
//
// F) Long feed sessions (test/perf-feeds.mjs): an X-like timeline that virtualizes and a
//    Reddit-like feed that keeps every post, both ticking counters and times and changing
//    classes and styles as they are read, scrolled for ANAGRAM_FEED_SECONDS (120) at twice
//    reading speed. Budgets: the content script's share of the main thread over the
//    session, the share mutation handling takes in its LAST minute — the one the page is
//    longest in, where a cost that grows with the page shows — the worst long task, full
//    rescans, and the heap kept after a forced GC.
//
// G–J) What Anagram costs a page IN ALL, against the same page in a browser without it: the
//    main thread's whole time (the browser's TaskDuration — style, layout, paint and
//    compositing included, the work the extension's chips and marks cause the browser to do,
//    which the content script's own CPU above never shows), and the long tasks. G: the
//    Reddit-like feed, scrolled at twice reading speed — its chips fading in and the marks
//    Chromium validates again at every change of the page cost it 9–10.7% of its main
//    thread, where 6.3–7.5% is left with them gone and the marks off the screen out of the registry
//    (lib/render/highlight.ts). H: a table of twenty thousand rows, nothing to read in it —
//    the first walk held the page for a second in one task until it paused between blocks
//    (lib/dom/walker.ts collectUnitsInSlices). I: a chat adding a message every 300 ms. J: a
//    page read to the end and left open: nothing to do, nothing done.
//
// Every budget is a soft expectation, printed with what was measured, pass or fail.
import { test as base, expect } from "./fixtures.mjs";
import { launchPlain, BADGE_SEL } from "../harness.mjs";
import { buildTwoColumnPdf, handOverPdf, pdfTabChip } from "../pdf-fixture.mjs";
import { X_FEED, REDDIT_FEED, scrollSession } from "../perf-feeds.mjs";

const test = base.extend({
  /** A budget: printed with what was measured, and failed softly when it is exceeded. */
  budget: async ({}, use) => {
    await use((name, ok, note) => {
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}  —  ${note}`);
      expect.soft(ok, `${name} — ${note}`).toBe(true);
    });
  },
});
// No trace: it records the page as it goes, in the page's own time and memory.
// ANAGRAM_PERF_BUILD=<unpacked build> measures another build against the same budgets.
test.use({ launch: { viewport: { width: 1100, height: 850 } }, tracing: false, build: process.env.ANAGRAM_PERF_BUILD ?? "test" });

/** Collect the main thread's long tasks from before the page's own scripts run. */
const watchLongTasks = (page) =>
  page.addInitScript(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration));
    }).observe({ entryTypes: ["longtask"] });
  });

const VOCAB_A = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings".split(" ");
const VOCAB_B = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings a timetable moved off paper and nobody noticed until the trains ran on time".split(" ");

test("A) a still page of 3000 paragraphs: first badge, startup long tasks, scoring while scrolling", async ({ page, pages, budget }) => {
  const N = 3000;
  const words = (seed) => {
    const out = [];
    for (let i = 0; i < 80; i++) out.push(VOCAB_A[(seed * 31 + i * 7) % VOCAB_A.length]);
    return `Paragraph ${seed}: ` + out.join(" ") + ".";
  };
  let body = "";
  for (let i = 0; i < N; i++) body += `<p>${words(i)}</p>\n`;
  pages.serve({ "/perf.html": `<!doctype html><body style="max-width:720px;margin:30px auto;font:15px/1.6 system-ui">${body}</body>` });
  await watchLongTasks(page);

  const t0 = Date.now();
  await page.goto(pages.url("/perf.html"), { waitUntil: "domcontentloaded" });
  await page.waitForSelector(BADGE_SEL, { timeout: 15000 });
  const firstBadgeMs = Date.now() - t0;
  // scroll a few screens — scoring must keep up without freezing the page
  await page.evaluate(async () => {
    for (let i = 0; i < 10; i++) {
      scrollBy(0, innerHeight * 0.9);
      await new Promise((r) => setTimeout(r, 250));
    }
  });
  await page.waitForTimeout(2500);
  const stats = await page.evaluate((sel) => ({ badges: document.querySelectorAll(sel).length, longTasks: window.__longTasks, worst: Math.max(0, ...window.__longTasks) }), BADGE_SEL);

  budget("first badge < 4000ms", firstBadgeMs < 4000, `${firstBadgeMs}ms`);
  budget("worst main-thread long task < 1000ms", stats.worst < 1000, `${stats.worst}ms of ${stats.longTasks.length} long tasks`);
  budget("scroll keeps scoring (>= 60 badges after 10 screens)", stats.badges >= 60, `${stats.badges} badges`);
});

/** One feed page, built from a post generator so nothing ever copies the DOM (and with it
 *  our own chip hosts) to make a new post. `start` posts to begin with; `__rerender()` is
 *  an island re-render, `__cycle(n)` one turn of a virtualizer. */
const feedHtml = (start) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>feed under load</title>
<style>body{max-width:740px;margin:20px auto;font:15px/1.6 system-ui}.post{border-top:1px solid #ddd;padding:12px 0}
.row{display:flex;gap:8px;align-items:center;font-size:13px}img.avatar{width:22px;height:22px}</style></head><body>
<main id="feed"></main>
<script>
const VOCAB=${JSON.stringify(VOCAB_B)};
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

// Every burst appends an EMPTY span to all 450 paragraphs: 450 dirty nodes, no text
// changed, so nothing is re-scored and what is measured is the SCAN alone.
test("B) a page that re-renders itself under the reader: the long tasks of eight bursts", async ({ page, pages, budget }) => {
  const POSTS = 150;
  const BURSTS = 8;
  pages.serve({ "/feed.html": feedHtml(POSTS) });
  await watchLongTasks(page);
  await page.goto(pages.url("/feed.html"), { waitUntil: "load" });
  await page.waitForSelector(BADGE_SEL, { timeout: 15000 });
  await page.waitForTimeout(2500); // let the first scan settle before measuring bursts
  await page.evaluate(() => { window.__longTasks.length = 0; });
  for (let i = 0; i < BURSTS; i++) {
    await page.evaluate(() => window.__rerender());
    await page.waitForTimeout(1500); // past the observer's debounce and its max wait
  }
  const burst = await page.evaluate(() => ({ count: window.__longTasks.length, worst: Math.max(0, ...window.__longTasks), total: window.__longTasks.reduce((a, b) => a + b, 0) }));
  // Measured on this fixture: bounded, the eight bursts cost ~0.2 s of long tasks with the
  // worst under 150 ms; one walk per dirty node cost 8 s with single bursts over 1 s.
  budget("re-render burst: worst long task < 500ms", burst.worst < 500, `${burst.worst}ms`);
  budget(`re-render: ${BURSTS} bursts of ${POSTS * 3} dirty nodes cost < 3000ms of long tasks`, burst.total < 3000, `${burst.total}ms in ${burst.count} long tasks`);
});

// 50 posts in, the oldest 50 out, forty times over — 2000 posts through a DOM that never
// holds more than 50. Everything we keep is keyed by a live unit (text nodes, badge hosts,
// highlight ranges, viewport observation), so after a forced GC the heap must be where it
// started and the live counts must match the DOM, not the history.
test("C) a virtualized feed: what we still hold once it has scrolled past", async ({ page, pages, budget }) => {
  const CYCLES = 40;
  const WINDOW_POSTS = 50;
  pages.serve({ "/virt.html": feedHtml(WINDOW_POSTS) });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("HeapProfiler.enable");
  await page.goto(pages.url("/virt.html"), { waitUntil: "load" });
  await page.waitForSelector(BADGE_SEL, { timeout: 15000 });
  await page.waitForTimeout(3000);
  await cdp.send("HeapProfiler.collectGarbage");
  const heapBefore = (await cdp.send("Runtime.getHeapUsage")).usedSize;
  for (let c = 0; c < CYCLES; c++) {
    await page.evaluate((n) => { window.__cycle(n); window.scrollTo(0, document.body.scrollHeight); }, WINDOW_POSTS);
    await page.waitForTimeout(350);
  }
  await page.waitForTimeout(3000);
  await cdp.send("HeapProfiler.collectGarbage");
  await page.waitForTimeout(400);
  await cdp.send("HeapProfiler.collectGarbage"); // a second pass frees what the first made unreachable
  const heapAfter = (await cdp.send("Runtime.getHeapUsage")).usedSize;
  const held = await page.evaluate((sel) => {
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
    return { posts: document.querySelectorAll("#feed .post").length, hosts: document.querySelectorAll(sel).length, ranges, detached };
  }, BADGE_SEL);
  const heldMB = (heapAfter - heapBefore) / 1048576;
  // Measured on this fixture: 0.8 MB of growth after 2000 posts have passed through, hosts
  // exactly the posts in the DOM, no range over a node that has left it.
  budget(`virtualized feed: heap growth after ${CYCLES * WINDOW_POSTS} posts < 8MB`, heldMB < 8, `${heldMB.toFixed(1)}MB (${(heapBefore / 1048576).toFixed(1)} → ${(heapAfter / 1048576).toFixed(1)})`);
  budget("virtualized feed: chips bounded by the posts in the DOM", held.hosts > 0 && held.hosts <= held.posts, `${held.hosts} chips for ${held.posts} posts`);
  budget("virtualized feed: no highlight range over a node that left the DOM", held.detached === 0, `${held.detached} of ${held.ranges} ranges`);
});

// Every paragraph of a clamped review ends out of sight, so the layer has to measure the
// box and the last line of each of its paragraphs to know which single chip belongs under
// it. The budget is the browser's own LayoutCount against the same page with no extension:
// a count, not a duration, so it says the same thing on a slow machine as on a fast one.
test("D) clamped review cards: the layouts one chip under each box costs, against no extension", async ({ context, pages, budget }) => {
  const CARDS = 60;
  const CARD_PARAS = 3;
  const SCREENS = 12;
  /** At most this many layouts per chip over the control. One is the chip's own insertion,
   *  which any placement pays; the rest is the settling. Measured on this fixture: 1.27 with
   *  the boxes settled together, 2.46 when each box was settled on its own. */
  const LAYOUTS_PER_CHIP = 1.6;
  const cardWords = (seed, n) => Array.from({ length: n }, (_, i) => VOCAB_B[(seed * 37 + i * 11) % VOCAB_B.length]).join(" ");
  pages.serve({
    "/cards.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>clamped review cards</title>
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
</script></body></html>`,
  });

  /** One pass over the cards page, counting the browser's own layouts from before the page
   *  loads to the end of the scroll. */
  async function cardsPass(ctx, withExt) {
    const p = await ctx.newPage();
    const session = await ctx.newCDPSession(p);
    await session.send("Performance.enable");
    const read = async () => Object.fromEntries((await session.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
    const m0 = await read();
    await p.goto(pages.url("/cards.html"), { waitUntil: "load" });
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
        chips: document.querySelectorAll(sel).length,
        boxes: boxes.length,
        withOne: boxes.filter((b) => under(b) === 1).length,
        withMore: boxes.filter((b) => under(b) > 1).length,
      };
    }, BADGE_SEL);
    await p.close();
    return { layouts: m1.LayoutCount - m0.LayoutCount, ...seen };
  }

  const cardsExt = await cardsPass(context, true);
  const browser = await launchPlain({ headless: true });
  let cardsCtl;
  try {
    cardsCtl = await cardsPass(await browser.newContext({ viewport: { width: 1100, height: 850 } }), false);
  } finally {
    await browser.close();
  }
  const extraLayouts = cardsExt.layouts - cardsCtl.layouts;
  const allowed = Math.round(cardsExt.chips * LAYOUTS_PER_CHIP);
  budget(
    `clamped cards: ${cardsExt.chips} chips in ${CARDS} boxes cost < ${allowed} layouts over the control`,
    cardsExt.chips > 0 && extraLayouts < allowed,
    `${extraLayouts} extra layouts (${cardsExt.layouts} vs ${cardsCtl.layouts}), ${(extraLayouts / Math.max(1, cardsExt.chips)).toFixed(2)} per chip`,
  );
  budget(
    "clamped cards: exactly one chip under every box, never two",
    cardsExt.withOne === cardsExt.boxes && cardsExt.withMore === 0,
    `${cardsExt.withOne} of ${cardsExt.boxes} boxes with one chip under them, ${cardsExt.withMore} with more`,
  );
});

// Measure first rendered page/text, initial visible-page analysis, and retained canvases.
// Whole-document extraction is no longer performed at open; these numbers must not be
// interpreted as the time or coverage for analyzing all thirty pages.
test.describe("E) the PDF reader", () => {
  test.use({ launch: { viewport: { width: 1200, height: 900 } } });

  test("a thirty-page two-column paper: first page, first text, long tasks, reflow, retained canvases", async ({ page, pages, budget }) => {
    const PDF_PAGES = 30;
    // PDF.js 5.7.284 keeps max(10, 2 * visiblePages + 1) page views. At this fixed viewport
    // fewer than five pages are visible, so its ten-view cache is the relevant bound.
    const MAX_LIVE_CANVASES = 10;
    pages.serve({ "/paper.pdf": buildTwoColumnPdf(PDF_PAGES) });
    await watchLongTasks(page);
    // Include the authorized source handoff in the time from the user's click.
    await page.goto(pages.url("/paper.pdf"), { waitUntil: "load" }).catch(() => {});
    await pdfTabChip(page, { timeout: 30000 }); // the page has told the worker it shows a PDF
    const startedAt = Date.now();
    await handOverPdf(page, { timeout: 30000 });
    await page.waitForFunction(() => window.PDFViewerApplication?.pdfViewer.getPageView(0)?.renderingState === 3, null, { timeout: 30000 });
    const firstPageMs = Date.now() - startedAt;
    await page.waitForSelector("#viewer .textLayer span", { timeout: 30000 });
    const firstTextMs = Date.now() - startedAt;
    const initialLayers = await page.locator("#viewer .textLayer").count();
    // Wait for one real mapped analysis pass before sampling its cost.
    await page.waitForFunction(() => performance.getEntriesByName("anagram-reflow").length > 0);
    const building = await page.evaluate(() => Math.max(0, ...window.__longTasks));
    // These reflow samples cover only the initially rendered pages, before the sweep.
    const marks = await page.evaluate(() => {
      const runs = performance.getEntriesByName("anagram-reflow").map((e) => e.duration);
      return {
        handoffMs: Math.round(performance.getEntriesByName("anagram-handoff")[0]?.duration ?? 0),
        reflowMs: Math.round(runs.reduce((a, b) => a + b, 0)),
        worstReflowMs: Math.round(Math.max(0, ...runs)),
      };
    });
    // To the end of the document and back — the canvases in between must not be kept.
    await page.evaluate(async () => {
      const all = [...document.querySelectorAll(".page")];
      for (const el of all) {
        el.scrollIntoView();
        await new Promise((r) => setTimeout(r, 40));
      }
      for (const el of [...all].reverse()) {
        el.scrollIntoView();
        await new Promise((r) => setTimeout(r, 40));
      }
    });
    await page.waitForTimeout(1500);
    const held = await page.evaluate(() => ({
      pages: document.querySelectorAll(".page").length,
      spans: document.querySelectorAll(".textLayer span").length,
      live: [...document.querySelectorAll(".page canvas")].filter((c) => c.width > 0 && c.height > 0).length,
    }));

    budget(`PDF reader: first page drawn < 6000ms (${PDF_PAGES} pages)`, firstPageMs < 6000, `${firstPageMs}ms`);
    budget("PDF reader: first visible text layer present < 6000ms", firstTextMs < 6000, `${firstTextMs}ms`);
    budget("PDF reader: opening does not build text layers for the entire document", initialLayers > 0 && initialLayers < PDF_PAGES, `${initialLayers} of ${PDF_PAGES} pages initially materialized`);
    budget("PDF reader: worst long task during initial visible-page rendering < 1000ms", building < 1000, `${building}ms`);
    budget(`PDF reader: canvases bounded after scrolling to the end and back (<= ${MAX_LIVE_CANVASES})`, held.live > 0 && held.live <= MAX_LIVE_CANVASES, `${held.live} of ${held.pages} pages still hold a bitmap`);
    budget("PDF reader: initial rendered-page reflow < 400ms", marks.reflowMs < 400, `${marks.reflowMs}ms total, worst run ${marks.worstReflowMs}ms`);
    budget("PDF reader: each initial rendered-page reflow < 200ms", marks.worstReflowMs < 200, `${marks.worstReflowMs}ms`);
    budget("PDF reader: the bytes cross the last hop < 500ms", marks.handoffMs < 500, `${marks.handoffMs}ms`);
  });
});

const FEED_SECONDS = Number(process.env.ANAGRAM_FEED_SECONDS ?? 120);
const FEEDS = [
  // Virtualized: what it holds must not grow with what it has shown.
  { name: "X-like", html: X_FEED, heap: (kept) => [`heap kept after GC < 8MB`, kept.mb < 8] },
  // Every post stays: what it holds may grow with the posts, by little per post once warm.
  { name: "Reddit-like", html: REDDIT_FEED, heap: (kept) => [`heap kept after GC in the second half < 8KB per post rendered`, kept.laterPerPost < 8] },
];

for (const feed of FEEDS) {
  test(`F) ${FEED_SECONDS} s on a ${feed.name} feed: content-script CPU, mutation handling, long tasks, rescans, memory`, async ({ page, pages, storage, budget }) => {
    test.setTimeout((FEED_SECONDS + 120) * 1000);
    // The orchestrator's "dirty scan" line is how drains are counted and timed.
    await storage.set({ debug: true });
    pages.serve({ "/feed.html": feed.html });
    await watchLongTasks(page);
    const cdp = await page.context().newCDPSession(page);
    const drains = [];
    let rescans = 0;
    await cdp.send("Runtime.enable");
    cdp.on("Runtime.consoleAPICalled", (e) => {
      const args = e.args.map((a) => a.value ?? a.description ?? "");
      if (!String(args[0]).startsWith("[anagram:")) return;
      if (args[1] === "rescan") rescans++;
      if (args[1] !== "dirty scan:") return;
      const v = {};
      for (let i = 2; i + 1 < args.length; i += 2) v[String(args[i + 1]).replace(/,$/, "")] = Number(args[i]);
      drains.push({ at: Date.now(), ms: v.ms, roots: v.roots });
    });
    await cdp.send("HeapProfiler.enable");
    const heap = async () => {
      await cdp.send("HeapProfiler.collectGarbage");
      await cdp.send("HeapProfiler.collectGarbage");
      return (await cdp.send("Runtime.getHeapUsage")).usedSize / 1048576;
    };
    const reading = async () => ({ mb: await heap(), posts: await page.evaluate(() => window.__feed.posts()) });

    await page.goto(pages.url("/feed.html"), { waitUntil: "load" });
    await page.waitForSelector(BADGE_SEL, { timeout: 20000 });
    await page.waitForTimeout(2000);
    const start = await reading();
    await page.evaluate(() => { window.__longTasks.length = 0; });
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    const began = Date.now();
    let middle = null;
    await scrollSession(page, FEED_SECONDS, {
      pace: 2,
      onTick: async (t) => {
        if (!middle && t >= (FEED_SECONDS * 1000) / 2) middle = await reading();
      },
    });
    const ended = Date.now();
    const { profile } = await cdp.send("Profiler.stop");
    await page.waitForTimeout(2000);
    const end = await reading();
    const state = await page.evaluate((sel) => ({ chips: document.querySelectorAll(sel).length, longTasks: window.__longTasks }), BADGE_SEL);

    // The content script's own time: the profile's samples in frames of the extension.
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    let scriptMs = 0;
    for (let i = 0; i < profile.samples.length; i++) {
      if (byId.get(profile.samples[i]).callFrame.url.startsWith("chrome-extension://")) scriptMs += (profile.timeDeltas[i + 1] ?? 0) / 1000;
    }
    const sessionMs = ended - began;
    const lastMinute = drains.filter((d) => d.at > ended - 60_000);
    const lastMinuteMs = lastMinute.reduce((sum, d) => sum + d.ms, 0);
    const perPost = (from) => ((end.mb - from.mb) * 1024) / Math.max(1, end.posts - from.posts);
    const kept = { mb: end.mb - start.mb, perPost: perPost(start), laterPerPost: perPost(middle ?? start) };
    const worst = Math.max(0, ...state.longTasks);
    const [heapName, heapOk] = feed.heap(kept);

    budget(`${feed.name}: the content script takes < 5% of the main thread`, scriptMs / sessionMs < 0.05, `${Math.round(scriptMs)}ms of ${Math.round(sessionMs / 1000)}s (${((100 * scriptMs) / sessionMs).toFixed(1)}%), ${end.posts} posts, ${state.chips} chips`);
    budget(`${feed.name}: mutation handling takes < 6% of the last minute`, lastMinuteMs / 60_000 < 0.06, `${Math.round(lastMinuteMs)}ms in ${lastMinute.length} drains (${((100 * lastMinuteMs) / 60_000).toFixed(1)}%); ${drains.length} drains, ${drains.filter((d) => d.roots > 0).length} of them walks, worst ${Math.max(0, ...drains.map((d) => d.ms))}ms`);
    budget(`${feed.name}: worst long task < 500ms`, worst < 500, `${worst}ms of ${state.longTasks.length} long tasks`);
    budget(`${feed.name}: no full rescan`, rescans === 0, `${rescans} rescans`);
    budget(`${feed.name}: ${heapName}`, heapOk, `${kept.mb.toFixed(2)}MB (${start.mb.toFixed(1)} → ${middle?.mb.toFixed(1)} → ${end.mb.toFixed(1)}) over ${end.posts - start.posts} posts, ${kept.perPost.toFixed(1)}KB each, ${kept.laterPerPost.toFixed(1)}KB each in the second half`);
    expect(state.chips, "the session was read at all").toBeGreaterThan(0);
  });
}

// ---- G–J: the page's whole cost, against no extension ----------------------------------------

/** Long tasks from before the page's own scripts run, and a way to read the browser's own
 *  main-thread totals. */
async function costOf(ctx, url, act) {
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    window.__longTasks = [];
    new PerformanceObserver((list) => { for (const e of list.getEntries()) window.__longTasks.push(Math.round(e.duration)); }).observe({ type: "longtask", buffered: true });
  });
  const session = await ctx.newCDPSession(page);
  await session.send("Performance.enable");
  const read = async () => Object.fromEntries((await session.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]));
  const before = await read();
  await page.goto(url, { waitUntil: "load" });
  await act(page, read);
  const after = await read();
  const longTasks = await page.evaluate(() => window.__longTasks);
  await page.close();
  return { taskMs: Math.round((after.TaskDuration - before.TaskDuration) * 1000), scriptMs: Math.round((after.ScriptDuration - before.ScriptDuration) * 1000), worst: Math.max(0, ...longTasks) };
}

/** The same scenario with Anagram and in a plain browser. */
async function againstNone(context, url, act) {
  const ext = await costOf(context, url, act);
  const browser = await launchPlain({ headless: true });
  try {
    const ctl = await costOf(await browser.newContext({ viewport: { width: 1100, height: 850 } }), url, act);
    return { ext, ctl };
  } finally {
    await browser.close();
  }
}

const settled = async (page) => { await page.waitForSelector(BADGE_SEL, { timeout: 20000 }).catch(() => {}); await page.waitForTimeout(2500); };

test("G) a Reddit-like feed for 60 s: the main thread's whole time over a plain browser's", async ({ context, pages, budget }) => {
  test.setTimeout(6 * 60_000);
  pages.serve({ "/feed.html": REDDIT_FEED });
  const { ext, ctl } = await againstNone(context, pages.url("/feed.html"), async (page) => {
    await page.waitForTimeout(2500);
    await scrollSession(page, 60, { pace: 2 });
  });
  const share = (ext.taskMs - ctl.taskMs) / 60_000;
  // 6.3–7.5% over three runs (2026-10-04, M4); 9–10.7% before the chips stopped fading in and
  // the marks off the screen left the registry.
  budget("Reddit-like feed: Anagram adds < 8% to the main thread, the browser's own work included", share < 0.08, `${ext.taskMs - ctl.taskMs}ms in 60 s (${(100 * share).toFixed(1)}%): ${ext.taskMs}ms against ${ctl.taskMs}ms`);
});

test("H) a table of 20,000 rows: no long task of Anagram's past the page's own", async ({ context, pages, budget }) => {
  test.setTimeout(4 * 60_000);
  const rows = Array.from({ length: 20_000 }, (_, i) => `<tr><td>${i}</td><td>item ${i % 97}</td><td>${(i * 37) % 1000}.${i % 100}</td><td>${["ok", "late", "done"][i % 3]}</td><td>2026-0${1 + (i % 9)}-1${i % 10}</td></tr>`).join("");
  pages.serve({ "/table.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>big table</title></head><body><p>${VOCAB_B.slice(0, 90).join(" ")}.</p><table>${rows}</table></body></html>` });
  const { ext, ctl } = await againstNone(context, pages.url("/table.html"), async (page) => { await page.waitForTimeout(8000); });
  budget("20,000-row table: the worst long task with Anagram < the page's own + 50ms", ext.worst < Math.max(ctl.worst, 50) + 50, `${ext.worst}ms against ${ctl.worst}ms`);
});

test("I) a chat adding a message every 300 ms for 30 s: the main thread's whole time over a plain browser's", async ({ context, pages, budget }) => {
  test.setTimeout(4 * 60_000);
  const chat = `let n=0;const log=document.getElementById('log');setInterval(()=>{const d=document.createElement('div');d.innerHTML='<b>user'+(n%17)+'</b> <span>'+${JSON.stringify(VOCAB_B)}.slice(0,8+(n*7)%30).join(' ')+'</span>';log.append(d);if(log.children.length>200)log.firstElementChild.remove();n++;},300);`;
  pages.serve({ "/chat.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>chat</title></head><body><p>${VOCAB_B.join(" ")} ${VOCAB_A.join(" ")}.</p><div id="log"></div><script>${chat}</script></body></html>` });
  const { ext, ctl } = await againstNone(context, pages.url("/chat.html"), async (page) => { await page.waitForTimeout(30_000); });
  const share = (ext.taskMs - ctl.taskMs) / 30_000;
  budget("chat: Anagram adds < 7% to the main thread, the browser's own work included", share < 0.07, `${ext.taskMs - ctl.taskMs}ms in 30 s (${(100 * share).toFixed(1)}%): ${ext.taskMs}ms against ${ctl.taskMs}ms`);
  budget("chat: no long task", ext.worst < 50, `${ext.worst}ms`);
});

test("J) a page read to the end and left open for 30 s: nothing done", async ({ context, pages, budget }) => {
  test.setTimeout(3 * 60_000);
  pages.serve({ "/idle.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>idle</title></head><body>${Array.from({ length: 40 }, (_, i) => `<p>${Array.from({ length: 90 }, (_, k) => VOCAB_B[(i * 31 + k * 7) % VOCAB_B.length]).join(" ")}.</p>`).join("")}</body></html>` });
  let idle = null;
  await costOf(context, pages.url("/idle.html"), async (page, read) => {
    await settled(page);
    for (let i = 0; i < 12; i++) { await page.evaluate(() => window.scrollBy(0, innerHeight)); await page.waitForTimeout(300); }
    await page.waitForTimeout(4000);
    const a = await read();
    await page.waitForTimeout(30_000);
    const b = await read();
    idle = { scriptMs: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000), layouts: b.LayoutCount - a.LayoutCount };
  });
  budget("idle page: < 20ms of script and no layout in 30 s", idle.scriptMs < 20 && idle.layouts === 0, `${idle.scriptMs}ms of script, ${idle.layouts} layouts`);
});
