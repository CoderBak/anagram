// test/pseudo-locale.mjs — the extension's pages with longer words than English has.
//
// A translation is rarely the length of the English it replaces, and a control laid out
// for "Add" has to hold whatever the next language says there. This renders every page a
// reader sees — setup (with and without an engine), settings (and its row that allows a
// comment site), the toolbar menu, the PDF reader's own chrome, chips, a chip's card, the choice
// between the two engines (and a refused permission), the local engine alone, a device that
// cannot run the model, Settings' switch and its offer to delete the in-browser engine's files,
// the offer of the in-browser engine when the local one keeps crashing, and the in-browser
// engine's setup page in each state on the way to Ready, its cancel confirmation and its toolbar
// menu, and the reading statistics (off, a week of them, the export, Settings' group, the
// toolbar menu's line) — at 1280 and 400 px (the menu at its own 340), three times: in a
// pseudo-locale (every English message accented and stretched by the pseudo-localization
// package, placeholders kept), in Chinese, and in English. On each it looks for the ways
// a longer label breaks a layout:
//
//   cut off   — a control's words run out of its box, or a box that clips (overflow
//               hidden) cuts the control;
//   wrapped   — a button's label breaks onto a second line;
//   off-page  — a control sticks out of the window, or the page scrolls sideways;
//   overlap   — two controls cover each other.
//
// The pseudo-locale is the build's own _locales/en rewritten in a copy of the test build,
// so every string still comes through chrome.i18n exactly as it ships.
//
//   npm run test:pseudo-locale
//   PSEUDO_SHOTS=1 npm run test:pseudo-locale   # and a screenshot of every page checked
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pseudoLocalizeString } from "pseudo-localization";
import { EXT, artifact, launchExtension, requireBuild, serveHtml, uiLanguage, uiLanguageOf, waitForRegistration } from "./harness.mjs";
import { TEST_PDF, pdfChips, readerRead } from "./pdf-fixture.mjs";
import { deviceBuild } from "./test-build.mjs";
import { DEVICES } from "./pw/devices.mjs";
import { scriptDevice, scriptEngine } from "./webengine/scripted-engine.mjs";
import { NO_MODEL_HOSTS, cancelAutoSetup } from "./webengine/model-server.mjs";
import { seedStats, statsWeek } from "./stats-fixture.mjs";

requireBuild();

const results = [];
const record = (name, ok, note = "") => results.push({ name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note: String(note) });

// ---- the pseudo-locale ---------------------------------------------------------------------

/** Accent and stretch the words; leave $1…$9 and $NAMED$ placeholders exactly as they are. */
const pseudo = (message) =>
  message
    .split(/(\$\d|\$[A-Za-z_]+\$)/)
    .map((part, i) => (i % 2 ? part : pseudoLocalizeString(part)))
    .join("");

function pseudoBuild(source = EXT, { siteOnly = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "anagram-pseudo-"));
  const ext = join(dir, "extension");
  cpSync(source, ext, { recursive: true });
  const file = join(ext, "_locales", "en", "messages.json");
  const messages = JSON.parse(readFileSync(file, "utf8"));
  for (const entry of Object.values(messages)) entry.message = pseudo(entry.message);
  writeFileSync(file, JSON.stringify(messages));
  if (!siteOnly) return { dir, ext };
  // Only the page's own site granted, as a reader's per-site grant leaves it: the menu's
  // offer to allow a comment site, and the settings row it opens, are then on screen.
  const manifestFile = join(ext, "manifest.json");
  const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
  manifest.host_permissions = ["http://localhost/*"];
  manifest.optional_host_permissions = ["https://*/*", "http://*/*", "file:///*"];
  writeFileSync(manifestFile, JSON.stringify(manifest));
  return { dir, ext };
}

// ---- what a broken layout looks like -------------------------------------------------------

/**
 * Runs in the page. `scope`, when given, limits the check to the elements under it (and
 * to overlaps that involve one of them): the reader's toolbar is upstream pdf.js, and only
 * what Anagram puts there is ours to answer for. Open shadow roots are walked.
 */
