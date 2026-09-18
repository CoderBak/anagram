// test/scenarios.mjs — the wide-net scenario matrix.
//
// Phase A (deterministic, local): UI behaviours on test/ui-fixtures.html —
// edge-aware hover card (top/right), RTL placement, font scaling, layout-shift
// bound, shadow DOM + slot capture, overflow containers, copy hygiene,
// badge-after-link isolation, per-anchor dark theme, duplicate fan-out — plus
// keyboard-only access to the triage panel and its commands on /keyboard.html,
// and a cross-origin no-referrer subframe obeying the top page's site rule.
//
// Phase B (live, soft): real-site sweep with per-site expectations — HF paper
// (the original bug), EN/AR/JA Wikipedia, MDN, paulgraham, arXiv, StackOverflow,
// GitHub, a text/plain RFC, and zero-badge aggregator pages. A site that fails
// to LOAD is SKIP (network flake), but a loaded site violating its expectation
// is FAIL. Only console errors originating from the extension count against us.
//
//   node test/scenarios.mjs            # full matrix
//   node test/scenarios.mjs --local    # phase A only
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { launchExtension, serveHtml, artifact, BADGE_SEL } from "./harness.mjs";
import { startFakeDaemon } from "./fake-daemon.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCAL_ONLY = process.argv.includes("--local");

const results = []; // { phase, name, status: PASS|FAIL|SKIP, note }
const record = (phase, name, ok, note = "") =>
  results.push({ phase, name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note });

// ---- fake daemon (deterministic verdicts) + server for the fixture page -------------
// Texts carrying the stall marker are answered only after STALL_MS — long enough to
// hold a selection card in its "Analyzing…" state while the test acts on it. Every
// other request keeps the daemon's ordinary latency.
const STALL_MARKER = "SLOWPOKE";
const STALL_MS = 4000;
const DAEMON_OPTS = { delayFor: (text) => (text.includes(STALL_MARKER) ? STALL_MS : null) };
let daemon = await startFakeDaemon(DAEMON_OPTS);
const daemonPort = daemon.port;
const PARA = (tag) => `${tag} paragraph is long enough to be scored on its own because it carries well over fifty ordinary English words describing nothing in particular except the fact that a self-rewriting page must still end up with chips after it replaces its own document element, which is what legacy challenge pages and some old single-page frameworks do.`;
const REWRITE_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>rewrite fixture</title></head><body>
<p>Interstitial: checking your browser, please wait…</p>
<script>
  setTimeout(() => {
    document.open();
    document.write('<!doctype html><html><head><meta charset="utf-8"><title>rewritten</title></head><body><main><p id="rw1">${PARA("REWRITTEN-ONE")}</p><p id="rw2">${PARA("REWRITTEN-TWO")}</p></main></body></html>');
    document.close();
  }, 1500);
