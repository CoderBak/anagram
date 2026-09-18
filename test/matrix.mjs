// test/matrix.mjs — the same page, many machines.
//
// Runs the UI fixture page under a matrix of device profiles — window sizes from a phone
// to an ultrawide monitor, pixel ratios 1 / 1.25 / 1.5 / 2 / 3 (Windows display scaling
// included), classic layout-eating scrollbars, dark scheme, forced colours, reduced motion,
// touch, non-English UI locales — and asserts only what must hold on EVERY one of them:
//
//   chips      every scoreable fixture paragraph gets a chip and they all reach a verdict
//   overflow   showing the chips adds no horizontal scroll to the page
//   shift      showing the chips grows no paragraph by more than one line
//   inside     no chip sticks out of the block it annotates
//   card       the detail card opens (hover, or tap on touch) fully inside the viewport
//   ball       the floating ball is inside the viewport and on top; its panel opens inside
//   pages      the options and onboarding pages fit the width without side-scrolling
//   errors     the extension logs no console errors
//
// Each profile is a fresh browser (pixel ratio and scrollbars are launch-time properties).
// Screenshots of every profile land in the artifacts folder for a visual pass.
//
//   node test/matrix.mjs                  # all profiles
//   node test/matrix.mjs phone dark       # only profiles whose name contains a word
//   node test/matrix.mjs --list
//   MATRIX_JOBS=3 node test/matrix.mjs    # browsers at a time (default 2)
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { launchExtension, serveHtml, artifact, sweep, BADGE_SEL } from "./harness.mjs";
import { startFakeDaemon } from "./fake-daemon.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const vp = (width, height) => ({ width, height });

export const PROFILES = [
  { name: "phone-360x640", viewport: vp(360, 640) },
  { name: "phone-390x844-dpr3-touch", viewport: vp(390, 844), deviceScaleFactor: 3, hasTouch: true },
  { name: "tablet-768x1024-dpr2-touch", viewport: vp(768, 1024), deviceScaleFactor: 2, hasTouch: true },
  { name: "split-screen-640x900", viewport: vp(640, 900) },
  { name: "short-1280x420", viewport: vp(1280, 420) },
  { name: "laptop-1280x720", viewport: vp(1280, 720) },
  { name: "laptop-1366x768-scale125", viewport: vp(1366, 768), deviceScaleFactor: 1.25 },
  { name: "laptop-1280x720-scale150", viewport: vp(1280, 720), deviceScaleFactor: 1.5 },
  { name: "retina-1440x900-dpr2-dark", viewport: vp(1440, 900), deviceScaleFactor: 2, colorScheme: "dark" },
  { name: "desktop-1920x1080-classic-scrollbars", viewport: vp(1920, 1080), classicScrollbars: true },
  { name: "narrow-480x800-classic-scrollbars", viewport: vp(480, 800), classicScrollbars: true },
  { name: "qhd-2560x1440", viewport: vp(2560, 1440) },
  { name: "ultrawide-3440x1440", viewport: vp(3440, 1440) },
  { name: "forced-colors-1280x720", viewport: vp(1280, 720), forcedColors: "active" },
  { name: "reduced-motion-1024x768", viewport: vp(1024, 768), reducedMotion: "reduce" },
  { name: "locale-zh-CN-1366x768", viewport: vp(1366, 768), locale: "zh-CN", timezoneId: "Asia/Shanghai" },
  { name: "locale-ar-1366x768", viewport: vp(1366, 768), locale: "ar-EG", timezoneId: "Africa/Cairo" },
];

const words = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (process.argv.includes("--list")) {
  for (const p of PROFILES) console.log(p.name);
  process.exit(0);
}
const selected = words.length ? PROFILES.filter((p) => words.some((w) => p.name.includes(w))) : PROFILES;
if (!selected.length) {
  console.error(`no profile matches: ${words.join(" ")}`);
  process.exit(2);
}
const JOBS = Math.max(1, Number(process.env.MATRIX_JOBS) || 2);

const daemon = await startFakeDaemon();
const server = await serveHtml({ "/ui-fixtures.html": readFileSync(join(__dirname, "ui-fixtures.html"), "utf8") });
const url = server.url("/ui-fixtures.html");