function layoutFaults(scope) {
  const CONTROL =
    'button, a[href], select, input:not([type="hidden"]), textarea, label, summary, [role="button"], [role="tab"], [role="switch"], [role="link"], [role="menuitem"], .pill, .card .head, .card .row';
  const up = (el) => el.parentElement ?? (el.getRootNode() instanceof ShadowRoot ? el.getRootNode().host : null);
  const within = (el, sel) => {
    for (let a = el; a; a = up(a)) if (a.matches?.(sel)) return true;
    return false;
  };
  const contains = (a, b) => {
    for (let x = b; x; x = up(x)) if (x === a) return true;
    return false;
  };
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    for (let a = el; a; a = up(a)) {
      const cs = getComputedStyle(a);
      if (cs.display === "none" || cs.visibility === "hidden" || Number(cs.opacity) === 0) return false;
      // Kept for a screen reader only: a clipped 1 px box.
      if (cs.clipPath !== "none" && a.getBoundingClientRect().width < 2) return false;
    }
    return true;
  };
  const describe = (el) => {
    const text = (el.textContent || el.getAttribute("aria-label") || el.value || "").replace(/\s+/g, " ").trim().slice(0, 40);
    const cls = typeof el.className === "string" && el.className ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
    return `${el.tagName.toLowerCase()}${el.id ? "#" + el.id : ""}${cls}${text ? ` "${text}"` : ""}`;
  };
  const controls = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll("*")) {
      if (el.matches(CONTROL) && shown(el)) controls.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  };
  walk(document);
  const subject = (el) => !scope || within(el, scope);
  /** Where the control's own words are drawn: its text nodes' boxes, not its box. */
  const textBox = (el) => {
    const range = document.createRange(), walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let box = null;
    const tops = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim() || !n.parentElement) continue;
      // Words kept for a screen reader only (a 1 px box, clipped) are not drawn at all.
      const holder = n.parentElement.getBoundingClientRect(), hs = getComputedStyle(n.parentElement);
      if (holder.width < 2 || holder.height < 2 || hs.clipPath !== "none" || hs.visibility === "hidden") continue;
      // A line cut with an ellipsis says so: the menu's excerpt of a paragraph, the Docs
      // bar's document title. Only page text is drawn that way.
      if (hs.textOverflow === "ellipsis") continue;
      range.selectNodeContents(n);
      for (const q of range.getClientRects()) {
        if (q.width < 0.5 || q.height < 0.5) continue;
        if (!tops.some((t) => Math.abs(t - q.top) < q.height / 2)) tops.push(q.top);
        box = box
          ? { left: Math.min(box.left, q.left), top: Math.min(box.top, q.top), right: Math.max(box.right, q.right), bottom: Math.max(box.bottom, q.bottom) }
          : { left: q.left, top: q.top, right: q.right, bottom: q.bottom };
      }
    }
    return box && { ...box, lines: tops.length };
  };
  // A button whose label breaks onto a second line has outgrown its row.
  const ONE_LINE = 'button, [role="button"], [role="tab"], .btn, .pill';
  const faults = [];
  const W = document.documentElement.clientWidth, H = innerHeight;
  if (!scope && document.documentElement.scrollWidth > W + 1)
    faults.push(`the page scrolls sideways (${document.documentElement.scrollWidth} px in ${W})`);
  for (const el of controls) {
    if (!subject(el)) continue;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const text = cs.display !== "inline" ? textBox(el) : null;
    if (text && (text.left < r.left - 1 || text.right > r.right + 1))
      faults.push(`${describe(el)}: its words run ${Math.round(Math.max(r.left - text.left, text.right - r.right))} px out of its box at the side`);
    if (text && text.lines > 1 && el.matches(ONE_LINE)) faults.push(`${describe(el)}: its label breaks onto ${text.lines} lines`);
    // Glyphs a pixel or two taller than a tight line box are drawn all the same; a line that
    // spills out of its box, or a box that clips its words, is not.
    const spill = /hidden|clip/.test(cs.overflowY) ? 1 : parseFloat(cs.fontSize) / 2;
    if (text && (text.top < r.top - spill || text.bottom > r.bottom + spill))
      faults.push(`${describe(el)}: its words run ${Math.round(Math.max(r.top - text.top, text.bottom - r.bottom))} px out of its box at the top or bottom`);
    let scrolled = false, fixed = cs.position === "fixed";
    for (let a = up(el); a && a !== document.documentElement && a !== document.body; a = up(a)) {
      const as = getComputedStyle(a);
      if (as.position === "fixed") fixed = true;
      const ar = a.getBoundingClientRect();
      const clipX = /hidden|clip/.test(as.overflowX), clipY = /hidden|clip/.test(as.overflowY);
      if (clipX && (r.left < ar.left - 1 || r.right > ar.right + 1)) {
        faults.push(`${describe(el)}: cut off at the side by ${describe(a)}`);
        break;
      }
      if (clipY && (r.top < ar.top - 1 || r.bottom > ar.bottom + 1)) {
        faults.push(`${describe(el)}: cut off at the top or bottom by ${describe(a)}`);
        break;
      }
      if (/auto|scroll/.test(as.overflowX + as.overflowY)) {
        scrolled = true;
        break;
      }
    }
    if (!scrolled && (r.left < -1 || r.right > W + 1)) faults.push(`${describe(el)}: sticks out of the window at the side`);
    if (!scrolled && fixed && (r.top < -1 || r.bottom > H + 1)) faults.push(`${describe(el)}: sticks out of the window at the top or bottom`);
  }
  // A fixed layer (a pinned card) lies over the page on purpose.
  const layer = (el) => {
    for (let a = el; a; a = up(a)) if (getComputedStyle(a).position === "fixed") return a;
    return null;
  };
  const labelled = (a, b) => a instanceof HTMLLabelElement && (a.control === b || a.contains(b));
  for (let i = 0; i < controls.length; i++) {
    for (let j = i + 1; j < controls.length; j++) {
      const a = controls[i], b = controls[j];
      if (!subject(a) && !subject(b)) continue;
      if (contains(a, b) || contains(b, a) || labelled(a, b) || labelled(b, a) || layer(a) !== layer(b)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 2 && h > 2) faults.push(`${describe(a)} and ${describe(b)} overlap (${Math.round(w)}×${Math.round(h)} px)`);
    }
  }
  return [...new Set(faults)];
}

