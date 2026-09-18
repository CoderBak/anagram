// test/shots.mjs — regenerate the README screenshots (docs/screenshots/).
// Live-site shots (Wikipedia, HF, Google Docs) need network; the dark-mode and
// popup shots are fully local.  node test/shots.mjs
import { launchExtension } from "./harness.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "docs", "screenshots");
// Public Google Doc for the overlay shot. The original was deleted (410) in Sept 2026 —
// set ANAGRAM_DOC_URL to a public doc to regenerate google-docs-overlay.png.
const DOC = process.env.ANAGRAM_DOC_URL ?? "https://docs.google.com/document/d/1gRLkVx985SLnysZvrkm8PQolykP-rRWxBtxFoywXXRo";
const docAlive = await fetch(`${DOC}/mobilebasic`, { signal: AbortSignal.timeout(15000) }).then((r) => r.status === 200, () => false);

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

// A light article page mixing verdicts (human / lightly edited / AI) so the triage
// panel has something to list without depending on a live site.
const MIXED_PAGE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { background:#fff; color:#1f2328; font:17px/1.75 Georgia, serif; max-width:720px; margin:48px auto; padding:0 24px; }
  h1 { font:700 28px/1.3 system-ui, sans-serif; margin-bottom:4px; }
  .byline { color:#656d76; font:13px system-ui, sans-serif; margin-bottom:28px; }
</style></head><body>
  <h1>Notes on a Call, a Flat, and a Writing Habit</h1>
  <div class="byline">A mixed-authorship reading demo</div>
  <p>I got the call around six, right when the rice was starting to catch on the bottom of the pan. My brother
     never rings on weeknights, so I turned the burner off and sat on the floor to listen. He talked for twenty
     minutes about a dog he was thinking of adopting and never mentioned the thing we both knew he had rung to
     say. Afterwards the rice was ruined and I ate it anyway.</p>
  <p>The call came at around six o'clock, precisely as the rice began adhering to the bottom of the pan. Because
     my brother seldom telephones on weeknights, I switched off the burner and settled onto the floor to listen
     attentively. For twenty minutes he discussed a dog he was contemplating adopting, carefully avoiding the
     matter we both understood to be the true reason for his call. By the end, the rice was beyond saving,
     though I consumed it regardless.</p>
  <p>Our tenancy began in March, at a time when the radiators produced nightly clanking sounds and the landlord
     repeatedly assured us that a plumber would arrive, though none ever materialized. The kitchen window faced
     a brick wall situated a mere six feet away; however, by leaning out sufficiently, one could glimpse a narrow
     section of the canal, where, on favorable mornings, a heron stood with a proprietary air. We remained there
     for four years, and the memory of that heron persists to this day.</p>
  <p>Building a consistent writing habit is one of the most valuable investments you can make in your personal
     and professional development. Start by setting aside a dedicated time each day, even if it's just fifteen
     minutes, and create a distraction-free environment that allows you to focus. Remember that progress matters
     more than perfection, so embrace imperfect drafts and celebrate small wins along the way. Over time, these
     small, intentional steps compound into meaningful growth.</p>
</body></html>`;

const server = http.createServer((q, r) => {
  r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  r.end(q.url?.startsWith("/mixed") ? MIXED_PAGE : DARK_PAGE);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const darkUrl = `http://localhost:${server.address().port}/dark.html`;
const mixedUrl = `http://localhost:${server.address().port}/mixed.html`;

const { context, extId } = await launchExtension({ viewport: { width: 1180, height: 780 } });

async function settle(page, sweeps = 6) {
  await page.waitForSelector('[data-anagram="host"]', { timeout: 15000 }).catch(() => {});
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
    for (const h of document.querySelectorAll('[data-anagram="host"]:not(#anagram-fab)')) {
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
if (!docAlive) console.log("SKIP docs overlay: the test document is gone (HTTP != 200) — set ANAGRAM_DOC_URL");
else try {
  const p = await context.newPage();
  await p.goto(`${DOC}/edit?usp=sharing`, { waitUntil: "domcontentloaded", timeout: 45000 });
  await p.waitForTimeout(6000);
  await p.evaluate(() => {
    document.getElementById("anagram-fab")?.shadowRoot?.querySelector("#anagram-action")?.click();
  });
  await p.waitForFunction(
    () => {
      const sr = document.getElementById("anagram-docs-overlay")?.shadowRoot;
      return sr && sr.querySelectorAll('[data-anagram="host"]').length >= 3;
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

// 6) triage panel on the local mixed-authorship page (deterministic; real model → flagged items)
try {
  const p = await context.newPage();
  await p.goto(mixedUrl, { waitUntil: "load" });
  await settle(p, 2);
  await p.evaluate(() => {
    document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")
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
