// test/scenarios.mjs — the wide-net scenario matrix.
//
// Phase A (deterministic, local): UI behaviours on test/ui-fixtures.html —
// edge-aware hover card (top/right), RTL placement, font scaling, layout-shift
// bound, shadow DOM + slot capture, overflow containers, copy hygiene,
// badge-after-link isolation, per-anchor dark theme, duplicate fan-out.
//
// Phase B (live, soft): real-site sweep with per-site expectations — HF paper
// (the original bug), EN/AR/JA Wikipedia, MDN, paulgraham, arXiv, StackOverflow,
// GitHub, a text/plain RFC, and zero-badge aggregator pages. A site that fails
// to LOAD is SKIP (network flake), but a loaded site violating its expectation
// is FAIL. Only console errors originating from the extension count against us.
//
//   node test/scenarios.mjs            # full matrix
//   node test/scenarios.mjs --local    # phase A only
import { chromium } from "playwright";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));
const EXT = join(__dirname, "..", "output", "chrome-mv3");
const BADGE_SEL = '[data-anagram="host"]:not(#anagram-fab)';
const LOCAL_ONLY = process.argv.includes("--local");

if (!existsSync(join(EXT, "manifest.json"))) {
  console.error("Build first: npm run build");
  process.exit(2);
}

const results = []; // { phase, name, status: PASS|FAIL|SKIP, note }
const record = (phase, name, ok, note = "") =>
  results.push({ phase, name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note });

