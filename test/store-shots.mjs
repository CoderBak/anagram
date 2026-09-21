// test/store-shots.mjs — the listing screenshots, at the size the Chrome Web Store takes.
//
// The store accepts 1280x800 or 640x400 and nothing else. `docs/screenshots/` are the
// README's, taken at 1180x780 and 300x470, so not one of them can be uploaded
// (docs/store-listing.md says so under "Still to be produced"). These are the store's:
// five PNGs at exactly 1280x800, device pixel ratio 1, in `docs/store/`.
//
//   node test/store-shots.mjs
//
// Local and deterministic from end to end: the TEST build, the fake fixture — whose
// verdicts are a pure function of the paragraph text, so the same chips carry the same
// numbers on every run — and fixtures from test/fixtures and test/pdf-fixture.mjs. No
// real fixture is contacted, no site on the internet is opened, and nothing here runs a
// browser with a window.
//
// The five, in the order a reader would meet them:
//   1-article    an article being read, chips at rest
//   2-card       the same page with one flagged chip's card open
//   3-panel      the flagged-paragraph panel
//   4-pdf        a PDF in the reading mode, chips on the real page
//   5-first-run  the page a new install opens
//
// RE-RUN THIS after any change to the popup, the first-run page or the chip's own look:
// a screenshot is the one piece of documentation that goes stale without anybody noticing.
//
// One judgement call is left open on purpose. The article is the Substack fixture, whose
// body text was written to exercise the walker rather than to be read — plausible at a
// glance, odd if a reviewer stops on a sentence. Swapping ARTICLE_HTML for a page of real
// prose is a content decision for whoever fills in the listing, not a code one.
import { withFakeNative, sweep, BADGE_SEL } from "./harness.mjs";
import { servePdfs, openPdfInReader } from "./pdf-fixture.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync, readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, "..", "docs", "store");
mkdirSync(OUT, { recursive: true });

/** What the store takes. deviceScaleFactor 1 because 2 would make it 2560x1600. */
const VIEWPORT = { width: 1280, height: 800 };

const shot = async (page, name) => {
  await page.screenshot({ path: join(OUT, `${name}.png`) });
  console.log(`ok  docs/store/${name}.png`);
};

/** Scroll the page through once and wait for every chip to have an answer. */
async function settle(page, { chips = 1 } = {}) {
  await page.waitForSelector(BADGE_SEL, { timeout: 20000 }).catch(() => {});
  await sweep(page, 4, 300);
  await page
    .waitForFunction(
      ({ sel, want }) => {
        const hosts = [...document.querySelectorAll(sel)];
        return hosts.length >= want && hosts.every((h) => !h.shadowRoot?.querySelector(".pill.pending"));
      },
      { sel: BADGE_SEL, want: chips },
      { timeout: 30000 },
    )
    .catch(() => {});
  // The chips animate in; nothing is photographed mid-transition.
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running")).catch(() => {});
  await page.waitForTimeout(400);
}

const { context, extId, fixture } = await withFakeNative({ viewport: VIEWPORT, deviceScaleFactor: 1 });

// ---- 1-3: an article, its card, its panel -------------------------------------------------
//
// The Substack fixture, because it is the shape a reader recognises: one long post, a
// column of ordinary paragraphs, a byline and a subscribe box. Its short paragraphs are
// read together with their neighbours, so some chips carry the "×2" this product is
// partly about, and its text puts one of each of the four verdicts on the page.
//
// It is served at a name rather than at localhost: the panel's last line offers to turn
// the site off BY HOST, and "Turn off on localhost" in a store screenshot says nothing to
// anybody. The address is answered from this process — Playwright never lets the request
// leave — so no DNS is consulted and nothing on the internet is opened.
const ARTICLE_URL = "https://estuary-press.example/ferry-timetable";
const ARTICLE_HTML = readFileSync(join(__dirname, "fixtures", "substack-article.html"), "utf8");
await context.route("https://estuary-press.example/**", (route) =>
  route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body: ARTICLE_HTML }),
);
{
  const page = await context.newPage();
  await page.goto(ARTICLE_URL, { waitUntil: "load" });
  await settle(page, { chips: 6 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  await shot(page, "1-article");

  // The card of a FLAGGED paragraph — heavily edited or AI-generated, the two bands the
  // panel lists. The page is scrolled so that chip sits in the upper third, because the
  // card opens below it and a card cut off by the bottom edge is not a screenshot.
  const placed = await page.evaluate((sel) => {
    let best = null;
    let bestScore = -1;
    for (const host of document.querySelectorAll(sel)) {
      const pill = host.shadowRoot?.querySelector(".pill");
      if (!pill || !/band-(heavy|ai)/.test(pill.className)) continue;
      const score = parseFloat(host.shadowRoot.querySelector(".num")?.textContent ?? "");
      if (Number.isFinite(score) && score > bestScore) {
        bestScore = score;
        best = host;
      }
    }
    if (!best) return null;
    window.scrollBy(0, best.getBoundingClientRect().top - window.innerHeight * 0.3);
    return bestScore;
  }, BADGE_SEL);
  if (placed === null) console.log("SKIP 2-card: the page produced no flagged chip");
  else {
    await page.waitForTimeout(500);
    await page.evaluate((sel) => {
      const shown = [...document.querySelectorAll(sel)].find((h) => {
        const pill = h.shadowRoot?.querySelector(".pill");
        const box = h.getBoundingClientRect();
        return pill && /band-(heavy|ai)/.test(pill.className) && box.top > 100 && box.top < window.innerHeight * 0.45;
      });
      shown?.click();
    }, BADGE_SEL);
    await page.waitForTimeout(600);
    await shot(page, "2-card");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
  }

  // The panel: the ball's counter opens it. It lists the flagged paragraphs and jumps to
  // them, which is the thing the listing text calls triage.
  const panel = await page.evaluate(() => {
    const count = document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count");
    if (!count) return false;
    count.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    return true;
  });
  if (!panel) console.log("SKIP 3-panel: the ball's counter never appeared");
  else {
    await page.waitForTimeout(700);
    await shot(page, "3-panel");
  }
  await page.close();
}

// ---- 4: a PDF in the reading mode ---------------------------------------------------------
//
// The real pages, drawn by pdf.js, with the chips over them — the same document the PDF
// suites read, so what is in the picture is text somebody can check.
{
  const pdfs = await servePdfs();
  const page = await openPdfInReader(context, pdfs.url("/doc.pdf"));
  if (!/reader\.html/.test(page.url())) console.log("SKIP 4-pdf: the reading mode did not open");
  else {
    await settle(page, { chips: 2 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);
    await shot(page, "4-pdf");
  }
  await page.close();
  await pdfs.close();
}

// ---- 5: the first-run page ----------------------------------------------------------------
//
// What a new install opens. Its three rows follow the fixture live, and the fake one is
// running here, so it is photographed in the state a working install is in.
if (!extId) console.log("SKIP 5-first-run: no extension id");
else {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/onboarding.html`, { waitUntil: "load" });
  await page
    .waitForFunction(() => document.getElementById("row-ready")?.dataset.state === "ok", null, { timeout: 15000 })
    .catch(() => {});
  await page.waitForTimeout(400);
  await shot(page, "5-first-run");
  await page.close();
}

await context.close();
await fixture.close();
console.log(`\ndone — docs/store/ (1280x800, dpr 1). ${fixture.stats.requests} scoring requests went to the fake fixture.`);
