// A page's life under the reader: it rewrites its own document, the browser translates it,
// the reader chose "main content only", it grows and changes step by step, a burst of
// mutations hits it, its URL is rewritten on every scroll, it has still to hydrate, the
// reader flicks through it or leaves the tab, and its shadow roots arrive late or closed.
//
//   npx playwright test scenarios-page
import { test, expect, BADGE_SEL, SCORE, ABSENCE_MS, PARA, PAGE, settledChips, chipsSettle, chipCounts, marked } from "./kit.mjs";

/** Collect the orchestrator's debug lines that match `re` (debug logging on first). */
async function debugLines(page, storage, re) {
  await storage.set({ debug: true });
  const lines = [];
  page.on("console", (m) => {
    if (re.test(m.text())) lines.push(m.text());
  });
  return lines;
}
const markCount = (page) => page.evaluate(() => { let n = 0; for (const h of CSS.highlights.values()) n += h.size; return n; });

test("a page that replaces its own document (document.open/write) gets chips, the ball and marks on the new tree", async ({ page, pages }) => {
  // What challenge interstitials and legacy frameworks do: the extension must restart on the new tree.
  pages.serve({
    "/rewrite.html": `<!doctype html><html><head><meta charset="utf-8"><title>rewrite fixture</title></head><body>
<p>Interstitial: checking your browser, please wait…</p>
<script>
  setTimeout(() => {
    document.open();
    document.write('<!doctype html><html><head><meta charset="utf-8"><title>rewritten</title></head><body><main><p id="rw1">${PARA("REWRITTEN-ONE")}</p><p id="rw2">${PARA("REWRITTEN-TWO")}</p></main></body></html>');
    document.close();
  }, 1500);
</script></body></html>`,
  });
  await page.goto(pages.url("/rewrite.html"), { waitUntil: "load" });
  const rewrite = "self-rewriting page (document.open/write): chips, ball and marks on the new tree";
  // Settled chips, not the "analyzing…" ones inserted at dispatch: marks land with the verdict.
  await expect.poll(() => page.evaluate(() => document.title), { message: rewrite }).toBe("rewritten");
  await chipsSettle(page, 2, "main");
  await expect(page.locator("#anagram-fab"), rewrite).toBeAttached();
  await expect.poll(() => markCount(page), { message: rewrite }).toBeGreaterThanOrEqual(2);
});

// Chrome's page translation replaces every text node with <font> copies holding the
// translation and classes <html> `translated-ltr`; "Show original" puts the nodes back and
// drops the class. Machine output is nobody's writing.
test("a page the browser translated: nothing is read or left on it while it is translated, and it is read again once the original is back", async ({ page, pages, nativeHost, tell }) => {
  pages.serve({
    "/translated.html": PAGE("translated fixture", `<main><p id="t1">${PARA("ORIGINAL-ONE")}</p><p id="t2">${PARA("ORIGINAL-TWO")}</p></main>
<script>
  const saved = [];
  window.__translate = () => {
    for (const p of document.querySelectorAll("main p")) {
      const text = p.firstChild;
      saved.push([p, text]);
      const outer = document.createElement("font");
      const inner = document.createElement("font");
      outer.style.verticalAlign = inner.style.verticalAlign = "inherit";
      inner.textContent = text.data.replace("ORIGINAL", "MACHINE");
      outer.appendChild(inner);
      p.replaceChild(outer, text);
    }
    document.documentElement.classList.add("translated-ltr");
  };
  window.__revert = () => {
    for (const [p, text] of saved.splice(0)) p.replaceChildren(text);
    document.documentElement.classList.remove("translated-ltr");
  };
</script>`, "de"),
  });
  const look = () => page.evaluate((sel) => ({ chips: document.querySelectorAll(sel).length, ball: !!document.getElementById("anagram-fab") }), BADGE_SEL);
  const translated = "a page the browser translated: nothing is read or left on it while it is translated, and it is read again once the original is back";
  const mark = nativeHost.textMark();
  await page.goto(pages.url("/translated.html"), { waitUntil: "load" });
  await chipsSettle(page, 2);
  expect(await look(), `${translated} (before)`).toEqual({ chips: 2, ball: true });

  await page.evaluate(() => window.__translate());
  await expect.poll(look, { message: `${translated} (during)` }).toEqual({ chips: 0, ball: false });
  expect(await markCount(page), `${translated} (no marks during)`).toBe(0);
  expect((await tell(page, { action: "getTabState" }))?.translated, `${translated} (the tab says so)`).toBe(true);
  await page.waitForTimeout(ABSENCE_MS); // past the observers' debounce, the scheduler and the host
  expect(nativeHost.textsSince(mark).filter((t) => t.includes("MACHINE-")), `${translated} (nothing machine-made sent)`).toEqual([]);

  await page.evaluate(() => window.__revert());
  await chipsSettle(page, 2);
  expect(await look(), `${translated} (back)`).toEqual({ chips: 2, ball: true });
  await expect.poll(() => markCount(page), { message: `${translated} (marks back)` }).toBeGreaterThan(0);
});