// ---- server for the fixture page ----------------------------------------------------
const fixturesHtml = readFileSync(join(__dirname, "ui-fixtures.html"), "utf8");
const server = http.createServer((_q, r) => {
  r.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  r.end(fixturesHtml);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const fixturesUrl = `http://localhost:${server.address().port}/ui-fixtures.html`;

const context = await chromium.launchPersistentContext("", {
  headless: false,
  viewport: { width: 1280, height: 850 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 }).catch(() => null);
console.log("extension SW:", sw ? "loaded" : "NOT loaded");

async function sweep(page, steps = 6) {
  await page
    .evaluate(async (n) => {
      const step = Math.round(window.innerHeight * 0.8);
      for (let i = 0; i < n; i++) {
        window.scrollBy(0, step);
        await new Promise((r) => setTimeout(r, 300));
      }
      window.scrollTo(0, 0);
    }, steps)
    .catch(() => {});
}

// =====================================================================================
// PHASE A — deterministic UI fixtures
// =====================================================================================
{
  const page = await context.newPage();
  const extErrors = [];
  page.on("console", (m) => {
    const u = m.location()?.url ?? "";
    // chrome-extension://invalid/ is a page-side extension-detection probe (Google
    // Docs does this), not our resource.
    if (m.type() === "error" && u.startsWith("chrome-extension://") && !u.startsWith("chrome-extension://invalid"))
      extErrors.push(m.text().slice(0, 160));
  });
  await page.goto(fixturesUrl, { waitUntil: "load" });
  await page.waitForSelector(BADGE_SEL, { timeout: 12000 }).catch(() => {});
  await sweep(page, 8);
  await page.waitForTimeout(2500);

  // A1: top-edge hover card flips below and stays in-viewport.
  {
    await page.evaluate(() => window.scrollTo(0, 0));
    const badge = page.locator(`#topedge ${BADGE_SEL}`).first();
    let ok = false, note = "no badge";
    if (await badge.count()) {
      await badge.hover();
      await page.waitForTimeout(450);
      const r = await page.evaluate((sel) => {
        const host = document.querySelector(`#topedge ${sel}`);
        const card = host.shadowRoot.querySelector(".card");
        const cr = card.getBoundingClientRect();
        return {
          below: card.classList.contains("below"),
          inViewport:
            cr.top >= 0 && cr.left >= 0 &&
            cr.bottom <= innerHeight && cr.right <= innerWidth,
          visible: getComputedStyle(card).visibility === "visible",
        };
      }, BADGE_SEL);
      ok = r.below && r.inViewport && r.visible;
      note = JSON.stringify(r);
      await page.screenshot({ path: join(__dirname, "scn-card-below.png") });
    }
    record("ui", "hover card flips BELOW at viewport top, fully visible", ok, note);
    await page.mouse.move(5, 400); // unhover
  }

  // A2: right-edge column card stays inside the viewport.
  {
    const badge = page.locator(`#rightcol ${BADGE_SEL}`).first();
    let ok = false, note = "no badge";
    if (await badge.count()) {
      await badge.hover();
      await page.waitForTimeout(450);
      const r = await page.evaluate((sel) => {
        const host = document.querySelector(`#rightcol ${sel}`);
        const cr = host.shadowRoot.querySelector(".card").getBoundingClientRect();
        return { right: Math.round(cr.right), vw: innerWidth, fits: cr.right <= innerWidth + 1 && cr.left >= -1 };
      }, BADGE_SEL);
      ok = r.fits;
      note = JSON.stringify(r);
    }
    record("ui", "hover card pinned inside viewport at right edge", ok, note);
    await page.mouse.move(5, 400);
  }

  // A3: RTL — chip sits at the INLINE END of the last text line: in RTL that
  // means visually to the LEFT of where the last line's text ends, on that line.
  {
    const r = await page.evaluate((sel) => {
      const host = document.querySelector(`#rtl ${sel}`);
      if (!host) return null;
      const range = document.createRange();
      range.selectNodeContents(host.closest("p"));
      range.setEndBefore(host);
      const rects = [...range.getClientRects()].filter((x) => x.width > 1);
      const lastLine = rects[rects.length - 1];
      const hr = host.getBoundingClientRect();
      const sameLine = Math.abs(hr.top + hr.height / 2 - (lastLine.top + lastLine.height / 2)) < lastLine.height;
      const leftOfTextEnd = hr.right <= lastLine.left + 4;
      return {
        badgeRight: Math.round(hr.right),
        textEndLeft: Math.round(lastLine.left),
        sameLine,
        leftOfTextEnd,
      };
    }, BADGE_SEL);
    record("ui", "RTL: chip at inline end of last line (left of text end)", r ? r.sameLine && r.leftOfTextEnd : false, JSON.stringify(r));
  }

  // A4: chip scales with surrounding font size (clamped 9–12px).
  {
    const r = await page.evaluate((sel) => {
      const fs = (scope) => {
        const host = document.querySelector(`${scope} ${sel}`);
        if (!host) return null;
        return parseFloat(getComputedStyle(host.shadowRoot.querySelector(".pill")).fontSize);
      };
      return { tiny: fs("#tiny"), large: fs("#large") };
    }, BADGE_SEL);
    const ok =
      r.tiny !== null && r.large !== null &&
      r.tiny < r.large && r.tiny >= 8.5 && r.large <= 12.5;
    record("ui", "chip font scales with page text (tiny < large, clamped)", ok, JSON.stringify(r));
  }

  // A5: tight line-height — chip height within line box + tolerance.
  {
    const r = await page.evaluate((sel) => {
      const host = document.querySelector(`#tight ${sel}`);
      if (!host) return null;
      const p = host.closest("p");
      const lh = parseFloat(getComputedStyle(p).lineHeight);
      const h = host.shadowRoot.querySelector(".pill").getBoundingClientRect().height;
      return { chipH: Math.round(h * 10) / 10, lineH: Math.round(lh * 10) / 10, fits: h <= lh + 4 };
    }, BADGE_SEL);
    record("ui", "chip does not expand tight line boxes", r ? r.fits : false, JSON.stringify(r));
  }

  // A6: shadow DOM + slotted content both badged (composed traversal).
  {
    const r = await page.evaluate((sel) => {
      const root = document.getElementById("shadowhost")?.shadowRoot;
      const inShadow = root ? root.querySelectorAll(sel).length : -1;
      const slotted = document.querySelectorAll(`#slotted-src ${sel}`).length;
      return { inShadow, slotted };
    }, BADGE_SEL);
    record("ui", "open shadow root paragraph badged", r.inShadow >= 1, JSON.stringify(r));
    record("ui", "slotted light-DOM paragraph badged", r.slotted >= 1, JSON.stringify(r));
  }

  // A7: overflow:hidden container — badge visible inside the box.
  {
    const r = await page.evaluate((sel) => {
      const host = document.querySelector(`#clipbox ${sel}`);
      if (!host) return null;
      const hr = host.getBoundingClientRect();
      const br = document.getElementById("clipbox").getBoundingClientRect();
      return {
        inside: hr.top >= br.top - 1 && hr.bottom <= br.bottom + 1 && hr.right <= br.right + 1,
        visible: hr.width > 0 && hr.height > 0,
      };
    }, BADGE_SEL);
    record("ui", "badge stays visible inside overflow:hidden box", r ? r.inside && r.visible : false, JSON.stringify(r));
  }

  // A8: copy hygiene — clipboard payload excludes the chip's "% AI" label.
  {
    const r = await page.evaluate(async () => {
      const p = document.getElementById("copysrc");
      const range = document.createRange();
      range.selectNodeContents(p);
      const selObj = getSelection();
      selObj.removeAllRanges();
      selObj.addRange(range);
      const selText = selObj.toString();
      let clip = null;
      try {
        document.execCommand("copy");
        clip = await navigator.clipboard.readText();
      } catch {
        /* clipboard permission not granted — selection text is the proxy */
      }
      const probe = clip ?? selText;
      return {
        via: clip !== null ? "clipboard" : "selection",
        hasWords: probe.includes("COPYSRC paragraph exists"),
        leaked: /%\s*AI/.test(probe),
      };
    });
    record("ui", `copy excludes badge text (${r.via})`, r.hasWords && !r.leaked, JSON.stringify(r));
  }

  // A9: badge after a trailing link — outside the anchor; clicking never navigates.
  {
    const r = await page.evaluate((sel) => {
      const host = document.querySelector(`#linkend ${sel}`);
      if (!host) return null;
      const insideLink = !!host.closest("#lastlink");
      host.click();
      return { insideLink, hash: location.hash };
    }, BADGE_SEL);
    record(
      "ui",
      "badge escapes trailing <a>; click does not navigate",
      r ? !r.insideLink && r.hash !== "#never-navigate" : false,
      JSON.stringify(r),
    );
  }

  // A10: per-anchor dark theme — dark card chip dark, following light chip light.
  {
    const r = await page.evaluate((sel) => {
      const darkHost = document.querySelector(`#darksection ${sel}`);
      const lightHost = document.querySelector(`#lightafter ${sel}`);
      return {
        dark: darkHost ? darkHost.classList.contains("pg-dark") : null,
        light: lightHost ? !lightHost.classList.contains("pg-dark") : null,
      };
    }, BADGE_SEL);
    record("ui", "per-anchor dark detection (dark card vs light page)", r.dark === true && r.light === true, JSON.stringify(r));
  }

  // A11: exact duplicates — both badged, identical fanned-out score.
  {
    const r = await page.evaluate((sel) => {
      const hosts = [...document.querySelectorAll(`#dupes ${sel}`)];
      const nums = hosts.map((h) => h.shadowRoot.querySelector(".num").textContent);
      return { count: hosts.length, nums, same: nums.length === 2 && nums[0] === nums[1] };
    }, BADGE_SEL);
    record("ui", "duplicate paragraphs each badged with the same score", r.count === 2 && r.same, JSON.stringify(r));
  }

  // A12: KaTeX-shaped formula — one unit, duplicated formula text never leaks.
  {
    const r = await page.evaluate((sel) => {
      const badges = document.querySelectorAll(`#katex ${sel}`).length;
      const hl = [];
      if (typeof CSS !== "undefined" && CSS.highlights) {
        for (const h of CSS.highlights.values()) for (const rg of h) hl.push(rg.toString());
      }
      const joined = hl.join(" ");
      return {
        badges,
        tail: joined.includes("KATEXTAIL") || badges === 1,
        dupLeak: joined.includes("KATEXDUP"),
      };
    }, BADGE_SEL);
    record("ui", "KaTeX-style math: one unit, no duplicated formula text", r.badges === 1 && !r.dupLeak, JSON.stringify(r));
  }

  // A13: modal <dialog> — top-layer prose is scored; the FAB rides the top layer
  // as a manual popover where supported.
  {
    await page.locator("#openmodal").scrollIntoViewIfNeeded();
    await page.locator("#openmodal").click();
    const badged = await page
      .waitForFunction(
        (sel) => document.querySelectorAll(`#modal ${sel}`).length >= 1,
        BADGE_SEL,
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false);
    const fabTop = await page.evaluate(() => {
      const fab = document.getElementById("anagram-fab");
      if (!fab) return { supported: false, open: false };
      if (!("showPopover" in fab)) return { supported: false, open: true }; // fallback path OK
      try {
        return { supported: true, open: fab.matches(":popover-open") };
      } catch {
        return { supported: true, open: false };
      }
    });
    await page.locator("#closemodal").click();
    record("ui", "paragraph inside showModal dialog badged", badged, "");
    record("ui", "FAB promoted to top layer (popover)", fabTop.open, JSON.stringify(fabTop));
  }

  // A14: vertical writing mode — unit collected, chip present, column flow intact.
  {
    const r = await page.evaluate((sel) => {
      const host = document.querySelector(`#vertical ${sel}`);
      if (!host) return null;
      const box = host.closest("div").getBoundingClientRect();
      const hr = host.getBoundingClientRect();
      return { present: true, inside: hr.left >= box.left - 30 && hr.right <= box.right + 30 };
    }, BADGE_SEL);
    record("ui", "vertical-rl (Japanese) paragraph badged in-flow", !!r && r.present && r.inside, JSON.stringify(r));
  }

  // A15: "analyzing…" chips are transient — they must all DRAIN into verdicts.
  {
    const drained = await page
      .waitForFunction(
        (sel) => {
          for (const h of document.querySelectorAll(sel)) {
            if (h.shadowRoot?.querySelector(".pill.pending")) return false;
          }
          return true;
        },
        BADGE_SEL,
        { timeout: 6000 },
      )
      .then(() => true)
      .catch(() => false);
    record("ui", "pending chips all drain into verdicts", drained, "");
  }

  // A16: hover card v2 — interval meter + Copy text action; copy puts the
  // paragraph (not the chip label) on the clipboard.
  {
    await page.locator("#copysrc").scrollIntoViewIfNeeded();
    const badge = page.locator(`#copysrc ${BADGE_SEL}`).first();
    let ok = false, note = "no badge";
    if (await badge.count()) {
      await badge.hover();
      await page.waitForTimeout(420);
      const parts = await page.evaluate((sel) => {
        const host = document.querySelector(`#copysrc ${sel}`);
        const card = host?.shadowRoot?.querySelector(".card");
        if (!card) return null;
        const meter = !!card.querySelector(".meter .fill");
        const btn = card.querySelector(".act.copy");
        if (btn) btn.click();
        return { meter, hasCopy: !!btn };
      }, BADGE_SEL);
      await page.waitForTimeout(250);
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
      ok =
        !!parts && parts.meter && parts.hasCopy &&
        (clip === null || (clip.includes("COPYSRC paragraph exists") && !/%\s*AI/.test(clip)));
      note = JSON.stringify({ ...parts, clip: clip?.slice(0, 40) });
    }
    record("ui", "hover card: interval meter + working Copy text action", ok, note);
    await page.mouse.move(5, 400);
  }

  // A17: triage panel — opens from the counter, filter chips appear when both
  // verdict bands exist, and filtering narrows the list.
  {
    const r = await page.evaluate(() => {
      const fab = document.getElementById("anagram-fab");
      const sr = fab?.shadowRoot;
      sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const panel = sr?.querySelector(".panel");
      const open = !!panel?.classList.contains("open");
      const items = panel?.querySelectorAll(".pitem").length ?? 0;
      const chips = [...(panel?.querySelectorAll(".fchip") ?? [])].map((c) => c.textContent);
      let filtered = -1;
      const aiChip = [...(panel?.querySelectorAll(".fchip") ?? [])].find((c) => c.textContent.startsWith("AI"));
      if (aiChip) {
        aiChip.click();
        filtered = sr.querySelectorAll(".panel .pitem:not(.band-ai)").length;
      }
      // close it again
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      return { open, items, chips, filtered };
    });
    const filterOk = r.chips.length === 0 || r.filtered === 0;
    record("ui", "triage panel opens; verdict filters narrow the list", r.open && r.items > 0 && filterOk, JSON.stringify(r));
  }

  // A18: FAB drag → snaps to the nearest edge and remembers the side.
  {
    const ball = page.locator("#anagram-fab .fab").first();
    await ball.hover().catch(() => {}); // untuck first — a tucked ball sits half off-screen
    await page.waitForTimeout(350);
    const box = await ball.boundingBox();
    let r = null;
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(140, 300, { steps: 8 }); // drop near the LEFT edge
      await page.mouse.up();
      await page.waitForTimeout(400);
      r = await page.evaluate(() => {
        const stack = document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".stack");
        return {
          left: stack?.style.left,
          sideLeft: stack?.classList.contains("side-left"),
        };
      });
    }
    record("ui", "FAB snaps to the left edge after drag", !!r && r.left === "12px" && r.sideLeft, JSON.stringify(r));
  }

  // A19: idle tuck — the ball slides half off the edge after a few seconds and
  // returns on hover.
  {
    await page.mouse.move(600, 300); // pointer far away, no interactions
    await page.waitForTimeout(4300);
    const tucked = await page.evaluate(
      () => !!document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".stack.tucked"),
    );
    const ball = page.locator("#anagram-fab .fab").first();
    await ball.hover().catch(() => {});
    await page.waitForTimeout(350);
    const untucked = await page.evaluate(
      () => !document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".stack.tucked"),
    );
    record("ui", "FAB tucks when idle and returns on hover", tucked && untucked, JSON.stringify({ tucked, untucked }));
  }

  record("ui", "no extension console errors on fixtures", extErrors.length === 0, extErrors.join(" | "));
  await page.screenshot({ path: join(__dirname, "scn-ui-fixtures.png"), fullPage: true });
  await page.close();
}