</script></body></html>`;
// Scope fixture: an article region both the text-mass probe and Readability land on,
// plus a long paragraph OUTSIDE it carrying a marker word. Under "Main content only"
// that paragraph must never be chipped and its text must never reach the daemon.
const SCOPE_MARKER = "ZORBLAX";
const OUTSIDE_PARA = `${SCOPE_MARKER} sits in a block outside the article region, and it is deliberately long enough to clear the evidence floor on its own, with well over sixty ordinary English words in it, so that nothing except the analysis scope can explain its absence: if the first scan ran under the default whole-page setting, this sentence would have been dispatched to the scoring daemon long before the stored setting ever arrived.`;
const SCOPE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>scope fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<main id="article"><h1>The article region</h1>
<p id="s1">${PARA("SCOPED-ONE")}</p>
<p id="s2">${PARA("SCOPED-TWO")}</p>
<p id="s3">${PARA("SCOPED-THREE")}</p></main>
<div id="offmain"><p id="s4">${OUTSIDE_PARA}</p></div>
</body></html>`;
// Stall fixture: the marker text sits in a <textarea>, which passive capture never
// scores — so the only request it can ever produce is the selection card's own, and
// no cached verdict can rob that card of its "Analyzing…" state.
const STALL_TEXT = `${STALL_MARKER} is the marker word this selection carries so the fake daemon knows to hold its answer back for a few seconds, which is exactly the state the close button used to be dead in: the request is in flight, the card says it is analyzing, and the one listener that could dismiss it had not been attached yet, because attaching it was the last statement of the function.`;
const STALL_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>stall fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<h1>Selection while the daemon stalls</h1>
<textarea id="draft" style="width:100%;height:150px">${STALL_TEXT}</textarea>
</body></html>`;
// Keyboard fixture: four paragraphs whose seeded verdicts all land in a FLAGGED band
// (fake-daemon's fakeScore is a pure function of the text — these markers were chosen
// for it), spread far enough apart that "the next one" is a real scroll. Nothing else
// on the page carries words, so no short run can merge into a paragraph and change the
// text the verdict is seeded from. The 900 px lead-in puts every paragraph BELOW the
// viewport's middle at scroll 0, which is what makes "previous" wrap to the last one.
const KEY_PARA = (tag) => `${tag} paragraph is long enough to be scored on its own because it carries well over fifty ordinary English words describing nothing in particular except the fact that a keyboard user must be able to walk the flagged paragraphs of a page without ever reaching for a mouse, which is what the next and previous commands are for.`;
const KEY_TAGS = ["FLAG-1", "FLAG-4", "FLAG-5", "FLAG-7"];
const KEYS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>keyboard fixture</title></head><body style="max-width:720px;margin:0 auto;font:15px/1.6 system-ui">
<div style="height:900px"></div>
${KEY_TAGS.map((t, i) => `<p id="k${i + 1}">${KEY_PARA(t)}</p>\n<div style="height:700px"></div>`).join("\n")}
</body></html>`;
// Frame fixture: the embedded page is served from 127.0.0.1 while its host page is on
// localhost — a different origin, so the frame cannot read window.top — and the embed
// forbids the referrer, which used to leave the frame keyed on its OWN hostname and
// therefore deaf to the rule written for the page it sits in.
const FRAME_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>framed article</title></head><body style="margin:12px;font:15px/1.6 system-ui">
<p id="fp">${PARA("FRAMED")}</p></body></html>`;
const PAGES = {
  "/ui-fixtures.html": readFileSync(join(__dirname, "ui-fixtures.html"), "utf8"),
  "/rewrite.html": REWRITE_HTML,
  "/scope.html": SCOPE_HTML,
  "/stall.html": STALL_HTML,
  "/keyboard.html": KEYS_HTML,
  "/frame.html": FRAME_HTML,
};
const server = await serveHtml(PAGES);
// The host page can only be written once the port is known; the server reads PAGES per
// request, so adding it here is enough.
PAGES["/frame-top.html"] = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>frame host</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<p id="topp">${PARA("FRAMEHOST")}</p>
<iframe id="embed" src="${server.base.replace("localhost", "127.0.0.1")}/frame.html" referrerpolicy="no-referrer" width="640" height="320" style="border:1px solid #ccc"></iframe>
</body></html>`;
const fixturesUrl = server.url("/ui-fixtures.html");