/** Layout as it ends up, not on its way there: no transitions (a <details> opens by
 *  animating its height), fonts loaded, two frames drawn. */
const settle = (page) =>
  page.evaluate(async () => {
    const still = "*, *::before, *::after, ::details-content { transition: none !important; animation: none !important; }";
    const roots = [document];
    for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
    for (const root of roots) {
      if (root.querySelector?.(":scope > style[data-still]")) continue;
      const style = document.createElement("style");
      style.dataset.still = "";
      style.textContent = still;
      (root === document ? document.head : root).append(style);
    }
    await document.fonts.ready;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  });

async function check(page, lang, what, { scope, shot } = {}) {
  await settle(page);
  const faults = await page.evaluate(layoutFaults, scope ?? null).catch((e) => [`could not be checked: ${e}`]);
  const size = page.viewportSize();
  const name = `${lang}: ${what} at ${size.width} px`;
  if (faults.length || process.env.PSEUDO_SHOTS) await page.screenshot({ path: artifact(`pseudo-${shot ?? what.replace(/\W+/g, "-")}-${lang}-${size.width}.png`), fullPage: true }).catch(() => {});
  record(name, faults.length === 0, faults.slice(0, 8).join("; "));
}

// ---- the pages ------------------------------------------------------------------------------

const PARA = (tag) =>
  `${tag} paragraph is long enough to be scored on its own because it carries well over seventy-five ordinary English words describing nothing in particular except the fact that a panel full of longer labels must still fit the window it opens in, which is what this page is for, and each of its paragraphs has to be read and chipped before the ball can offer a list of the flagged ones and a way to copy the report.`;