// Edge's translator and Firefox's full-page translation mark the page their own ways
// (lib/dom/translation.ts). Edge gives every element it rewrites `_msttexthash` and
// `_msthash`, and takes them away with the translation. Firefox relabels <html lang> and
// numbers the elements inside a block it is translating with `data-moz-translations-id`
// until the translation is in; its "Show original" reloads the page, so there is no way back.
for (const browser of ["edge", "firefox"]) {
  const name = browser === "edge" ? "Edge's translator" : "Firefox's full-page translation";
  test(`a page ${name} translated: nothing is read or left on it while it is translated${browser === "edge" ? ", and it is read again once the original is back" : ""}`, async ({ page, pages, nativeHost }) => {
    pages.serve({
      "/translated.html": PAGE("translated fixture", `<main><p id="t1">${PARA("ORIGINAL-ONE")} <a href="#one">Mehr dazu</a></p><p id="t2">${PARA("ORIGINAL-TWO")} <a href="#two">Mehr dazu</a></p></main>
<script>
  const saved = [];
  window.__translate = ${browser === "edge"
    ? `() => {
    let n = 0;
    for (const p of document.querySelectorAll("main p")) {
      const text = p.firstChild;
      saved.push([p, text.data]);
      p.setAttribute("_msttexthash", String(1000 + n));
      p.setAttribute("_msthash", String(++n));
      text.data = text.data.replace("ORIGINAL", "MACHINE");
    }
  }`
    : `() => {
    document.documentElement.lang = "en";
    for (const p of document.querySelectorAll("main p")) {
      p.querySelectorAll("*").forEach((el, i) => { el.dataset.mozTranslationsId = String(i); });
      p.firstChild.data = p.firstChild.data.replace("ORIGINAL", "MACHINE");
      p.querySelectorAll("*").forEach((el) => { delete el.dataset.mozTranslationsId; });
    }
  }`};
  window.__revert = () => {
    for (const [p, data] of saved.splice(0)) {
      p.removeAttribute("_msttexthash");
      p.removeAttribute("_msthash");
      p.firstChild.data = data;
    }
  };
</script>`, "de"),
    });
    const look = () => page.evaluate((sel) => ({ chips: document.querySelectorAll(sel).length, ball: !!document.getElementById("anagram-fab") }), BADGE_SEL);
    const translated = `a page ${name} translated: nothing is read or left on it while it is translated`;
    const mark = nativeHost.textMark();
    await page.goto(pages.url("/translated.html"), { waitUntil: "load" });
    await chipsSettle(page, 2);
    expect(await look(), `${translated} (before)`).toEqual({ chips: 2, ball: true });
    await page.evaluate(() => window.__translate());
    await expect.poll(look, { message: `${translated} (during)` }).toEqual({ chips: 0, ball: false });
    await page.waitForTimeout(ABSENCE_MS); // past the observers' debounce, the scheduler and the host
    expect(nativeHost.textsSince(mark).filter((t) => t.includes("MACHINE-")), `${translated} (nothing machine-made sent)`).toEqual([]);
    if (browser === "edge") {
      await page.evaluate(() => window.__revert());
      await chipsSettle(page, 2);
      expect(await look(), `${translated}, and it is read again once the original is back`).toEqual({ chips: 2, ball: true });
    }
  });
}

test("Immersive Translate's bilingual copy is never read, the original beside it is", async ({ page, pages, nativeHost }) => {
  pages.serve({
    "/immersive.html": PAGE("bilingual fixture", `<main><p id="i1">${PARA("ORIGINAL-IMT")}<font class="immersive-translate-target-wrapper" lang="en"><br><font class="immersive-translate-target-inner">${PARA("MACHINE-IMT")}</font></font></p></main>`, "de"),
  });
  const mark = nativeHost.textMark();
  await page.goto(pages.url("/immersive.html"), { waitUntil: "load" });
  await chipsSettle(page, 1, "#i1");
  const sent = nativeHost.textsSince(mark).filter((t) => t.includes("-IMT"));
  const bilingual = `Immersive Translate's bilingual copy is never read, the original beside it is: ${JSON.stringify(sent.map((t) => t.slice(0, 40)))}`;
  expect(sent.length, bilingual).toBeGreaterThan(0);
  expect(sent.every((t) => t.includes("ORIGINAL-IMT") && !t.includes("MACHINE-IMT")), bilingual).toBe(true);
});