const { context, sw } = await launchExtension({ backendUrl: daemon.url });
await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
console.log("extension SW:", sw ? "loaded" : "NOT loaded", "· fake daemon at", daemon.url);

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
      await page.screenshot({ path: artifact("scn-card-below.png") });
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

  // A6b: content appended INSIDE the open shadow root after the first scan is still
  // picked up (the MutationObserver watches each discovered root, not just the document).
  {
    const before = await page.evaluate((sel) => document.getElementById("shadowhost")?.shadowRoot?.querySelectorAll(sel).length ?? -1, BADGE_SEL);
    await page.evaluate(() => {
      const root = document.getElementById("shadowhost").shadowRoot;
      const p = document.createElement("p");
      p.id = "shadow-late";
      p.textContent = "SHADOWLATE paragraph was appended into the open shadow root well after the " +
        "initial scan finished, and it must still receive a badge because the observer has to " +
        "watch mutations inside every shadow root the walker descended into, not only the light " +
        "document tree where a subtree observer on the root element never sees this change.";
      root.querySelector("div").appendChild(p);
    });
    const ok = await page
      .waitForFunction(({ sel, n }) => (document.getElementById("shadowhost")?.shadowRoot?.querySelectorAll(sel).length ?? 0) > n, { sel: BADGE_SEL, n: before }, { timeout: 6000 })
      .then(() => true)
      .catch(() => false);
    record("ui", "paragraph appended inside a shadow root after the scan is badged", ok, `before=${before}`);
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

  // A7b: the HOVER CARD escapes the overflow:hidden box (top layer). The card must
  // extend outside the clip box and still be the element under the pointer there.
  {
    const badge = page.locator(`#clipbox ${BADGE_SEL}`).first();
    let ok = false, note = "no badge";
    if (await badge.count()) {
      await badge.scrollIntoViewIfNeeded();
      await badge.hover();
      await page.waitForTimeout(450);
      const r = await page.evaluate((sel) => {
        const host = document.querySelector(`#clipbox ${sel}`);
        const card = host.shadowRoot.querySelector(".card");
        const cr = card.getBoundingClientRect();
        const br = document.getElementById("clipbox").getBoundingClientRect();
        const outsideY = cr.top < br.top - 4 ? cr.top + 6 : cr.bottom > br.bottom + 4 ? cr.bottom - 6 : null;
        const hit = outsideY === null ? null : document.elementFromPoint(cr.left + cr.width / 2, outsideY);
        return {
          topLayer: card.matches(":popover-open"),
          extendsOutsideBox: outsideY !== null,
          paintedOutsideBox: hit === host, // retargeted to our host, not the page element behind
          visible: getComputedStyle(card).visibility === "visible",
        };
      }, BADGE_SEL);
      ok = r.topLayer && r.extendsOutsideBox && r.paintedOutsideBox && r.visible;
      note = JSON.stringify(r);
    }
    record("ui", "hover card escapes overflow:hidden (top layer)", ok, note);
    await page.mouse.move(5, 400);
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
        leaked: /\b\d{1,3}%/.test(probe),
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

  // A10b: CSS Color 4 background (oklch) — computed style is not rgb(); still dark.
  {
    const r = await page.evaluate((sel) => {
      const host = document.querySelector(`#oklchdark ${sel}`);
      return {
        computedBg: getComputedStyle(document.getElementById("oklchdark")).backgroundColor,
        dark: host ? host.classList.contains("pg-dark") : null,
      };
    }, BADGE_SEL);
    record("ui", "oklch() background classified dark (CSS Color 4 parsing)", r.dark === true, JSON.stringify(r));
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

  // A12: KaTeX-shaped formula — ONE single-part unit (the formula never splits the
  // sentence), the formula counted in the card, and the unit text (Copy text) free of
  // the duplicated visual/accessible formula copies.
  {
    await page.locator("#katex").scrollIntoViewIfNeeded();
    const badge = page.locator(`#katex ${BADGE_SEL}`).first();
    let r = { badges: await badge.count() };
    if (r.badges === 1) {
      await badge.hover();
      await page.waitForTimeout(420);
      const info = await page.evaluate((sel) => {
        const host = document.querySelector(`#katex ${sel}`);
        const sr = host?.shadowRoot;
        const rows = [...(sr?.querySelectorAll(".card .row") ?? [])].map((x) => x.textContent);
        sr?.querySelector(".act.copy")?.click();
        return { num: sr?.querySelector(".num")?.textContent ?? "", formulasRow: rows.find((t) => t.startsWith("Formulas omitted")) ?? null };
      }, BADGE_SEL);
      await page.waitForTimeout(250);
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
      r = { ...r, ...info, singlePart: !/×/.test(info.num), dupLeak: clip === null ? null : clip.includes("KATEXDUP"), tail: clip === null ? null : clip.includes("KATEXTAIL") };
      await page.mouse.move(5, 400);
    }
    record("ui", "KaTeX-style math: one single-part unit, formula counted, no duplicated formula text", r.badges === 1 && r.singlePart && r.formulasRow === "Formulas omitted1" && r.dupLeak !== true && r.tail !== false, JSON.stringify(r));
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

  // A13b: a site overlay covers the chips behind it (a chip is part of its paragraph,
  // never floating chrome), while our own ball keeps riding the top layer. Before the
  // fix every chip on the page bled THROUGH such overlays — Zhihu's comment sheet showed
  // the article's chips scattered across it.
  {
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.locator("#openoverlay").scrollIntoViewIfNeeded();
    const r = await page.evaluate((sel) => {
      // Hit-test the centre of the on-screen part: an idle-tucked ball hangs half off
      // the edge, and a raw centre would fall outside the viewport.
      const centreHit = (el) => {
        const b = el.getBoundingClientRect();
        const x = (Math.max(b.left, 0) + Math.min(b.right, innerWidth - 1)) / 2;
        const y = (Math.max(b.top, 0) + Math.min(b.bottom, innerHeight - 1)) / 2;
        return document.elementFromPoint(x, y);
      };
      const inView = [...document.querySelectorAll(sel)].filter((h) => {
        const r = h.getBoundingClientRect();
        return r.width > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
      });
      const before = inView.filter((h) => centreHit(h) === h).length;
      document.getElementById("openoverlay").click();
      const overlay = document.getElementById("siteoverlay");
      // The panel's own children answer the hit-test where they sit, so "covered" means
      // the overlay or anything inside it — anything but the chip.
      const covered = inView.filter((h) => overlay.contains(centreHit(h))).length;
      const fab = document.getElementById("anagram-fab");
      const ball = fab?.shadowRoot?.querySelector(".fab");
      const fabOnTop = ball ? centreHit(ball) === fab : null;
      document.getElementById("closeoverlay").click();
      return { chipsInView: inView.length, hitBefore: before, coveredByOverlay: covered, fabOnTop };
    }, BADGE_SEL);
    const ok = r.chipsInView > 0 && r.hitBefore === r.chipsInView && r.coveredByOverlay === r.chipsInView && r.fabOnTop === true;
    record("ui", "a site overlay covers the chips behind it; the ball stays above (top layer)", ok, JSON.stringify(r));
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

  // A15b: a paragraph added while a nearby counter ticks every 80 ms must be badged
  // within a bounded wait — a trailing debounce alone would starve until the ticking stops.
  {
    await page.locator("#churnAdd").scrollIntoViewIfNeeded();
    const t0 = Date.now();
    await page.locator("#churnAdd").click();
    const ok = await page
      .waitForFunction((sel) => document.querySelectorAll(`#churn ${sel}`).length >= 1, BADGE_SEL, { timeout: 3500 })
      .then(() => true)
      .catch(() => false);
    record("ui", "re-scan is not starved by continuous mutation (debounce max-wait)", ok, `${Date.now() - t0} ms`);
  }

  // A16: hover card — 4-bucket distribution bar + Copy text action; copy puts the
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
        const meter = card.querySelectorAll(".dist .dbar .seg").length === 4 && card.querySelectorAll(".dist .drow").length === 4;
        const btn = card.querySelector(".act.copy");
        if (btn) btn.click();
        return { meter, hasCopy: !!btn };
      }, BADGE_SEL);
      await page.waitForTimeout(250);
      const clip = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
      ok =
        !!parts && parts.meter && parts.hasCopy &&
        (clip === null || (clip.includes("COPYSRC paragraph exists") && !/\b\d{1,3}%/.test(clip)));
      note = JSON.stringify({ ...parts, clip: clip?.slice(0, 40) });
    }
    record("ui", "hover card: distribution readout + working Copy text action", ok, note);
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
  await page.screenshot({ path: artifact("scn-ui-fixtures.png"), fullPage: true });
  await page.close();

  // A20: "main content" scope pulls Readability in as an on-demand vendor chunk —
  // import()ed by extension URL from the content script's isolated world (a
  // web-accessible resource). Debug logging on → the orchestrator says so.
  {
    const extId = sw ? new URL(sw.url()).host : null;
    let r = { loaded: false, failed: false, badges: 0 };
    if (extId) {
      const opt = await context.newPage();
      await opt.goto(`chrome-extension://${extId}/options.html`);
      await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({ debug: true, analysisScope: "main" }, res)));
      const p = await context.newPage();
      const logs = [];
      p.on("console", (m) => logs.push(m.text()));
      await p.goto(fixturesUrl, { waitUntil: "load" });
      await p.waitForFunction(() => false, null, { timeout: 2500 }).catch(() => {});
      await p.waitForSelector(BADGE_SEL, { timeout: 10000 }).catch(() => {});
      r = {
        loaded: logs.some((l) => l.includes("Readability chunk loaded")),
        failed: logs.some((l) => l.includes("Readability chunk failed")),
        badges: await p.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL),
      };
      await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({ debug: false, analysisScope: "page" }, res)));
      await p.close();
      await opt.close();
    }
    record("ui", "main-content scope loads the Readability vendor chunk on demand", r.loaded && !r.failed && r.badges > 0, JSON.stringify(r));
  }

  // A22: a page that replaces its own <html> after load (document.open()/write(),
  // as challenge interstitials and legacy frameworks do) — the extension must restart
  // on the new tree: chips on the new paragraphs, ball present, marks painted.
  {
    const p = await context.newPage();
    await p.goto(server.url("/rewrite.html"), { waitUntil: "load" });
    // Settled chips (not the "analyzing…" ones inserted at dispatch) — marks land with the verdict.
    const ok = await p.waitForFunction((sel) => {
      const hosts = [...document.querySelectorAll(`#rw1 ${sel}, #rw2 ${sel}`)];
      return hosts.length === 2 && hosts.every((h) => !h.shadowRoot?.querySelector(".pill.pending")) && !!document.getElementById("anagram-fab") && document.title === "rewritten";
    }, BADGE_SEL, { timeout: 20000 }).then(() => true).catch(() => false);
    const marks = await p.evaluate(() => { let n = 0; for (const h of CSS.highlights.values()) n += h.size; return n; }).catch(() => -1);
    record("ui", "self-rewriting page (document.open/write): chips, ball and marks on the new tree", ok && marks >= 2, JSON.stringify({ ok, marks }));
    await p.close();
  }

  // A21: the daemon goes away → the batch in flight renders "Unavailable", nothing new
  // is dispatched, the ball's counter shows "!"; the daemon comes back → everything is
  // re-queued automatically (no reload, no Rescan).
  {
    const p = await context.newPage();
    await p.goto(fixturesUrl, { waitUntil: "load" });
    await p.waitForSelector(BADGE_SEL, { timeout: 12000 }).catch(() => {});
    const addPara = (id) =>
      p.evaluate((pid) => {
        const el = document.createElement("p");
        el.id = pid;
        el.textContent = `${pid.toUpperCase()} paragraph is appended while the scoring daemon is stopped, so ` +
          "the extension must not invent a verdict for it: the batch that hits the dead socket renders as " +
          "Unavailable and later paragraphs wait without any chip, until a health probe succeeds again and " +
          "every waiting or unavailable unit is queued once more without a reload or a manual rescan.";
        document.querySelector("main").prepend(el);
      }, id);
    const badgeIn = (id, timeout) =>
      p.waitForFunction(({ sel, pid }) => document.querySelectorAll(`#${pid} ${sel}`).length >= 1, { sel: BADGE_SEL, pid: id }, { timeout }).then(() => true).catch(() => false);
    // Settled = past the "analyzing…" state (the pending chip is inserted at dispatch,
    // BEFORE the reply that flips the page into the down state).
    const settledIn = (id, timeout) =>
      p.waitForFunction(({ sel, pid }) => {
        const pill = document.querySelector(`#${pid} ${sel}`)?.shadowRoot?.querySelector(".pill");
        return !!pill && !pill.classList.contains("pending");
      }, { sel: BADGE_SEL, pid: id }, { timeout }).then(() => true).catch(() => false);
    const bandOf = (id) => p.evaluate(({ sel, pid }) => [...(document.querySelector(`#${pid} ${sel}`)?.shadowRoot?.querySelector(".pill")?.classList ?? [])].find((c) => c.startsWith("band-")) ?? null, { sel: BADGE_SEL, pid: id });
    const bubble = () => p.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent ?? null);

    await daemon.close(); // connection refused from here on
    await addPara("down1");
    const gotDown1 = (await badgeIn("down1", 8000)) && (await settledIn("down1", 8000));
    const band1 = await bandOf("down1");
    await addPara("down2");
    await p.waitForTimeout(2000);
    const down2Chips = await p.evaluate((sel) => document.querySelectorAll(`#down2 ${sel}`).length, BADGE_SEL);
    const bubbleDown = await bubble();
    record("ui", "daemon down: in-flight batch renders Unavailable, later paragraphs get no chip, counter shows !", gotDown1 && band1 === "band-unknown" && down2Chips === 0 && bubbleDown === "!", JSON.stringify({ band1, down2Chips, bubbleDown }));

    daemon = await startFakeDaemon({ port: daemonPort, ...DAEMON_OPTS }); // same URL as the extension setting
    const back1 = await badgeIn("down2", 20000);
    const back2 = await p.waitForFunction(({ sel, pid }) => {
      const pill = document.querySelector(`#${pid} ${sel}`)?.shadowRoot?.querySelector(".pill");
      return !!pill && !pill.classList.contains("band-unknown") && !pill.classList.contains("pending");
    }, { sel: BADGE_SEL, pid: "down1" }, { timeout: 20000 }).then(() => true).catch(() => false);
    const bubbleUp = await bubble();
    record("ui", "daemon back: waiting + Unavailable units re-queued automatically", back1 && back2 && bubbleUp !== "!", JSON.stringify({ back1, back2, bubbleUp }));
    await p.close();
  }

  // A23: the FIRST scan already obeys the stored scope. With "Main content only" chosen
  // before the page opens, the paragraph outside the article must never be chipped —
  // and its text must never reach the daemon, not even during the few hundred
  // milliseconds the settings read used to leave the page scanning whole-page defaults.
  {
    const extId = sw ? new URL(sw.url()).host : null;
    let r = { inMain: 0, outside: 0, leaked: null };
    if (extId) {
      const opt = await context.newPage();
      await opt.goto(`chrome-extension://${extId}/options.html`);
      await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({ analysisScope: "main" }, res)));
      const p = await context.newPage();
      await p.goto(server.url("/scope.html"), { waitUntil: "load" });
      await p.waitForSelector(`main ${BADGE_SEL}`, { timeout: 12000 }).catch(() => {});
      await sweep(p, 3);
      await p.waitForTimeout(2500);
      r = {
        inMain: await p.evaluate((sel) => document.querySelectorAll(`main ${sel}`).length, BADGE_SEL),
        outside: await p.evaluate((sel) => document.querySelectorAll(`#offmain ${sel}`).length, BADGE_SEL),
        // Read BEFORE the setting is restored — restoring re-scans the page whole.
        leaked: daemon.stats.texts.some((t) => t.includes(SCOPE_MARKER)),
      };
      await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({ analysisScope: "page" }, res)));
      await p.close();
      await opt.close();
    }
    record("ui", "main-content scope holds from the first scan: nothing outside is chipped or sent", r.inMain > 0 && r.outside === 0 && r.leaked === false, JSON.stringify(r));
  }

  // A24: the selection card's ✕ closes it WHILE the request is in flight. The listener
  // used to be attached after the await, so for as long as the daemon took (up to 25 s)
  // the button did nothing.
  {
    const p = await context.newPage();
    await p.goto(server.url("/stall.html"), { waitUntil: "load" });
    await p.bringToFront();
    await p.evaluate(() => {
      const ta = document.getElementById("draft");
      ta.focus();
      ta.setSelectionRange(0, ta.value.length);
    });
    // Exactly what the context menu does: the service worker messages the active tab.
    const t0 = Date.now();
    await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      try {
        await chrome.tabs.sendMessage(tab.id, { action: "analyzeSelection" });
      } catch {
        /* the content script answers nothing to this one */
      }
    });
    // The card host is a plain badge host appended to <body>; only IT holds a .close.
    const analyzing = await p
      .waitForFunction(
        (sel) => {
          const host = [...document.querySelectorAll(sel)].find((h) => h.shadowRoot?.querySelector(".card .close"));
          return !!host && /Analyzing/.test(host.shadowRoot.querySelector(".verdict")?.textContent ?? "");
        },
        BADGE_SEL,
        { timeout: 8000 },
      )
      .then(() => true)
      .catch(() => false);
    const clicked = await p
      .locator(`div[data-anagram="host"] .close`)
      .click({ timeout: 4000 })
      .then(() => true)
      .catch(() => false);
    const gone = await p
      .waitForFunction(
        (sel) => ![...document.querySelectorAll(sel)].some((h) => h.shadowRoot?.querySelector(".card .close")),
        BADGE_SEL,
        { timeout: 3000 },
      )
      .then(() => true)
      .catch(() => false);
    const elapsed = Date.now() - t0;
    record(
      "ui",
      "selection card: ✕ closes it while the daemon is still thinking",
      analyzing && clicked && gone && elapsed < STALL_MS,
      JSON.stringify({ analyzing, clicked, gone, elapsed }),
    );
    await p.close();
  }

  // A25: the copied report never says "62% AI" — the number is an estimate of EDITING
  // EXTENT, not a share of AI-written words — and it carries the legend that says so.
  {
    const p = await context.newPage();
    await p.goto(fixturesUrl, { waitUntil: "load" });
    await p.waitForSelector(BADGE_SEL, { timeout: 12000 }).catch(() => {});
    await sweep(p, 6);
    await p.waitForTimeout(2500);
    await p.evaluate(() => navigator.clipboard.writeText("NO REPORT COPIED").catch(() => {}));
    const clicked = await p.evaluate(() => {
      const sr = document.getElementById("anagram-fab")?.shadowRoot;
      sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      const copy = sr?.querySelector(".pcopy");
      if (!copy) return false;
      copy.click();
      return true;
    });
    await p.waitForTimeout(500);
    const report = await p.evaluate(() => navigator.clipboard.readText().catch(() => null));
    const ok =
      clicked &&
      typeof report === "string" &&
      report.startsWith("# Anagram report") &&
      !report.includes("% AI") &&
      report.includes("not a share of words, not proof");
    record("ui", "copied report: bare percentages plus the legend that explains them", ok, JSON.stringify({ clicked, head: report?.slice(0, 48) }));
    await p.close();
  }

  // A26/A27: the chips are aria-hidden and unfocusable by design, so the panel is the
  // accessible route to the verdicts — it has to be reachable, focusable and closable
  // without a pointer, and the three commands have to work. Chrome swallows the real
  // key combinations before the page sees them, so the commands are driven exactly the
  // way background.ts drives them: a message from the service worker to the active tab.
  {
    const p = await context.newPage();
    await p.bringToFront();
    await p.goto(server.url("/keyboard.html"), { waitUntil: "load" });
    const settled = await p
      .waitForFunction(
        (sel) => {
          const hosts = [...document.querySelectorAll(sel)];
          return hosts.length >= 4 && hosts.every((h) => !h.shadowRoot?.querySelector(".pill.pending"));
        },
        BADGE_SEL,
        { timeout: 25000 },
      )
      .then(() => true)
      .catch(() => false);

    // A26: Tab-reachable button → Enter opens and hands over focus → Escape gives it back.
    const counter = p.locator("#anagram-fab .count");
    const tag = await counter.evaluate((el) => el.tagName).catch(() => null);
    await counter.focus().catch(() => {});
    const onCounter = await p.evaluate(() => {
      const host = document.getElementById("anagram-fab");
      const c = host?.shadowRoot?.querySelector(".count");
      return {
        focused: document.activeElement === host && host.shadowRoot.activeElement === c,
        label: c?.getAttribute("aria-label") ?? null,
        expanded: c?.getAttribute("aria-expanded") ?? null,
        untucked: !host?.shadowRoot?.querySelector(".stack.tucked"),
      };
    });
    await p.keyboard.press("Enter");
    await p.waitForTimeout(400);
    const opened = await p.evaluate(() => {
      const sr = document.getElementById("anagram-fab")?.shadowRoot;
      const panel = sr?.querySelector(".panel");
      const named = panel?.getAttribute("aria-labelledby");
      return {
        open: !!panel?.classList.contains("open"),
        role: panel?.getAttribute("role") ?? null,
        name: named ? (sr.getElementById(named)?.textContent ?? null) : null,
        inPanel: !!sr?.activeElement && panel.contains(sr.activeElement),
        expanded: sr?.querySelector(".count")?.getAttribute("aria-expanded") ?? null,
        itemLabel: panel?.querySelector(".pitem")?.getAttribute("aria-label") ?? null,
      };
    });
    await p.keyboard.press("Escape");
    await p.waitForTimeout(250);
    const closed = await p.evaluate(() => {
      const sr = document.getElementById("anagram-fab")?.shadowRoot;
      return {
        open: !!sr?.querySelector(".panel.open"),
        backOnCounter: sr?.activeElement === sr?.querySelector(".count"),
        expanded: sr?.querySelector(".count")?.getAttribute("aria-expanded") ?? null,
      };
    });
    record(
      "ui",
      "triage panel: focusable counter button, Enter opens and takes focus, Escape returns it",
      settled && tag === "BUTTON" && onCounter.focused && onCounter.untucked &&
        opened.open && opened.role === "dialog" && !!opened.name && opened.inPanel &&
        opened.expanded === "true" && !closed.open && closed.backOnCounter && closed.expanded === "false",
      JSON.stringify({ settled, tag, onCounter, opened, closed }),
    );
    record(
      "ui",
      "accessible names carry the flagged count and each row's verdict",
      /\b4 flagged paragraphs\b/.test(onCounter.label ?? "") &&
        /^(Heavily edited|AI-generated), \d{1,3}%: \S/.test(opened.itemLabel ?? ""),
      JSON.stringify({ label: onCounter.label, itemLabel: opened.itemLabel?.slice(0, 60) }),
    );

    // A27: the three keyboard commands, driven from the service worker.
    const cmd = (action) =>
      sw.evaluate(async (a) => {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        try {
          await chrome.tabs.sendMessage(tab.id, { action: a });
        } catch {
          /* the content script answers nothing to these */
        }
      }, action);

    await p.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.activeElement?.blur());
    await cmd("openPanel");
    await p.waitForTimeout(400);
    const byCommand = await p.evaluate(() => {
      const sr = document.getElementById("anagram-fab")?.shadowRoot;
      const panel = sr?.querySelector(".panel");
      return { open: !!panel?.classList.contains("open"), inPanel: !!sr?.activeElement && panel.contains(sr.activeElement) };
    });
    await p.keyboard.press("Escape");
    await p.waitForTimeout(200);
    record("ui", "open-panel command opens the triage panel and puts the keyboard in it", byCommand.open && byCommand.inPanel, JSON.stringify(byCommand));

    // Each flagged chip's position in the document is its identity; the jump flashes the
    // chip it landed on, which is how the walk is read back.
    const flaggedAt = await p.evaluate(
      (sel) =>
        [...document.querySelectorAll(sel)]
          .filter((h) => {
            const pill = h.shadowRoot?.querySelector(".pill");
            return !!pill && (pill.classList.contains("band-heavy") || pill.classList.contains("band-ai"));
          })
          .map((h) => Math.round(h.getBoundingClientRect().top + window.scrollY))
          .sort((a, b) => a - b),
      BADGE_SEL,
    );
    const flashing = (want) =>
      p
        .waitForFunction(
          ({ sel, w }) => [...document.querySelectorAll(sel)].some((h) => !!h.shadowRoot?.querySelector(".pill.pg-flash")) === w,
          { sel: BADGE_SEL, w: want },
          { timeout: 8000 },
        )
        .then(() => true)
        .catch(() => false);
    const jump = async (action) => {
      await flashing(false); // let the previous pulse finish, or the read below is stale
      await cmd(action);
      await flashing(true);
      return p.evaluate((sel) => {
        for (const h of document.querySelectorAll(sel)) {
          if (h.shadowRoot?.querySelector(".pill.pg-flash")) return Math.round(h.getBoundingClientRect().top + window.scrollY);
        }
        return null;
      }, BADGE_SEL);
    };
    await p.evaluate(() => window.scrollTo(0, 0));
    const walk = { last: await jump("prevFlagged"), first: await jump("nextFlagged"), second: await jump("nextFlagged"), back: await jump("prevFlagged") };
    record(
      "ui",
      "next/prev-flagged walk the flagged paragraphs in document order and wrap around",
      flaggedAt.length === 4 &&
        walk.last === flaggedAt[3] && walk.first === flaggedAt[0] &&
        walk.second === flaggedAt[1] && walk.back === flaggedAt[0],
      JSON.stringify({ flaggedAt, walk }),
    );
    await p.screenshot({ path: artifact("scn-keyboard-panel.png") }).catch(() => {});
    await p.close();
  }

  // A28: a cross-origin subframe follows the TOP page's site rule. It cannot read
  // window.top, and the embed's no-referrer policy takes document.referrer away too, so
  // without the worker's answer the frame keys the rule on its own hostname and keeps
  // scoring a page the reader turned Anagram off on.
  {
    const extId = sw ? new URL(sw.url()).host : null;
    const topUrl = server.url("/frame-top.html");
    const chipsIn = async (page) => {
      const frame = page.frames().find((f) => f.url().includes("/frame.html"));
      return {
        top: await page.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL),
        frame: frame ? await frame.evaluate((sel) => document.querySelectorAll(sel).length, BADGE_SEL) : -1,
        // The proof that the old chain is dead here: no referrer, and the frame's own
        // host is 127.0.0.1, which the rule below never names.
        referrer: frame ? await frame.evaluate(() => document.referrer) : null,
      };
    };
    let r = { on: null, off: null };
    if (extId) {
      const opt = await context.newPage();
      await opt.goto(`chrome-extension://${extId}/options.html`);

      const open = await context.newPage();
      await open.goto(topUrl, { waitUntil: "load" });
      await open.waitForSelector(BADGE_SEL, { timeout: 15000 }).catch(() => {});
      await open.frameLocator("#embed").locator(BADGE_SEL).first().waitFor({ timeout: 15000 }).catch(() => {});
      r.on = await chipsIn(open);
      await open.close();

      await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({ siteOverrides: { localhost: "off" } }, res)));
      const ruled = await context.newPage();
      await ruled.goto(topUrl, { waitUntil: "load" });
      await ruled.waitForTimeout(4000); // long enough that a chip would have appeared
      r.off = await chipsIn(ruled);
      await ruled.close();

      // Every later fixture is served from localhost too — the rule must not outlive this.
      await opt.evaluate(() => new Promise((res) => chrome.storage.local.set({ siteOverrides: {} }, res)));
      await opt.close();
    }
    record(
      "ui",
      "a no-referrer cross-origin subframe follows the top page's site rule",
      !!r.on && r.on.top > 0 && r.on.frame > 0 && r.on.referrer === "" &&
        !!r.off && r.off.top === 0 && r.off.frame === 0 && r.off.referrer === "",
      JSON.stringify(r),
    );
  }
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
    // Anti-bot interstitials (Cloudflare "Verifying you are human", "Just a moment…")
    // carry no prose; they say nothing about the extension.
    const botWall = await page
      .evaluate(() => /verifying you are human|just a moment|attention required|checking your browser/i.test(document.title + " " + (document.body?.innerText ?? "").slice(0, 600)))
      .catch(() => false);
    if (botWall) {
      record("live", site.name, null, "bot-check interstitial (Cloudflare) — not a page");
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

    await page.screenshot({ path: artifact(`scn-${site.name}.png`) }).catch(() => {});
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
await server.close();
await daemon.close();

console.log("\n=== SCENARIO RESULTS ===");
for (const r of results) {
  console.log(`${r.status.padEnd(4)}  [${r.phase}]  ${r.name}${r.note ? `  —  ${r.note}` : ""}`);
}
const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
console.log(`\n${results.length - fails.length - skips.length} pass / ${fails.length} fail / ${skips.length} skip`);
console.log(fails.length === 0 ? "✅ SCENARIOS GREEN" : "❌ SCENARIO FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