const server = await serveHtml({
  "/article.html": `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>article</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
${["ITEM-16", "ITEM-111", "ITEM-149"].map((t) => `<p>${PARA(t)}</p>`).join("\n")}
<iframe src="https://disqus.com/embed/comments/?f=pseudo" width="600" height="120"></iframe></body></html>`,
});

const WIDE = { width: 1280, height: 900 };
const NARROW = { width: 400, height: 800 };
const POPUP = { width: 340, height: 600 };

async function pages(context, extId, fixture, lang) {
  const url = (p) => `chrome-extension://${extId}/${p}`;
  const page = await context.newPage();
  const componentReady = () =>
    page.waitForFunction(() => /(Ready|就绪)$/.test(document.querySelector("#componentSettings .component-status")?.textContent ?? ""), null, { timeout: 15000 }).catch(() => {});

  // The popup is a fixed 340 px wide, whatever the window (entrypoints/popup/index.html).
  await page.setViewportSize(POPUP);
  await page.goto(url("popup.html"), { waitUntil: "load" });
  await page.waitForFunction(() => document.getElementById("status")?.textContent !== "…", null, { timeout: 10000 }).catch(() => {});
  await check(page, lang, "popup");

  for (const size of [WIDE, NARROW]) {
    await page.setViewportSize(size);
    await page.goto(url("options.html"), { waitUntil: "load" });
    await componentReady();
    await check(page, lang, "settings");

    // Opened by the toolbar menu's offer to allow a comment site (lib/access/commentFrames.ts).
    await page.goto(url("options.html#comments=disqus.com"), { waitUntil: "load" });
    await page.locator("#comments:not([hidden])").waitFor({ timeout: 10000 }).catch(() => {});
    await check(page, lang, "settings, a comment site to allow");

    await page.goto(url("onboarding.html"), { waitUntil: "load" });
    await componentReady();
    await check(page, lang, "setup, engine ready");
  }

  // Setup without an engine: the install command and its buttons.
  await fixture.close();
  for (const size of [WIDE, NARROW]) {
    await page.setViewportSize(size);
    await page.goto(url("onboarding.html"), { waitUntil: "load" });
    await page.locator("#install:not([hidden])").waitFor({ timeout: 15000 }).catch(() => {});
    await check(page, lang, "setup, no engine");
  }
  await fixture.resume();

  // The reader: its own controls in the upstream toolbar, the picker, and its chips.
  const READER_OWN = '#anagramAnalyze, #original, #drop, #notice, [data-anagram]';
  for (const size of [WIDE, NARROW]) {
    await page.setViewportSize(size);
    await page.goto(url("reader.html"), { waitUntil: "load" });
    await page.locator("#drop:not([hidden])").waitFor({ timeout: 15000 }).catch(() => {});
    await check(page, lang, "reader, empty", { scope: READER_OWN });
    await page.setInputFiles("#file", { name: "document.pdf", mimeType: "application/pdf", buffer: TEST_PDF });
    await readerRead(page).catch(() => {});
    await pdfChips(page);
    await check(page, lang, "reader, reading", { scope: READER_OWN });
  }

  // A web page with chips (all three AI-generated under the fixture's text-seeded scores), and a
  // chip's card pinned open.
  const OURS = "[data-anagram]";
  for (const size of [WIDE, NARROW]) {
    await page.setViewportSize(size);
    await page.goto(server.url("/article.html"), { waitUntil: "load" });
    await page.waitForFunction(
      () => [...document.querySelectorAll('[data-anagram="host"]')].filter((h) => h.shadowRoot?.querySelector(".pill:not(.pending)")).length >= 3,
      null,
      { timeout: 20000 },
    ).catch(() => {});
    await check(page, lang, "chips on a page", { scope: OURS });
    await page.locator('[data-anagram="host"] .pill').first().click().catch(() => {});
    await page.waitForFunction(() => [...document.querySelectorAll('[data-anagram="host"]')].some((h) => h.shadowRoot?.querySelector(".card.open")), null, { timeout: 10000 }).catch(() => {});
    await check(page, lang, "a chip's card", { scope: OURS });
  }
  await page.close();
}

