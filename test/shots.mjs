// test/shots.mjs — regenerate the README screenshots (docs/screenshots/).
// Live-site shots (Wikipedia, HF, Google Docs) need network; the dark-mode and
// popup shots are fully local.  node test/shots.mjs
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const EXT = join(ROOT, "output", "chrome-mv3");
const OUT = join(ROOT, "docs", "screenshots");
const DOC = "https://docs.google.com/document/d/1gRLkVx985SLnysZvrkm8PQolykP-rRWxBtxFoywXXRo";

const DARK_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { background:#0d1117; color:#c9d1d9; font:17px/1.75 Georgia, serif;
         max-width:720px; margin:48px auto; padding:0 24px; }
  h1 { font:700 28px/1.3 system-ui, sans-serif; color:#e6edf3; margin-bottom:4px; }
  .byline { color: #8b949e; font: 13px system-ui, sans-serif; margin-bottom: 28px; }
</style></head><body>
  <h1>The Quiet Rise of Synthetic Prose</h1>
  <div class="byline">A dark-theme reading demo</div>
  <p>Nobody set out to fill the web with machine-written text; it accumulated the way sediment
     does, one plausible paragraph at a time, until whole shorelines of the internet were made
     of it. Readers noticed the change the way you notice weather — not in any single sentence,
     but in a general flattening of the air, a suspicious smoothness where friction used to be.</p>
  <p>In the era of large language models, it has become increasingly crucial to delve into the
     multifaceted landscape of content authenticity. This paradigm shift underscores the
     importance of leveraging robust detection frameworks, fostering transparency, and
     navigating the intricate interplay between innovation and trust in our rapidly evolving
     digital ecosystem — a testament to the transformative potential of these technologies.</p>
  <p>The honest answer is that people write badly and machines write evenly, and the gap between
     those two failures is where detection lives. A human paragraph has burrs in it, small
     accidents of rhythm that no one would choose on purpose; the machine's paragraph has been
     sanded until nothing catches, and the sanding itself is the fingerprint it leaves behind.</p>
</body></html>`;

const server = http.createServer((_q, r) => {
  r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  r.end(DARK_PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const darkUrl = `http://localhost:${server.address().port}/dark.html`;

const context = await chromium.launchPersistentContext("", {
  headless: false, viewport: { width: 1180, height: 780 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });
const extId = new URL(sw.url()).host;

async function settle(page, sweeps = 6) {
  await page.waitForSelector('[data-pangram="host"]', { timeout: 15000 }).catch(() => {});
  await page.evaluate(async (n) => {
    for (let i = 0; i < n; i++) { scrollBy(0, innerHeight * 0.8); await new Promise((r) => setTimeout(r, 280)); }
    scrollTo(0, 0);
  }, sweeps).catch(() => {});
  await page.waitForTimeout(2600);
}

// 1) Wikipedia (live)
try {
  const p = await context.newPage();
  await p.goto("https://en.wikipedia.org/wiki/Alan_Turing", { waitUntil: "domcontentloaded", timeout: 40000 });
  await settle(p, 3);
  await p.evaluate(() => scrollTo(0, 430)); // into the lede prose
  await p.waitForTimeout(600);
  await p.screenshot({ path: join(OUT, "wikipedia.png") });
  await p.close();
  console.log("ok wikipedia.png");
} catch (e) { console.log("SKIP wikipedia:", String(e).slice(0, 80)); }

// 2) dark mode with pinned card (local, deterministic)
{
  const p = await context.newPage();
  await p.goto(darkUrl, { waitUntil: "load" });
  await settle(p, 2);
  // pin the highest-percent badge's card (the money shot: meter + sentences)
  await p.evaluate(() => {
    let best = null, bestPct = -1;
    for (const h of document.querySelectorAll('[data-pangram="host"]:not(#pangram-fab)')) {
      const t = h.shadowRoot?.querySelector(".num")?.textContent ?? "";
      const m = t.match(/(\d+)%/);
      if (m && +m[1] > bestPct) { bestPct = +m[1]; best = h; }
    }
    best?.click();
  });
  await p.waitForTimeout(500);
  await p.screenshot({ path: join(OUT, "dark-mode.png") });
  await p.close();
  console.log("ok dark-mode.png");
}

// 3) HF paper page (live)
try {
  const p = await context.newPage();
  await p.goto("https://huggingface.co/papers/2606.12385", { waitUntil: "domcontentloaded", timeout: 40000 });
  await settle(p, 3);
  await p.screenshot({ path: join(OUT, "article-page.png") });
  await p.close();
  console.log("ok article-page.png");
} catch (e) { console.log("SKIP article-page:", String(e).slice(0, 80)); }

// 4) Google Docs overlay (live)
try {
  const p = await context.newPage();
  await p.goto(`${DOC}/edit?usp=sharing`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await p.waitForTimeout(6000);
  await p.evaluate(() => {
    document.getElementById("pangram-fab")?.shadowRoot?.querySelector("#pangram-action")?.click();
  });
  await p.waitForFunction(
    () => {
      const sr = document.getElementById("pangram-docs-overlay")?.shadowRoot;
      return sr && sr.querySelectorAll('[data-pangram="host"]').length >= 3;
    },
    null, { timeout: 25000 },
  );
  await p.waitForTimeout(1800);
  await p.screenshot({ path: join(OUT, "google-docs-overlay.png") });
  await p.close();
  console.log("ok google-docs-overlay.png");
} catch (e) { console.log("SKIP docs overlay:", String(e).slice(0, 80)); }

// 5) popup (representative wikipedia-tab state, display-only fill)
{
  const p = await context.newPage();
  await p.emulateMedia({ colorScheme: "light" });
  await p.setViewportSize({ width: 300, height: 470 });
  await p.goto(`chrome-extension://${extId}/popup.html`);
  await p.waitForTimeout(600);
  await p.evaluate(() => {
    // Standalone-tab popups cannot see a content tab — restore the exact strings
    // a wikipedia.org tab shows so the shot reflects real use.
    const site = document.getElementById("siteHost");
    if (site) site.textContent = "on en.wikipedia.org";
    const status = document.getElementById("status");
    if (status) {
      const f = document.createElement("span");
      f.className = "flagged";
      f.textContent = "6 flagged";
      status.replaceChildren(document.createTextNode("23 paragraphs analyzed · "), f);
    }
    const siteToggle = document.getElementById("siteEnabled");
    if (siteToggle) { siteToggle.disabled = false; siteToggle.checked = true; }
  });
  await p.waitForTimeout(200);
  await p.screenshot({ path: join(OUT, "popup.png") });
  await p.close();
  console.log("ok popup.png");
}

// 6) triage panel on wikipedia (live; falls back to dark page if offline)
try {
  const p = await context.newPage();
  await p.goto("https://en.wikipedia.org/wiki/Alan_Turing", { waitUntil: "domcontentloaded", timeout: 40000 });
  await settle(p, 4);
  await p.evaluate(() => {
    document.getElementById("pangram-fab")?.shadowRoot?.querySelector(".count")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await p.waitForTimeout(500);
  const clip = { x: 1180 - 560, y: 780 - 560, width: 560, height: 560 };
  await p.screenshot({ path: join(OUT, "triage-panel.png"), clip });
  await p.close();
  console.log("ok triage-panel.png");
} catch (e) { console.log("SKIP triage-panel:", String(e).slice(0, 80)); }

await context.close();
server.close();
console.log("done");