// ---- the same page, built step by step or all at once ------------------------------------
// The safety net under lib/capture/orchestrator.ts's scan-root rule. A page that grows and
// changes under the reader must end up with exactly the chips a single fresh scan of its
// FINAL DOM produces: same places, same numbers (the fake's verdict is a pure function of
// the text, so a number that differs means the text or the grouping differs). One generator
// builds both pages: `?all` applies every step before the content script ever runs, the
// other applies them one at a time while the extension watches.
const INC_STEPS = 6;
const INC_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>incremental fixture</title>
<style>body{max-width:720px;margin:24px auto;font:15px/1.6 system-ui}.post{border-top:1px solid #ddd;padding:12px 0}
.row{display:flex;gap:8px;align-items:center;font-size:13px}img.avatar{width:22px;height:22px}</style></head><body>
<main id="feed"></main>
<article id="essay" data-home="essay"><h1>An essay with short paragraphs</h1></article>
<script>
const VOCAB="the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings a timetable moved off paper and nobody noticed until the trains ran on time".split(" ");
const words=(seed,n)=>Array.from({length:n},(_,i)=>VOCAB[(seed*37+i*11)%VOCAB.length]).join(" ");
const para=(seed,n)=>"Item "+seed+": "+words(seed,n)+".";
let seq=0;
function post(){
  const i=seq++;
  const d=document.createElement("div");
  d.className="post";d.id="post-"+i;d.setAttribute("data-home","post-"+i);
  d.innerHTML='<div class="row"><a href="/user/u'+i+'"><img class="avatar" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></a>'+
    '<a href="/user/u'+i+'">Author '+i+'</a><time datetime="2026-09-1'+(i%9)+'T10:00:00Z">'+(i%23)+'h ago</time></div>'+
    '<p class="body">'+para(i,30)+'</p><p class="body">'+para(i+100,32)+'</p><p class="body">'+para(i+200,28)+'</p>';
  document.getElementById("feed").appendChild(d);
  return d;
}
const essay=document.getElementById("essay");
const add=(id,seed,n)=>{const p=document.createElement("p");p.id=id;p.textContent=para(seed,n);essay.appendChild(p);return p;};
for(let k=0;k<2;k++)post();
add("e1",900,30);add("e2",901,28);add("e3",902,26);add("e4",903,31);
const STEPS=[
  ()=>{for(let k=0;k<3;k++)post();},                                     // a batch of posts
  ()=>{for(let k=0;k<3;k++)post();},                                     // another batch
  ()=>{const p=document.createElement("p");p.className="body";p.textContent=para(300,25);
       document.getElementById("post-1").appendChild(p);},               // a paragraph into a live post
  ()=>{document.querySelector("#post-0 p.body").firstChild.data=para(400,27);}, // text edited in place
  ()=>{const p=document.getElementById("e2");const w=document.createElement("div");
       w.className="wrapped";p.replaceWith(w);w.appendChild(p);},        // wrap
  ()=>{const w=document.querySelector("#essay .wrapped");if(w&&w.firstElementChild!==document.getElementById("e2"))return;
       const p=document.getElementById("e3");const w2=document.createElement("div");p.replaceWith(w2);w2.appendChild(p);
       w2.replaceWith(p);},                                             // wrap and unwrap again
];
window.__step=(i)=>STEPS[i]();
if(location.search.includes("all"))for(const s of STEPS)s();
</script></body></html>`;

/** Every chip as "where it sits : what it says", stable across runs, and different the
 *  moment a unit's text or its grouping differs. */
const chipSig = (page) =>
  page.evaluate(
    (sel) =>
      [...document.querySelectorAll(sel)]
        .map((h) => `${h.closest("[data-home]")?.getAttribute("data-home") ?? "page"}:${h.shadowRoot?.querySelector(".num")?.textContent?.trim() ?? "?"}`)
        .join(" | "),
    BADGE_SEL,
  );
/** Every post and the essay carry a verdict, and nothing is still "analyzing…". */
const homesRead = (page, posts) =>
  expect
    .poll(
      () =>
        page.evaluate((sel) => {
          const hosts = [...document.querySelectorAll(sel)];
          const read = new Set(hosts.filter((h) => h.shadowRoot?.querySelector(".pill:not(.pending)")).map((h) => h.closest("[data-home]")?.getAttribute("data-home")));
          return { homes: [...document.querySelectorAll("[data-home]")].filter((el) => !read.has(el.getAttribute("data-home"))).map((el) => el.id), pending: hosts.length - hosts.filter((h) => h.shadowRoot?.querySelector(".pill:not(.pending)")).length };
        }, BADGE_SEL),
      { message: `all ${posts} posts and the essay are read` },
    )
    .toEqual({ homes: [], pending: 0 });

test("a page built step by step ends up with the chips one fresh scan of its final DOM gives", async ({ context, page, pages, storage }) => {
  pages.serve({ "/incremental.html": INC_PAGE });
  const whole = await context.newPage();
  await whole.goto(pages.url("/incremental.html?all"), { waitUntil: "load" });
  await homesRead(whole, 8);
  const fresh = await chipSig(whole);
  await whole.close();

  const scans = await debugLines(page, storage, /dirty scan:/);
  await page.goto(pages.url("/incremental.html"), { waitUntil: "load" });
  await homesRead(page, 2);
  for (let i = 0; i < INC_STEPS; i++) {
    const before = scans.length;
    await page.evaluate((n) => window.__step(n), i);
    // Each step is walked on its own before the next: that is the point.
    await expect.poll(() => scans.length, { message: `step ${i} is walked` }).toBeGreaterThan(before);
  }
  await homesRead(page, 8);
  await expect.poll(() => chipSig(page), { message: "a page built step by step ends up with the chips one fresh scan of its final DOM gives" }).toBe(fresh);
});

// One burst may become at most MAX_SCAN_ROOTS walks, however many nodes it touched. Without
// it a page that re-renders its islands (dev.to) turned ~200 dirty nodes into ~200 walks.
test("a mutation burst is bounded to at most ten walks, whatever it touched", async ({ page, pages, storage }) => {
  pages.serve({ "/incremental.html": INC_PAGE });
  const lines = await debugLines(page, storage, /dirty scan:/);
  const drains = () =>
    lines.map((l) => /dirty scan: (\d+) dirty, \d+ removed, (\d+) planned, (\d+) roots,/.exec(l)).filter(Boolean).map((m) => ({ dirty: +m[1], planned: +m[2], roots: +m[3] }));
  await page.goto(pages.url("/incremental.html"), { waitUntil: "load" });
  await homesRead(page, 2);
  await page.evaluate(() => {
    // 120 separate parents touched in one burst: what an island re-render looks like.
    for (const p of document.querySelectorAll("#feed p.body, #essay p")) {
      const span = document.createElement("span");
      span.textContent = " and then some more of it.";
      p.appendChild(span);
    }
    for (let k = 0; k < 60; k++) {
      const d = document.createElement("div");
      d.textContent = "row " + k;
      document.getElementById("essay").appendChild(d);
    }
  });
  const bounded = "a mutation burst is bounded to at most ten walks, whatever it touched";
  await expect.poll(() => drains().filter((d) => d.dirty > 10).length, { message: `${bounded} (the burst is walked)` }).toBeGreaterThan(0);
  expect(drains().filter((d) => d.dirty > 10 && d.planned > 10), bounded).toEqual([]);
});

// Discourse rewrites the address with the post number on every scroll step (51
// whole-document re-walks in a 90-second session), while a pushed entry still gets its refresh.
test("twenty URL rewrites cost no re-walk and no chip; a pushed entry is refreshed once", async ({ page, pages, storage }) => {
  pages.serve({ "/incremental.html": INC_PAGE });
  const refreshes = await debugLines(page, storage, /url change refresh/);
  await page.goto(pages.url("/incremental.html"), { waitUntil: "load" });
  await homesRead(page, 2);
  const chipsBefore = await chipSig(page);
  const rewrites = "twenty URL rewrites cost no re-walk and no chip; a pushed entry is refreshed once";
  await page.evaluate(() => {
    for (let i = 0; i < 20; i++) history.replaceState(null, "", `?post=${i}`);
  });
  await page.waitForTimeout(ABSENCE_MS); // well past the refresh's own 300 ms debounce
  expect(refreshes, `${rewrites} (rewrites)`).toEqual([]);
  expect(await chipSig(page), `${rewrites} (the chips kept)`).toBe(chipsBefore);
  // A real route change: a pushed entry AND the content it brings.
  await page.evaluate(() => {
    history.pushState(null, "", "/incremental.html?route=2");
    for (let i = 0; i < 3; i++) history.replaceState(null, "", `/incremental.html?route=2&t=${i}`);
  });
  await expect.poll(() => refreshes.length, { message: `${rewrites} (the push)` }).toBeGreaterThan(0);
  await page.waitForTimeout(ABSENCE_MS);
  expect(refreshes, `${rewrites} (once)`).toHaveLength(1);
});

// ---- the insertion gate: nothing enters a tree that has still to hydrate ------------------
// Both pages carry an image the server holds until the host has been asked about the page,
// so `load` comes after the scoring: without a hydration marker the chips are in the page
// before it, with one they wait for it and the idle period after it.
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
const HYDRATING = (marked) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${marked ? "hydrating" : "plain"} page</title></head>
<body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
${marked ? '<div id="__docusaurus">' : '<div id="plain">'}
<p id="h1">${PARA("HYDRATE-ONE")}</p><p id="h2">${PARA("HYDRATE-TWO")}</p></div>
<img src="/slow.gif" width="1" height="1" alt="">
<script>
// What a framework sees in its own tree at the moment it would hydrate.
window.__loadAt=null;window.__seenAtLoad=null;
addEventListener("load",()=>{window.__loadAt=performance.now();
  window.__seenAtLoad=document.querySelectorAll('#__docusaurus [data-anagram], #plain [data-anagram]').length;});
</script></body></html>`;
function firstHostWatcher() {
  window.__firstHostAt = null;
  new MutationObserver((recs) => {
    if (window.__firstHostAt !== null) return;
    for (const rec of recs) {
      for (const n of rec.addedNodes) {
        // The ball is ours and lives outside anything a framework hydrates; this watches
        // for a CHIP entering the page's own tree.
        if (n.nodeType === 1 && n.getAttribute?.("data-anagram") === "host" && n.id !== "anagram-fab") {
          window.__firstHostAt = performance.now();
          return;
        }
      }
    }
  }).observe(document, { childList: true, subtree: true }); // at document_start there is no <html> yet
}

const hydrating = test.extend({
  /** The pages, and the image `load` waits for, sent once `release()` is called. */
  gate: async ({ page, pages, storage, nativeHost }, use) => {
    let release;
    const released = new Promise((r) => (release = r));
    pages.serve({
      "/hydrating.html": HYDRATING(true),
      "/plainpage.html": HYDRATING(false),
      "/slow.gif": async (req, res) => {
        await released;
        res.writeHead(200, { "content-type": "image/gif", "content-length": GIF.length });
        res.end(GIF);
      },
    });
    const opened = await debugLines(page, storage, /insertion gate open/);
    await page.addInitScript(firstHostWatcher);
    const asked = () => nativeHost.textsSince().some((t) => t.includes("HYDRATE-ONE"));
    await use({ opened, release, asked });
    release();
  },
});

async function openGated(page, pages, gate, path) {
  const loaded = page.goto(pages.url(path), { waitUntil: "load" });
  await expect.poll(gate.asked, { message: "the host is asked about the page before it has loaded" }).toBe(true);
  gate.release();
  await loaded;
  await chipsSettle(page, 2);
  await expect.poll(() => gate.opened.length, { message: "the insertion gate opens" }).toBeGreaterThan(0);
  const t = await page.evaluate(() => ({ loadAt: window.__loadAt, firstHostAt: window.__firstHostAt, seenAtLoad: window.__seenAtLoad }));
  const shown = await page.locator(`${BADGE_SEL} .num`).allTextContents();
  return { ...t, shown: shown.map((s) => s.trim()), held: Number(/(\d+) held/.exec(gate.opened[0])[1]) };
}

hydrating("a page that has still to hydrate gets no chip until it has, and still gets its chips", async ({ page, pages, gate }) => {
  const marked = await openGated(page, pages, gate, "/hydrating.html");
  const note = `a page that has still to hydrate gets no chip until it has, and still gets its chips: ${JSON.stringify(marked)}`;
  // The verdicts land while the gate is shut, so this also says that a chip held back and
  // then released arrives as its VERDICT, never as a pending chip nobody comes back to.
  expect.soft(marked.shown, note).toHaveLength(2);
  expect.soft(marked.shown.every((n) => SCORE.test(n)), note).toBe(true);
  expect.soft(marked.seenAtLoad, note).toBe(0);
  expect.soft(marked.held, note).toBeGreaterThan(0);
  expect.soft(marked.firstHostAt, note).toBeGreaterThan(marked.loadAt);
});

hydrating("a page with no hydration marker is chipped as early as ever", async ({ page, pages, gate }) => {
  const plain = await openGated(page, pages, gate, "/plainpage.html");
  const note = `a page with no hydration marker is chipped as early as ever: ${JSON.stringify(plain)}`;
  expect.soft(plain.shown.length, note).toBeGreaterThanOrEqual(2);
  expect.soft(plain.held, note).toBe(0);
  expect.soft(plain.firstHostAt, note).not.toBeNull();
  expect.soft(plain.firstHostAt, note).toBeLessThan(plain.loadAt);
});

// Torn down while the chips were still waiting: nothing may be drawn into the page
// afterwards, nothing may stay armed to draw it, and the next run starts clean.
hydrating("torn down while chips waited for hydration: none is drawn afterwards, nothing stays armed, the next run starts clean", async ({ page, pages, gate, tell }) => {
  const torn = "torn down while chips waited for hydration: none is drawn afterwards, nothing stays armed, the next run starts clean";
  const loaded = page.goto(pages.url("/hydrating.html"), { waitUntil: "load" });
  await expect.poll(gate.asked, { message: `${torn} (scored before load)` }).toBe(true);
  await page.waitForFunction(() => document.readyState !== "loading");
  await tell(page, { action: "teardown" });
  gate.release();
  await loaded;
  // Past `load`, the idle period after it and the gate's own 2.5 s cap.
  await page.waitForTimeout(ABSENCE_MS + 1000);
  const after = await page.evaluate((sel) => ({ chips: document.querySelectorAll(sel).length, firstHostAt: window.__firstHostAt }), BADGE_SEL);
  expect.soft(after, `${torn} (nothing drawn)`).toEqual({ chips: 0, firstHostAt: null });
  expect.soft(gate.opened, `${torn} (no gate opened while off)`).toEqual([]);
  await tell(page, { action: "setEnabled", value: true });
  await expect.poll(async () => (await chipCounts(page)).chips, { message: `${torn} (the next run)` }).toBeGreaterThanOrEqual(2);
  await expect.poll(async () => (await chipCounts(page)).pending, { message: `${torn} (the next run)` }).toBe(0);
  expect.soft(gate.opened, `${torn} (one gate, the next run's)`).toHaveLength(1);
});

// ---- following the reader: a fast scroll, a hidden tab -------------------------------------
// Every paragraph is its own unit and every text is new to the caches, so each is
// dispatched exactly once, and its "analyzing…" chip goes in once the browser has said
// what language it is in.
const VOCAB = "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings a timetable moved off paper and nobody noticed until the trains ran on time".split(" ");
const para = (tag, i) => `${tag}-${i} ` + Array.from({ length: 84 }, (_, k) => VOCAB[(i * 7 + k * 13) % VOCAB.length]).join(" ") + ".";
function chipClock() {
  window.__chipAt = {};
  new MutationObserver(() => {
    for (const host of document.querySelectorAll('[data-anagram="host"]:not(#anagram-fab)')) {
      const p = host.closest("p[id]");
      if (p && !(p.id in window.__chipAt)) window.__chipAt[p.id] = performance.now();
    }
  }).observe(document, { childList: true, subtree: true });
}

/**
 * The order the content script sends paragraphs in, as `window.__sent` in the page: a batch
 * asks the browser's language detector about each of its paragraphs in the task that sends
 * it (lib/capture/langGate.ts), and each question's first words are recorded there. The
 * detector itself still answers. Hooked as the content script's world appears; a question
 * asked before that is not recorded, and it was asked before any scroll.
 */
async function sendOrder(context, page) {
  await page.addInitScript(() => {
    window.__sent = [];
    addEventListener("anagram-test-sent", (event) => window.__sent.push(event.detail));
  });
  const cdp = await context.newCDPSession(page);
  const hooked = new Set();
  cdp.on("Runtime.executionContextCreated", ({ context: c }) => {
    if (c.auxData?.type !== "isolated" || !c.origin.startsWith("chrome-extension://") || hooked.has(c.id)) return;
    hooked.add(c.id);
    void cdp.send("Runtime.evaluate", {
      contextId: c.id,
      expression: `for (const api of new Set([globalThis.chrome, globalThis.browser].filter((a) => a?.i18n?.detectLanguage))) {
        const detect = api.i18n.detectLanguage.bind(api.i18n);
        api.i18n.detectLanguage = (text, ...rest) => {
          dispatchEvent(new CustomEvent("anagram-test-sent", { detail: String(text).slice(0, 24) }));
          return detect(text, ...rest);
        };
      }`,
    }).catch(() => {});
  });
  await cdp.send("Runtime.enable");
}

test("a fast scroll: what is on screen when it stops is sent before anything scrolled far past", async ({ context, page, pages, nativeHost }) => {
  // A reader flicks through ninety paragraphs to the end of the page while the engine is
  // slow. What was on screen for a moment and is far behind now must wait for what the
  // reader stopped at, not the other way round.
  pages.serve({ "/scroll.html": PAGE("scroll fixture", Array.from({ length: 90 }, (_, i) => `<p id="sp${i}">${para("SCROLLPAST", i)}</p>`).join("\n")) });
  nativeHost.setState({ latency: [700, 700] });
  await page.addInitScript(chipClock);
  await sendOrder(context, page);
  await page.goto(pages.url("/scroll.html"), { waitUntil: "load" });
  await expect.poll(() => page.evaluate(() => Object.keys(window.__chipAt).length)).toBeGreaterThan(0);
  const end = await page.evaluate(async () => {
    const frames = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const step = Math.round(innerHeight * 0.9);
    const bottom = document.documentElement.scrollHeight - innerHeight;
    for (let y = step; y < bottom; y += step) {
      scrollTo(0, y);
      await frames();
    }
    scrollTo(0, bottom);
    await frames();
    const rows = [...document.querySelectorAll("p[id]")].map((el) => ({ id: el.id, box: el.getBoundingClientRect() }));
    return {
      t0: performance.now(),
      // How many paragraphs had been sent when the scroll stopped.
      sentBefore: window.__sent.length,
      onScreen: rows.filter((r) => r.box.bottom > 0 && r.box.top < innerHeight).map((r) => r.id),
      // Well outside the 1200 px the prefetch margin reaches above the viewport.
      far: rows.filter((r) => r.box.bottom < -1500).map((r) => r.id),
    };
  });
  const fast = "a fast scroll: what is on screen when it stops is sent before anything scrolled far past";
  await expect
    .poll(() => page.evaluate((ids) => ids.filter((id) => !(id in window.__chipAt)), end.onScreen), { message: `${fast} (every paragraph on screen is sent)`, timeout: 40_000 })
    .toEqual([]);
  const r = await page.evaluate(({ onScreen, far, t0, sentBefore }) => {
    const at = window.__chipAt;
    const last = Math.max(...onScreen.map((id) => at[id]));
    // A paragraph sent while the scroll went past it may put its chip up after the scroll
    // stopped; only what was sent after it stopped has to wait for what is on screen.
    const sentAt = new Map(window.__sent.map((words, i) => [`sp${/^SCROLLPAST-(\d+) /.exec(words)?.[1]}`, i]).reverse());
    const sentAfter = (id) => (sentAt.get(id) ?? -1) >= sentBefore;
    return {
      onScreen: onScreen.length,
      far: far.length,
      sent: [sentBefore, window.__sent.length],
      farFirst: far.filter((id) => sentAfter(id) && at[id] < last).length,
      waitMs: Math.round(last - t0),
    };
  }, end);
  const note = `${fast}: ${JSON.stringify(r)}`;
  expect.soft(r.onScreen, note).toBeGreaterThan(0);
  expect.soft(r.far, note).toBeGreaterThan(20);
  // The order was heard: what the reader stopped at was sent after the scroll stopped.
  expect.soft(r.sent[1], note).toBeGreaterThan(r.sent[0]);
  expect.soft(r.farFirst, note).toBe(0);
});

// Headless Chromium never hides a page, so the content script's own world is told it is
// hidden, exactly as the browser would tell it: visibilityState and a visibilitychange event.
test("a hidden tab dispatches nothing, not even the idle prefetch, and resumes when shown", async ({ context, page, pages, nativeHost }) => {
  pages.serve({
    "/hidden.html": PAGE("hidden fixture", `<main id="top">${[0, 1].map((i) => `<p>${para("SHOWNFIRST", i)}</p>`).join("")}</main><div style="height:5000px"></div><div id="bottom"></div>`),
  });
  const mark = nativeHost.textMark();
  await page.goto(pages.url("/hidden.html"), { waitUntil: "load" });
  await chipsSettle(page, 2, "#top");
  const cdp = await context.newCDPSession(page);
  const worlds = [];
  cdp.on("Runtime.executionContextCreated", ({ context: c }) => worlds.push(c));
  await cdp.send("Runtime.enable");
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const hidden = "a hidden tab dispatches nothing, not even the idle prefetch, and resumes when shown";
  const isolated = () => worlds.find((c) => c.auxData?.frameId === frameTree.frame.id && c.auxData?.type === "isolated" && c.origin.startsWith("chrome-extension://"));
  await expect.poll(() => !!isolated(), { message: `${hidden} (the content script's world)` }).toBe(true);
  const setHidden = (value) =>
    cdp.send("Runtime.evaluate", {
      contextId: isolated().id,
      expression: `(() => {
        for (const [key, value] of [["visibilityState", ${value} ? "hidden" : "visible"], ["hidden", ${value}]])
          Object.defineProperty(document, key, { configurable: true, get: () => value });
        document.dispatchEvent(new Event("visibilitychange"));
      })()`,
    });
  await setHidden(true);
  await page.evaluate(([onScreen, below]) => {
    const add = (where, id, text) => {
      const el = document.createElement("p");
      el.id = id;
      el.textContent = text;
      where.append(el);
    };
    add(document.getElementById("top"), "hid-top", onScreen);
    add(document.getElementById("bottom"), "hid-bottom", below);
  }, [para("WHILEHIDDEN", 0), para("WHILEHIDDEN", 1)]);
  await page.waitForTimeout(ABSENCE_MS);
  await expect(page.locator(`#hid-top ${BADGE_SEL}, #hid-bottom ${BADGE_SEL}`), `${hidden} (no chip while hidden)`).toHaveCount(0);
  expect(nativeHost.textsSince(mark).filter((t) => t.includes("WHILEHIDDEN")), `${hidden} (nothing sent while hidden)`).toEqual([]);
  await setHidden(false);
  await expect(page.locator(`#hid-top ${BADGE_SEL}`), `${hidden} (resumes when shown)`).toHaveCount(1);
  await cdp.detach().catch(() => {});
});

// ---- shadow roots the first walk could not see ----------------------------------------------
const LATE = (tag) => `${tag} paragraph is long enough to be scored on its own because it carries well over seventy-five ordinary English words describing nothing in particular except the fact that a web component may attach its shadow root or render into it long after the extension walked past its host, and the text it shows the reader there has to be found all the same, without a reload and without anything in the light document changing at the same moment to point at it.`;

test("a shadow root attached after the walk, or filled after it, is read: a late custom element, a panel on the page from the start, a panel added after", async ({ page, pages }) => {
  // Nothing of these is in the light DOM: a shadow root attached, or filled, after the walk
  // passed its host changes no node the document's own observer watches.
  //  - #lc: an element the page defines late; its upgrade attaches the root and renders.
  //  - #panel: a fixed panel with an empty root when the page is walked (too small then to
  //    be read, so the walk never goes in), filled later.
  //  - #panel2: the same panel added after the walk, its root attached before it was added.
  pages.serve({
    "/shadow-late.html": PAGE("late shadow roots", `<h1>Late shadow roots</h1>
<late-card id="lc"></late-card>
<script>
  const LONG = ${LATE.toString()};
  const panel = (id, bottom) => {
    const el = document.createElement("div");
    el.id = id;
    el.style.cssText = "position:fixed;right:8px;bottom:" + bottom + "px;width:420px;max-height:40vh;overflow:auto;background:#fff;font:14px/1.5 system-ui";
    window["__" + id] = el.attachShadow({ mode: "open" });
    document.body.append(el);
  };
  panel("panel", 8);
  // Apart in time: adding a node to the body has the body walked again, and that walk
  // would find a root attached just before it.
  setTimeout(() => panel("panel2", 260), 1200);
  setTimeout(() => customElements.define("late-card", class extends HTMLElement {
    connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = "<p>" + LONG("LATECARD") + "</p>"; }
  }), 2400);
  setTimeout(() => {
    __panel.innerHTML = "<p>" + LONG("LATEPANEL") + "</p>";
    __panel2.innerHTML = "<p>" + LONG("LATEPANELTWO") + "</p>";
  }, 3200);
</script>`),
  });
  await page.goto(pages.url("/shadow-late.html"), { waitUntil: "load" });
  await expect(settledChips(page, "#lc"), "a shadow root attached after the walk (a late custom element) is read").toHaveCount(1);
  const filled = "a shadow root the walk passed empty, filled later, is read — on the page from the start or added after";
  await expect(settledChips(page, "#panel"), filled).toHaveCount(1);
  await expect(settledChips(page, "#panel2"), filled).toHaveCount(1);
});

// The page-world script (entrypoints/shadow.content.ts) wraps attachShadow, and a page must
// not be able to tell. This page does what a page looking for Anagram would: its first script
// asks attachShadow and Function.prototype.toString everything the natives answer (text, name,
// length, prototype, property flags, `new`, errors and their stacks), listens for the names
// Anagram once used, watches dispatchEvent, the window's globals and its messages, and every
// answer must be the native's. The roots it attaches late, open and closed, are read all the
// same: the event still reaches the content script, under a name the page never learns.
test("the page cannot tell the page-world script is there: attachShadow and toString answer as natives, and no name, global or message gives Anagram away", async ({ page, pages }) => {
  const quiet = "the page cannot tell the page-world script is there";
  pages.serve({
    "/quiet.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>quiet fixture</title><script>
window.__seen = { events: 0, dispatched: 0, messages: [] };
for (const type of ["anagram-shadow-attached", "anagram-shadow-port"]) {
  document.addEventListener(type, () => __seen.events++, true);
  window.addEventListener(type, () => __seen.events++, true);
}
addEventListener("message", (e) => __seen.messages.push(JSON.stringify(e.data) ?? String(e.data)));
window.__first = (() => {
  const out = {};
  const f = Element.prototype.attachShadow;
  const ts = Function.prototype.toString;
  const err = (fn) => { try { fn(); return "no error"; } catch (e) { return { name: e.constructor.name, message: e.message, stack: String(e.stack) }; } };
  out.text = ts.call(f); out.textMethod = f.toString(); out.name = f.name; out.length = f.length;
  out.prototype = Object.prototype.hasOwnProperty.call(f, "prototype"); out.keys = Reflect.ownKeys(f).map(String).join(",");
  const d = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow");
  out.flags = [d.writable, d.enumerable, d.configurable].join(",");
  out.newf = err(() => new f()).message; out.construct = err(() => Reflect.construct(f, [])).message; out.extends = err(() => { class X extends f {} }).message;
  out.illegal = err(() => f.call({})); out.badMode = err(() => document.createElement("div").attachShadow({ mode: "nope" }));
  out.unsupported = err(() => document.createElement("input").attachShadow({ mode: "open" }));
  out.twice = err(() => { const el = document.createElement("div"); el.attachShadow({ mode: "open" }); el.attachShadow({ mode: "open" }); });
  out.tsText = ts.call(ts); out.tsName = ts.name + "/" + ts.length; out.tsPrototype = Object.prototype.hasOwnProperty.call(ts, "prototype");
  const t = Object.getOwnPropertyDescriptor(Function.prototype, "toString"); out.tsFlags = [t.writable, t.enumerable, t.configurable].join(",");
  out.tsError = err(() => ts.call({})); out.tsErrorNull = err(() => ts.call(null));
  // A prototype chain that leads back to the function: the native refuses it, a Proxy alone
  // would not look past itself and take it. And one of null: nothing to convert it with.
  out.cycle = err(() => Object.setPrototypeOf(f, Object.create(f)));
  out.cycleProto = err(() => { f.__proto__ = Object.create(f); });
  out.tsCycle = err(() => Object.setPrototypeOf(ts, Object.create(ts)));
  out.afterCycle = [ts.call(f), typeof f.call, Object.getPrototypeOf(f) === Function.prototype].join(" | ");
  Object.setPrototypeOf(f, null); out.nullConvert = err(() => f + ""); Object.setPrototypeOf(f, Function.prototype);
  out.plainToString = ts.call(function plain(a, b) { return a + b; });
  out.globals = Object.getOwnPropertyNames(window).filter((n) => /anagram|wxt/i.test(n) || n === "shadow" || n === "shadowPort");
  out.attributes = [...document.documentElement.attributes].map((a) => a.name);
  const dispatch = EventTarget.prototype.dispatchEvent;
  EventTarget.prototype.dispatchEvent = function (e) { __seen.dispatched++; return dispatch.call(this, e); };
  const host = document.createElement("div"); host.attachShadow({ mode: "closed" });
  EventTarget.prototype.dispatchEvent = dispatch;
  return out;
})();
</script></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<h1>A page that looks for Anagram</h1>
<quiet-card id="qc"></quiet-card>
<div id="qd"></div>
<script>
  const LONG = ${LATE.toString()};
  window.__closed = {};
  setTimeout(() => customElements.define("quiet-card", class extends HTMLElement {
    connectedCallback() { this.attachShadow({ mode: "open" }).innerHTML = "<p>" + LONG("QUIETCARD") + "</p>"; }
  }), 1200);
  setTimeout(() => {
    window.__closed.qd = document.getElementById("qd").attachShadow({ mode: "closed" });
    window.__closed.qd.innerHTML = "<p>" + LONG("QUIETDIV") + "</p>";
  }, 1800);
</script></body></html>`,
  });
  await page.goto(pages.url("/quiet.html"), { waitUntil: "load" });
  const first = await page.evaluate(() => window.__first);
  // A native's error, as V8 writes it: the native's own frame on top where it has one
  // ("    at Object.toString (<anonymous>)"), then the page's frames, and nothing else.
  const own = (stack) => !/-extension:\/\//.test(stack) &&
    stack.split("\n").slice(1).every((line, i) => line.includes("/quiet.html") || (i === 0 && /^ {4}at [\w. _]+ \(<anonymous>\)$/.test(line)));
  expect.soft(first.text, quiet).toBe("function attachShadow() { [native code] }");
  expect.soft(first.textMethod, quiet).toBe("function attachShadow() { [native code] }");
  expect.soft([first.name, first.length, first.prototype, first.keys, first.flags], quiet).toEqual(["attachShadow", 1, false, "length,name", "true,true,true"]);
  expect.soft([first.newf, first.construct, first.extends], quiet).toEqual([
    "f is not a constructor",
    "function attachShadow() { [native code] } is not a constructor",
    "Class extends value function attachShadow() { [native code] } is not a constructor or null",
  ]);
  for (const [what, e, message] of [
    ["illegal", first.illegal, "Illegal invocation"],
    ["badMode", first.badMode, /^Failed to execute 'attachShadow' on 'Element': .*'nope' is not a valid enum value/],
    ["unsupported", first.unsupported, "Failed to execute 'attachShadow' on 'Element': This element does not support attachShadow"],
    ["twice", first.twice, /^Failed to execute 'attachShadow' on 'Element': Shadow root cannot be created on a host which already hosts a shadow tree/],
  ]) {
    expect.soft(e.message, `${quiet}: ${what}`).toMatch(message);
    expect.soft(own(e.stack), `${quiet}: the ${what} error's stack is the page's own: ${e.stack}`).toBe(true);
  }
  expect.soft([first.tsText, first.tsName, first.tsPrototype, first.tsFlags], quiet).toEqual(["function toString() { [native code] }", "toString/0", false, "true,false,true"]);
  expect.soft(first.plainToString, quiet).toBe("function plain(a, b) { return a + b; }");
  for (const [what, e, message] of [
    ["a cycle", first.cycle, "Cyclic __proto__ value"],
    ["a cycle through __proto__", first.cycleProto, "Cyclic __proto__ value"],
    ["a cycle of toString's", first.tsCycle, "Cyclic __proto__ value"],
    ["a null prototype", first.nullConvert, "Cannot convert object to primitive value"],
  ]) {
    expect.soft([e.name, e.message], `${quiet}: ${what}`).toEqual(["TypeError", message]);
    expect.soft(own(e.stack), `${quiet}: the stack of ${what} is the page's own: ${e.stack}`).toBe(true);
  }
  expect.soft(first.afterCycle, quiet).toBe("function attachShadow() { [native code] } | function | true");
  for (const e of [first.tsError, first.tsErrorNull]) {
    expect.soft(e.message, quiet).toBe("Function.prototype.toString requires that 'this' be a Function");
    // V8 lists the native toString's own frame, and then the caller's: nothing between them.
    expect.soft(e.stack.split("\n")[1], quiet).toMatch(/^ {4}at (Object\.)?toString \(<anonymous>\)$/);
    expect.soft(own(e.stack), `${quiet}: the toString error's stack is the page's own: ${e.stack}`).toBe(true);
  }
  expect.soft(first.globals, `${quiet}: no global of its own`).toEqual([]);
  expect.soft(first.attributes, `${quiet}: nothing on <html>`).toEqual(["lang"]);
  // The roots it attaches late are read all the same, the content script started meanwhile.
  await expect(settledChips(page, "#qc"), `${quiet}: a late open root is read`).toHaveCount(1);
  await expect.poll(() => page.evaluate((sel) => window.__closed.qd?.querySelectorAll(sel).length ?? -1, BADGE_SEL), { message: `${quiet}: a late closed root is read` }).toBe(1);
  const seen = await page.evaluate(() => window.__seen);
  expect.soft(seen.dispatched, `${quiet}: the event is not dispatched through anything the page can replace`).toBe(0);
  expect.soft(seen.events, `${quiet}: nothing under a name Anagram ever used`).toBe(0);
  expect.soft(seen.messages.filter((m) => /wxt|anagram|-extension:|[a-p]{32}/i.test(m)), `${quiet}: no message names the extension`).toEqual([]);
});

// A closed root keeps the page's other scripts out, not the extension: Chrome gives a content
// script every root through chrome.dom.openOrClosedShadowRoot. The page keeps its own
// references in window.__closed, which is how this test looks inside.
test("a closed shadow root is read: a custom element's at load, a <div>'s attached later", async ({ page, pages }) => {
  const LONG = (tag) => `${tag} paragraph is long enough to be scored on its own because it carries well over seventy-five ordinary English words describing nothing in particular except the fact that a component may keep its shadow root closed to the scripts of the page it sits in, which is its own business, while the reader who asked for the page to be analyzed still sees every word it renders there and expects a verdict for them like for any other paragraph.`;
  pages.serve({
    "/shadow-closed.html": PAGE("closed shadow roots", `<h1>Closed shadow roots</h1>
<closed-card id="cc"></closed-card>
<div id="cd"></div>
<script>
  const LONG = ${LONG.toString()};
  window.__closed = {};
  customElements.define("closed-card", class extends HTMLElement {
    constructor() { super(); window.__closed.cc = this.attachShadow({ mode: "closed" }); window.__closed.cc.innerHTML = "<p>" + LONG("CLOSEDCARD") + "</p>"; }
  });
  setTimeout(() => {
    window.__closed.cd = document.getElementById("cd").attachShadow({ mode: "closed" });
    window.__closed.cd.innerHTML = "<p>" + LONG("CLOSEDDIV") + "</p>";
  }, 2000);
</script>`),
  });
  await page.goto(pages.url("/shadow-closed.html"), { waitUntil: "load" });
  const count = () => page.evaluate((sel) => Object.fromEntries(["cc", "cd"].map((id) => [id, window.__closed[id]?.querySelectorAll(sel).length ?? -1])), BADGE_SEL);
  await expect.poll(count, { message: "a closed shadow root is read: a custom element's at load, a <div>'s attached later" }).toEqual({ cc: 1, cd: 1 });
});