// ---- the reading statistics -------------------------------------------------------------------------

/** The statistics page while off (the warning for every page shown), with a week recorded by
 *  page (the trend's table open, then the export dialog), Settings' group recording every page,
 *  and the toolbar menu's line of today (test/stats-fixture.mjs). */
async function statsPages(context, sw, extId, lang) {
  const url = (p) => `chrome-extension://${extId}/${p}`;
  const page = await context.newPage();
  for (const size of [WIDE, NARROW]) {
    await page.setViewportSize(size);
    await page.goto(url("stats.html"), { waitUntil: "load" });
    await page.locator("#offCard:not([hidden])").waitFor({ timeout: 10000 }).catch(() => {});
    await page.selectOption("#turnOnLevel", "pages").catch(() => {});
    await check(page, lang, "statistics, off");
  }
  await sw.evaluate(() => chrome.storage.local.set({ statsLevel: "pages" }));
  await seedStats(sw, statsWeek());
  for (const size of [WIDE, NARROW]) {
    await page.setViewportSize(size);
    await page.goto(url("stats.html"), { waitUntil: "load" });
    await page.click('#ranges [data-range="7"]').catch(() => {});
    await page.locator("#trendChart svg").waitFor({ timeout: 10000 }).catch(() => {});
    await page.click("#trendCard summary").catch(() => {});
    await check(page, lang, "statistics, a week");
    await page.click("#export").catch(() => {});
    await page.locator("#exportDialog[open]").waitFor({ timeout: 5000 }).catch(() => {});
    await check(page, lang, "statistics, export");
    await page.goto(url("options.html#statistics"), { waitUntil: "load" });
    await page.locator("#statsPagesWarn:not([hidden])").waitFor({ timeout: 5000 }).catch(() => {});
    await check(page, lang, "settings, statistics of every page");
  }
  await page.setViewportSize(POPUP);
  await page.goto(url("popup.html"), { waitUntil: "load" });
  await page.locator("#statsToday:not([hidden])").waitFor({ timeout: 10000 }).catch(() => {});
  await check(page, lang, "popup, today's statistics");
  await page.close();
}

// ---- which engine ----------------------------------------------------------------------------------

/** The engine card before an engine is chosen, on the devices that see each of its faces (the
 *  page's stand-in device scripted, test/webengine/scripted-engine.mjs), Settings' switch with
 *  the in-browser engine's files left behind, and the offer of the in-browser engine when the
 *  local one keeps crashing. Nothing is downloaded on any of them. */