// =====================================================================================
// PHASE B — live sites (soft: unreachable → SKIP; loaded-but-wrong → FAIL)
// =====================================================================================
const LIVE = [
  { name: "hf-paper", url: "https://huggingface.co/papers/2606.12385", min: 3, chromeMax: 0 },
  { name: "wiki-en", url: "https://en.wikipedia.org/wiki/Alan_Turing", min: 10, chromeMax: 0 },
  { name: "wiki-ar-rtl", url: "https://ar.wikipedia.org/wiki/%D8%A2%D9%84%D8%A7%D9%86_%D8%AA%D9%88%D8%B1%D9%86%D8%BA", min: 3 },
  { name: "wiki-ja-cjk", url: "https://ja.wikipedia.org/wiki/%E3%82%A2%E3%83%A9%E3%83%B3%E3%83%BB%E3%83%81%E3%83%A5%E3%83%BC%E3%83%AA%E3%83%B3%E3%82%B0", min: 3 },
  { name: "mdn", url: "https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview", min: 5, chromeMax: 0 },
  { name: "paulgraham", url: "https://www.paulgraham.com/greatwork.html", min: 50 },
  { name: "arxiv-abs", url: "https://arxiv.org/abs/2301.10226", min: 1 },
  { name: "stackoverflow", url: "https://stackoverflow.com/questions/11227809/why-is-processing-a-sorted-array-faster-than-processing-an-unsorted-array", min: 1, noPre: true },
  { name: "github-readme", url: "https://github.com/nodejs/node", min: 1, noPre: true },
  { name: "rfc-txt", url: "https://www.rfc-editor.org/rfc/rfc768.txt", min: 1 },
  { name: "samaltman-blog", url: "https://blog.samaltman.com/", min: 1 },
  { name: "hackernews-zero", url: "https://news.ycombinator.com/", max: 0 },
  { name: "bbc-near-zero", url: "https://www.bbc.com/news", max: 2 },
];