/** Everything measured in the page, in one place. Runs with the chips SHOWN. */
function measure(sel) {
  const de = document.documentElement;
  const hosts = [...document.querySelectorAll(sel)].filter((h) => getComputedStyle(h).display !== "none");
  const blockOf = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const d = getComputedStyle(p).display;
      if (!d.startsWith("inline") && d !== "contents") return p;
    }
    return document.body;
  };
  const pending = hosts.filter((h) => h.shadowRoot?.querySelector(".pill.pending")).length;
  const blocks = [...new Set(hosts.map(blockOf))];
  const outside = [];
  for (const h of hosts) {
    const b = blockOf(h);
    if (getComputedStyle(b).writingMode !== "horizontal-tb") continue; // vertical text flows the other way
    const hr = h.getBoundingClientRect();
    const br = b.getBoundingClientRect();
    if (hr.width === 0) continue;
    if (hr.left < br.left - 2 || hr.right > br.right + 2) outside.push(`${b.id || b.tagName}: chip ${Math.round(hr.left)}–${Math.round(hr.right)} vs block ${Math.round(br.left)}–${Math.round(br.right)}`);
  }
  return {
    chips: hosts.length,
    pending,
    scrollWidth: de.scrollWidth,
    clientWidth: de.clientWidth,
    clientHeight: de.clientHeight,
    innerWidth,
    dpr: devicePixelRatio,
    heights: blocks.map((b, i) => ({
      key: b.id || `${b.tagName}#${i}`,
      h: b.getBoundingClientRect().height,
      line: parseFloat(getComputedStyle(b).lineHeight) || parseFloat(getComputedStyle(b).fontSize) * 1.5,
      vertical: getComputedStyle(b).writingMode !== "horizontal-tb",
    })),
    outside,
  };
}

const clickFab = (page) =>
  page.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector("button.fab")?.click());

/** One profile, once more if the BROWSER died under it (a crashed or killed Chromium on a
 *  loaded CI runner says nothing about the extension). A failed assertion is never retried,
 *  and a retry is printed, so a profile that needs one every time does not go unnoticed. */
async function runProfile(profile) {
  const first = await attemptProfile(profile);
  if (!first.checks.some((c) => c.id === "ran")) return first;
  const second = await attemptProfile(profile);
  return { ...second, retried: first.checks.find((c) => c.id === "ran").note };
}