async function enginePages(context, extId, lang) {
  const url = (p) => `chrome-extension://${extId}/${p}`;
  const open = async (path, size, script) => {
    const page = await context.newPage();
    await script(page);
    await page.setViewportSize(size);
    await page.goto(url(path), { waitUntil: "load" });
    return page;
  };
  const up = (page, selector) => page.waitForFunction((s) => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0; }, selector, { timeout: 15000 })
    .then(() => true, () => false);
  const faces = [["apple-silicon", "#engine-pick-inbrowser", "the choice of engines"], ["linux-2gb", ".engine-cannot", "a device that cannot run the model"]];
  for (const size of [WIDE, NARROW]) {
    for (const [device, selector, what] of faces) {
      const page = await open("onboarding.html", size, async (p) => { await scriptEngine(p, "needed", { engine: null }); await scriptDevice(p, DEVICES[device]); });
      if (await up(page, selector)) await check(page, lang, `setup page, ${what}`);
      else record(`${lang}: setup page, ${what} at ${size.width} px`, false, "it never showed");
      if (device === "apple-silicon") {
        await page.evaluate(() => { chrome.permissions.request = async () => false; });
        await page.click("#engine-pick-native").catch(() => {});
        if (await up(page, ".engine-choice .engine-error")) await check(page, lang, "setup page, the local engine refused");
        else record(`${lang}: setup page, the local engine refused at ${size.width} px`, false, "the reason never showed");
      }
      await page.close();
    }
    const tight = await open("onboarding.html", size, async (p) => { await scriptEngine(p, "downloading"); await scriptDevice(p, DEVICES["linux-4gb"]); });
    if (await up(tight, ".engine-tight")) await check(tight, lang, "setup page, 4 GB of memory");
    else record(`${lang}: setup page, 4 GB of memory at ${size.width} px`, false, "the note never showed");
    await tight.close();
    const lighter = await open("onboarding.html", size, async (p) => { await scriptEngine(p, "lighter"); await scriptDevice(p, DEVICES["linux-4gb-f16"]); });
    if (await up(lighter, ".engine-lighter")) await check(lighter, lang, "setup page, the lighter model");
    else record(`${lang}: setup page, the lighter model at ${size.width} px`, false, "the line never showed");
    await lighter.close();
    const crashing = await open("onboarding.html", size, async (p) => { await scriptEngine(p, "ready_gpu", { engine: "native", crashed: true }); await scriptDevice(p, DEVICES["apple-silicon"]); });
    if (await up(crashing, "#engine-crash-switch")) { await check(crashing, lang, "setup page, the local engine crashing"); }
    else record(`${lang}: setup page, the local engine crashing at ${size.width} px`, false, "the switch never showed");
    await crashing.close();
    const settings = await open("options.html", size, async (p) => { await scriptEngine(p, "needed", { engine: "native" }); await scriptDevice(p, DEVICES["linux-cpu"]); });
    if (await up(settings, "#engine-delete-leftover") && await up(settings, "#engine-switch")) { await check(settings, lang, "settings, the switch and the files left behind"); }
    else record(`${lang}: settings, the switch and the files left behind at ${size.width} px`, false, "they never showed");
    await settings.close();
  }
  const popup = await open("popup.html", POPUP, async (p) => { await scriptEngine(p, "ready_gpu", { engine: "native", crashed: true }); await scriptDevice(p, DEVICES["apple-silicon"]); });
  if (await up(popup, "#switchEngine")) await check(popup, lang, "popup, the local engine crashing");
  else record(`${lang}: popup, the local engine crashing`, false, "the switch never showed");
  await popup.close();
}

/** Files the in-browser engine left, as a download cut short leaves them, in the extension's storage. */
async function seedLeftover(context, extId) {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/options.html`);
  await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("anagram-engine", { create: true });
    const writable = await (await dir.getFileHandle("model.onnx.part", { create: true })).createWritable();
    await writable.write(new Uint8Array(3e6)); await writable.close();
  });
  await page.close();
}

// ---- the in-browser engine's setup --------------------------------------------------------------

/** The in-browser engine's setup in each state people meet on the way to Ready, scripted into
 *  the page (test/webengine/scripted-engine.mjs), and the toolbar menu in those states. */
async function inBrowserPages(context, extId, lang) {
  const url = (p) => `chrome-extension://${extId}/${p}`;
  const painted = (page) =>
    page.waitForFunction(() => (document.querySelector("#componentSettings .component-status")?.textContent ?? "") !== "", null, { timeout: 15000 }).catch(() => {});
  const scripted = async (path, state, size, options = {}) => {
    const page = await context.newPage();
    await scriptEngine(page, state, options);
    await page.setViewportSize(size);
    await page.goto(url(path), { waitUntil: "load" });
    return page;
  };
  for (const size of [WIDE, NARROW]) {
    for (const state of ["needed", "downloading", "mirror", "paused", "network", "storage", "ready_gpu", "ready_cpu", "load_failed"]) {
      // Waiting for Set up, with Save-Data on and too little room, is the longest the needed
      // state gets: the reason and the error over the button.
      const page = await scripted("onboarding.html", state, size, state === "needed" ? { saveData: true, estimate: { quota: 500e6, usage: 100e6 } } : {});
      await painted(page);
      await page.waitForTimeout(300);
      await page.evaluate(() => { const manage = document.getElementById("manage"); if (manage && !manage.hidden) manage.open = true; });
      await check(page, lang, `in-browser setup, ${state}`);
      if (state === "paused") {
        await page.click("#engine-cancel").catch(() => {});
        await page.waitForSelector("#componentSettings dialog[open]", { timeout: 5000 }).catch(() => {});
        await check(page, lang, "in-browser setup, cancel confirmation");
      }
      await page.close();
    }
    const settings = await scripted("options.html", "downloading", size);
    await painted(settings);
    await check(settings, lang, "in-browser settings, downloading");
    await settings.close();
  }
  for (const state of ["needed", "downloading", "paused", "loading"]) {
    const popup = await scripted("popup.html", state, POPUP);
    await popup.waitForFunction(() => !document.getElementById("action").disabled, null, { timeout: 10000 }).catch(() => {});
    await check(popup, lang, `in-browser popup, setup ${state}`);
    await popup.close();
  }
}