if (!LOCAL_ONLY) {
  for (const site of LIVE) {
    const page = await context.newPage();
    const extErrors = [];
    page.on("console", (m) => {
      const u = m.location()?.url ?? "";
      if (m.type() === "error" && u.startsWith("chrome-extension://") && !u.startsWith("chrome-extension://invalid"))
        extErrors.push(m.text().slice(0, 140));
    });
    let loaded = true;
    try {
      await page.goto(site.url, { waitUntil: "domcontentloaded", timeout: 30000 });
    } catch {
      loaded = false;
    }
    if (!loaded) {
      record("live", site.name, null, "goto failed — network/flake");
      await page.close();
      continue;
    }
    await page.waitForSelector(BADGE_SEL, { timeout: 10000 }).catch(() => {});
    // Lazy sections (HF community comments) need a patient sweep + settle.
    await sweep(page, 6);
    await page.waitForTimeout(3200);

    const stats = await page
      .evaluate((sel) => {
        const hosts = [...document.querySelectorAll(sel)];
        const anchors = hosts.map((h) => h.parentElement).filter(Boolean);
        let chrome = 0;
        let inPre = 0;
        for (const el of anchors) {
          if (el.closest("nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo]")) chrome++;
          if (el.closest("pre")) inPre++;
        }
        return { badges: hosts.length, chrome, inPre, sample: (anchors[0]?.textContent ?? "").trim().replace(/\s+/g, " ").slice(0, 60) };
      }, BADGE_SEL)
      .catch(() => null);

    await page.screenshot({ path: join(__dirname, `scn-${site.name}.png`) }).catch(() => {});
    if (!stats) {
      record("live", site.name, null, "evaluate failed");
      await page.close();
      continue;
    }

    let ok = true;
    const notes = [`badges=${stats.badges}`, `chrome=${stats.chrome}`];
    if (site.min !== undefined && stats.badges < site.min) ok = false;
    if (site.max !== undefined && stats.badges > site.max) ok = false;
    if (site.chromeMax !== undefined && stats.chrome > site.chromeMax) ok = false;
    if (site.noPre && stats.inPre > 0) { ok = false; notes.push(`inPre=${stats.inPre}`); }
    if (extErrors.length > 0) { ok = false; notes.push(`extErrors=${extErrors.length}`); }
    if (stats.sample) notes.push(`“${stats.sample}”`);
    record("live", site.name, ok, notes.join("  "));
    await page.close();
  }
}

// ---- summary -------------------------------------------------------------------------
await context.close();
server.close();

console.log("\n=== SCENARIO RESULTS ===");
for (const r of results) {
  console.log(`${r.status.padEnd(4)}  [${r.phase}]  ${r.name}${r.note ? `  —  ${r.note}` : ""}`);
}
const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
console.log(`\n${results.length - fails.length - skips.length} pass / ${fails.length} fail / ${skips.length} skip`);
console.log(fails.length === 0 ? "✅ SCENARIOS GREEN" : "❌ SCENARIO FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