async function attemptProfile(profile) {
  const { name, ...launch } = profile;
  const checks = [];
  const check = (id, ok, note = "") => checks.push({ id, ok: !!ok, note: typeof note === "string" ? note : JSON.stringify(note) });
  const t0 = Date.now();
  let context;
  try {
    ({ context } = await launchExtension({ backendUrl: daemon.url, ...launch }));
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => {
      const u = m.location()?.url ?? "";
      if (m.type() === "error" && u.startsWith("chrome-extension://") && !u.startsWith("chrome-extension://invalid")) errors.push(m.text().slice(0, 140));
    });
    await page.goto(url, { waitUntil: "load" });
    await page.waitForSelector(BADGE_SEL, { timeout: 15000 }).catch(() => {});
    // Narrow pages are long: sweep enough screens to reach the end.
    const screens = await page.evaluate(() => Math.ceil(document.documentElement.scrollHeight / (innerHeight * 0.8)) + 1);
    await sweep(page, Math.min(screens, 40), 220);
    await page
      .waitForFunction((sel) => ![...document.querySelectorAll(sel)].some((h) => h.shadowRoot?.querySelector(".pill.pending")), BADGE_SEL, { timeout: 20000 })
      .catch(() => {});
    await page.waitForTimeout(600);

    // ---- chips / overflow / shift / inside ------------------------------------------
    const shown = await page.evaluate(measure, BADGE_SEL);
    await clickFab(page);
    await page.waitForTimeout(350);
    const hidden = await page.evaluate(measure, BADGE_SEL);
    await clickFab(page);
    await page.waitForTimeout(350);

    check("chips", shown.chips >= 12 && shown.pending === 0, { chips: shown.chips, pending: shown.pending });
    check("overflow", shown.scrollWidth <= Math.max(hidden.scrollWidth, shown.clientWidth) + 1, { shown: shown.scrollWidth, hidden: hidden.scrollWidth, width: shown.clientWidth });
    // `hidden` measured zero visible hosts, so its block list is empty — compare by
    // re-measuring the same blocks with the chips hidden.
    const grown = await page.evaluate(
      async ({ sel, before }) => {
        const fab = document.getElementById("anagram-fab")?.shadowRoot?.querySelector("button.fab");
        const blockOf = (el) => {
          for (let p = el.parentElement; p; p = p.parentElement) {
            const d = getComputedStyle(p).display;
            if (!d.startsWith("inline") && d !== "contents") return p;
          }
          return document.body;
        };
        const blocks = [...new Set([...document.querySelectorAll(sel)].map(blockOf))];
        fab?.click();
        await new Promise((r) => setTimeout(r, 300));
        const bare = blocks.map((b) => b.getBoundingClientRect().height);
        fab?.click();
        await new Promise((r) => setTimeout(r, 300));
        const out = [];
        blocks.forEach((b, i) => {
          const m = before[i];
          if (!m || m.vertical) return;
          const growth = m.h - bare[i];
          if (growth > m.line * 1.25 + 2) out.push(`${m.key}: +${Math.round(growth)}px (line ${Math.round(m.line)}px)`);
        });
        return out;
      },
      { sel: BADGE_SEL, before: shown.heights },
    );
    check("shift", grown.length === 0, grown.slice(0, 3).join(" | "));
    check("inside", shown.outside.length === 0, shown.outside.slice(0, 3).join(" | "));

    // ---- detail card: first, right-column, a middle one and the last chip -------------
    const total = shown.chips;
    const picks = [...new Set([0, 1, Math.floor(total / 2), total - 1])].filter((i) => i >= 0 && i < total);
    const cardNotes = [];
    let cardsOk = picks.length > 0;
    for (const i of picks) {
      const host = page.locator(BADGE_SEL).nth(i);
      await host.evaluate((el) => el.scrollIntoView({ block: i === 0 ? "start" : "center" }), null).catch(() => {});
      if (i === 0) await page.evaluate(() => window.scrollTo(0, 0));
      await page.waitForTimeout(200);
      if (launch.hasTouch) await host.tap({ timeout: 5000 }).catch(() => {});
      else await host.hover({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      const r = await host.evaluate((el) => {
        const card = el.shadowRoot?.querySelector(".card");
        if (!card) return { open: false };
        const cr = card.getBoundingClientRect();
        const de = document.documentElement;
        const open = card.matches(":popover-open") || card.classList.contains("showing") || card.classList.contains("open");
        return {
          open: open && getComputedStyle(card).visibility === "visible" && cr.width > 0,
          fits: cr.left >= -0.5 && cr.top >= -0.5 && cr.right <= de.clientWidth + 0.5 && cr.bottom <= de.clientHeight + 0.5,
          rect: [Math.round(cr.left), Math.round(cr.top), Math.round(cr.right), Math.round(cr.bottom)],
          view: [de.clientWidth, de.clientHeight],
        };
      });
      if (!r.open || !r.fits) {
        cardsOk = false;
        cardNotes.push(`#${i} ${JSON.stringify(r)}`);
      }
      if (i === 0) await page.screenshot({ path: artifact(`matrix-${name}.png`) }).catch(() => {});
      // dismiss: move away / tap the page
      if (launch.hasTouch) await page.evaluate(() => document.body.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })));
      else await page.mouse.move(2, Math.min(300, shown.clientHeight - 2));
      await page.waitForTimeout(150);
    }
    check("card", cardsOk, cardNotes.slice(0, 2).join(" | "));

    // ---- the ball and its panel --------------------------------------------------------
    await page.evaluate(() => window.scrollTo(0, 0));
    const ball = page.locator("#anagram-fab .fab").first();
    if (!launch.hasTouch) await ball.hover({ timeout: 5000 }).catch(() => {}); // untuck
    await page.waitForTimeout(400);
    const fab = await page.evaluate(() => {
      const host = document.getElementById("anagram-fab");
      const btn = host?.shadowRoot?.querySelector("button.fab");
      if (!btn) return null;
      const de = document.documentElement;
      const r = btn.getBoundingClientRect();
      const cx = Math.min(Math.max(r.left + r.width / 2, 1), de.clientWidth - 1);
      const cy = Math.min(Math.max(r.top + r.height / 2, 1), de.clientHeight - 1);
      // A tucked ball hangs half off the edge by design; at least half of it must be visible.
      const visibleW = Math.min(r.right, de.clientWidth) - Math.max(r.left, 0);
      return {
        onTop: document.elementFromPoint(cx, cy) === host,
        inView: visibleW >= r.width / 2 - 1 && r.top >= 0 && r.bottom <= de.clientHeight + 0.5,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
      };
    });
    const panel = await page.evaluate(async () => {
      const sr = document.getElementById("anagram-fab")?.shadowRoot;
      sr?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await new Promise((r) => setTimeout(r, 450));
      const p = sr?.querySelector(".panel");
      if (!p) return null;
      const de = document.documentElement;
      const r = p.getBoundingClientRect();
      return {
        open: p.classList.contains("open"),
        items: p.querySelectorAll(".pitem").length,
        fits: r.left >= -0.5 && r.top >= -0.5 && r.right <= de.clientWidth + 0.5 && r.bottom <= de.clientHeight + 0.5,
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
        view: [de.clientWidth, de.clientHeight],
      };
    });
    await page.screenshot({ path: artifact(`matrix-${name}-panel.png`) }).catch(() => {});
    await page.evaluate(() => document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    check("ball", !!fab && fab.onTop && fab.inView && !!panel && panel.open && panel.items > 0 && panel.fits, { fab, panel });

    // ---- extension pages ------------------------------------------------------------------
    const extId = new URL(context.serviceWorkers()[0].url()).host;
    const pageNotes = [];
    for (const p of ["options", "onboarding"]) {
      const ep = await context.newPage();
      await ep.goto(`chrome-extension://${extId}/${p}.html`);
      await ep.waitForTimeout(500);
      const o = await ep.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      if (o.sw > o.cw + 1) pageNotes.push(`${p}: content ${o.sw}px in a ${o.cw}px window`);
      await ep.screenshot({ path: artifact(`matrix-${name}-${p}.png`) }).catch(() => {});
      await ep.close();
    }
    check("pages", pageNotes.length === 0, pageNotes.join(" | "));
    check("errors", errors.length === 0, errors.slice(0, 2).join(" | "));
  } catch (e) {
    check("ran", false, String(e).slice(0, 200));
  } finally {
    await context?.close().catch(() => {});
  }
  return { name, seconds: Math.round((Date.now() - t0) / 100) / 10, checks };
}