async function runInBrowser(lang, launch) {
  // On a device with no choice a fresh profile starts the model's download by itself: Hugging
  // Face resolves to nothing here.
  const { context, sw, extId } = await launchExtension({ ...launch, args: [...(launch.args ?? []), NO_MODEL_HOSTS] });
  await context.route("https://disqus.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>comments</title>" }));
  try {
    const got = await uiLanguageOf(sw);
    const want = lang === "zh-CN" ? "zh-CN" : "en";
    if (!got?.startsWith(want.slice(0, 2)) || (want === "zh-CN" && !/^zh/i.test(got))) {
      record(`${lang}: the in-browser engine's browser came up in that language`, null, `it is in ${got}`);
      return;
    }
    await waitForRegistration(sw);
    await cancelAutoSetup(context, extId);
    await inBrowserPages(context, extId, lang);
    await seedLeftover(context, extId);
    await enginePages(context, extId, lang);
  } finally {
    await context.close();
  }
}

async function run(lang, launch) {
  const { context, sw, extId, fixture } = await launchExtension(launch);
  // The article's comment frame, answered here: nothing leaves the machine.
  await context.route("https://disqus.com/**", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>comments</title>" }));
  try {
    if (launch.extDir) await waitForRegistration(sw);
    const got = await uiLanguageOf(sw);
    const want = lang === "zh-CN" ? "zh-CN" : "en";
    if (!got?.startsWith(want.slice(0, 2)) || (want === "zh-CN" && !/^zh/i.test(got))) {
      record(`${lang}: the browser came up in that language`, null, `it is in ${got}`);
      return;
    }
    await pages(context, extId, fixture, lang);
    await statsPages(context, sw, extId, lang);
  } finally {
    await context.close();
  }
}

const built = pseudoBuild();
// A device with no choice: the in-browser engine sets up from install.
const INBROWSER = deviceBuild("linux-cpu", DEVICES["linux-cpu"]);
const builtInBrowser = pseudoBuild(INBROWSER, { siteOnly: false });
try {
  await run("pseudo", { extDir: built.ext });
  await run("zh-CN", uiLanguage("zh-CN"));
  await run("en", {});
  await runInBrowser("pseudo", { extDir: builtInBrowser.ext });
  await runInBrowser("zh-CN", { extDir: INBROWSER, ...uiLanguage("zh-CN") });
  await runInBrowser("en", { extDir: INBROWSER });
} finally {
  rmSync(built.dir, { recursive: true, force: true });
  rmSync(builtInBrowser.dir, { recursive: true, force: true });
  await server.close();
}

console.log("\n=== PSEUDO-LOCALE LAYOUT ===");
for (const r of results) console.log(`${r.status.padEnd(4)}  ${r.name}${r.note && r.status !== "PASS" ? `  —  ${r.note}` : ""}`);
const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
console.log(`\n${results.length - fails.length - skips.length}/${results.length} checks passed${skips.length ? `, ${skips.length} skipped` : ""}`);
console.log(fails.length === 0 ? "✅ PSEUDO-LOCALE GREEN" : "❌ PSEUDO-LOCALE FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