// ---- run the matrix, a few browsers at a time ------------------------------------------
const results = new Array(selected.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(JOBS, selected.length) }, async () => {
    while (next < selected.length) {
      const i = next++;
      results[i] = await runProfile(selected[i]);
      const r = results[i];
      const failed = r.checks.filter((c) => !c.ok);
      console.log(`${failed.length ? "FAIL" : "PASS"}  ${r.name.padEnd(40)} ${String(r.seconds).padStart(5)}s  ${failed.map((c) => c.id).join(",")}${r.retried ? `  (second attempt — first: ${r.retried.slice(0, 90)})` : ""}`);
    }
  }),
);

const COLS = ["chips", "overflow", "shift", "inside", "card", "ball", "pages", "errors"];
console.log(`\n=== MATRIX (${process.platform}/${process.arch}, ${process.env.HEADED === "1" ? "headed" : "headless"}) ===`);
console.log("profile".padEnd(40) + COLS.map((c) => c.padEnd(9)).join(""));
for (const r of results) {
  const by = Object.fromEntries(r.checks.map((c) => [c.id, c]));
  console.log(r.name.padEnd(40) + COLS.map((c) => (by[c] ? (by[c].ok ? "ok" : "FAIL") : by.ran ? "—" : "?").padEnd(9)).join(""));
}
const failures = results.flatMap((r) => r.checks.filter((c) => !c.ok).map((c) => `${r.name} · ${c.id}: ${c.note}`));
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log("  - " + f);
}
writeFileSync(artifact("matrix.json"), JSON.stringify({ platform: process.platform, arch: process.arch, results }, null, 1));
const total = results.reduce((n, r) => n + r.checks.length, 0);
console.log(`\n${total - failures.length} pass / ${failures.length} fail across ${results.length} profiles`);
console.log(failures.length ? "❌ MATRIX FAILED" : "✅ MATRIX GREEN");

await server.close();
await daemon.close();
process.exit(failures.length ? 1 : 0);
