// The automated accessibility suite: one test per surface, each in its own profile.
//
//   npm run test:a11y
//
// WHAT IT CHECKS, in three parts:
//
//  1. axe-core (WCAG 2.1 A + AA, with best-practice rules reported separately) on the
//     extension pages — popup, options, onboarding, the PDF reader — each in LIGHT and
//     DARK, and each in the state that actually has something to get wrong: the options
//     page with two site rules and the add-rule error showing, onboarding with the fixture
//     up and with it stopped, the reader empty (file picker), with a PDF rendered and
//     asking for a password.
//  2. axe again, SCOPED TO OUR OWN NODES, on the UI we inject into other people's pages:
//     a chip's detail card and the selection card. The page's own accessibility is not
//     ours; axe is therefore given our shadow host as its context, and the suite asserts
//     that it really descended into the shadow root rather than quietly checking nothing.
//     And the toolbar menu over such a page, with its flagged list and with the engine down.
//  3. The things axe cannot do, asserted in code: the keyboard walk through the toolbar
//     menu's flagged list, an accessible name for every interactive control, a visible focus
//     indicator, a 24x24 CSS-pixel hit target (WCAG 2.2 target size, minimum), colour
//     contrast computed from the RESOLVED colours (axe cannot always see through a
//     top-layer popover inside a shadow root), prefers-reduced-motion, and a visible chip
//     boundary under forced colours.
//
// Every finding fails its test; there is no list of known ones. Each test attaches what it
// scanned and measured (a11y.json) to its result.
//
// HOW axe GETS IN. Extension pages carry the MV3 page CSP (`script-src 'self'`), which
// rejects `page.addScriptTag({ content })` outright — the injected <script> is inline.
// What does work is evaluating the library's SOURCE: Playwright's `page.evaluate(string)`
// goes out as a CDP `Runtime.evaluate`, and debugger evaluations are not subject to the
// page's CSP. So the suite reads node_modules/axe-core/axe.min.js off disk once and hands
// that text to `page.evaluate` on every page it visits, extension pages included.
//
// DELIBERATE EXEMPTIONS, which are decisions and not debts:
//   - per-paragraph chips are aria-hidden="true" and unfocusable (lib/render/badge.ts): a
//     page can carry hundreds of chips, and exposing them would add hundreds of tab stops
//     and read ".38" into the middle of every sentence. The toolbar menu's flagged list is
//     the accessible route to the same verdicts, and it is keyboard-operable.
//   - the underline / tint colours are not contrast-checked (lib/render/marks.ts): they are
//     decoration over the page's own text, never a foreground colour of their own; WCAG
//     1.4.3 applies to the text, which keeps the page's colour.
//   - the host page's own violations are out of scope (test/ui-fixtures.html and every real
//     site): axe is given our shadow host as its context so only our nodes are judged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "./fixtures.mjs";
import { BADGE_SEL, waitForRegistration, popupOver, menuReport } from "../harness.mjs";
import { SMALL_PDF } from "../a11y-pdf.mjs";
import { LOCKED_PDF } from "../pdf-fixture.mjs";
import { presetConfig, seedStats, statsVisit, statsWeek } from "../stats-fixture.mjs";
import { installProbe, settle, settleAll, still, chipsSettled } from "../a11y-probe.mjs";
import { scriptEngine } from "../webengine/scripted-engine.mjs";
import { NO_MODEL_HOSTS, cancelAutoSetup } from "../webengine/model-server.mjs";

const TEST_DIR = join(import.meta.dirname, "..");
const AXE_SRC = readFileSync(join(TEST_DIR, "..", "node_modules", "axe-core", "axe.min.js"), "utf8");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];
const isBestPractice = (tags) => tags.includes("best-practice") && !tags.some((t) => /^wcag\d/.test(t));

// A name made only of punctuation is not a name: "✕" is announced as "multiplication x"
// or skipped altogether. A usable name has to carry a letter or a digit.
const usableName = (n) => /[\p{L}\p{N}]/u.test(n ?? "");
/** An element's own selector — the part of a path that survives an edit above it. */
const tail = (path) => String(path).split(" > ").pop();

// =====================================================================================
// the pages
// =====================================================================================
const PARA = (tag) =>
  `${tag} paragraph is long enough to be scored on its own because it carries well over seventy-five ordinary ` +
  "English words describing nothing in particular except the fact that a reader who never touches a mouse " +
  "must still be able to reach every verdict this extension produces, which is what the floating ball, its " +
  "counter and the triage panel behind them exist for on a page like this one, where every verdict has to " +
  "be one key press away and read out in words rather than shown only as a colour.";
// The fake fixture's verdicts are a pure function of the text — the paragraph above is kept
// word for word, its talk of a ball included — so the tags below are chosen
// (with test/fake-native.mjs's own fakeScore) to land three paragraphs AI-generated — the
// flagged ones, the menu's rows — three heavily edited and two below: every word the chips
// can say is on the page, and the menu's list has rows.
const AI_TAGS = ["FLAG-16", "FLAG-18", "FLAG-27"];
const HEAVY_TAGS = ["FLAG-4", "FLAG-8", "FLAG-11"];
const CALM_TAGS = ["FLAG-1", "FLAG-19"]; // lightly edited, human
const KEY_TAGS = [...AI_TAGS, ...HEAVY_TAGS, ...CALM_TAGS];
const KEYS_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>keyboard fixture</title></head><body style="max-width:720px;margin:0 auto;font:15px/1.6 system-ui">
${KEY_TAGS.map((t, i) => `<p id="k${i + 1}">${PARA(t)}</p>`).join("\n")}
</body></html>`;
// A selection the card can be run on. The text sits in a <textarea>, which passive
// capture never scores, so the card's own request is the only one it can produce.
const SEL_TEXT = PARA("SELECTED");
const SEL_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>selection fixture</title></head><body style="max-width:720px;margin:24px auto;font:15px/1.6 system-ui">
<h1>Analyze selection</h1><textarea id="draft" style="width:100%;height:160px">${SEL_TEXT}</textarea>
</body></html>`;
// A paragraph on a dark surface: the chip renders its dark variant (host class pg-dark),
// which has colours of its own that nothing else here would measure.
const DARK_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>dark fixture</title></head><body style="margin:0;background:#0d1117;color:#e6edf3">
<div style="max-width:720px;margin:0 auto;padding:24px;font:15px/1.6 system-ui">
${KEY_TAGS.map((t, i) => `<p id="d${i + 1}">${PARA(t)}</p>`).join("\n")}
</div></body></html>`;

// =====================================================================================
// fixtures
// =====================================================================================
const test = base.extend({
  /** The fixture pages, on this worker's page server. */
  site: async ({ pages }, use) => {
    pages.serve({
      "/ui-fixtures.html": readFileSync(join(TEST_DIR, "ui-fixtures.html"), "utf8"),
      "/keyboard.html": KEYS_HTML,
      "/selection.html": SEL_HTML,
      "/dark.html": DARK_HTML,
    });
    await use(pages.url);
  },

  /**
   * axe and the code-level checks. Every finding is a soft failure named after what it
   * judged, so one run reports all of them; what was scanned and measured is attached.
   */
  axe: async ({}, use, testInfo) => {
    const report = { scans: [], findings: [] };
    await use({
      /** Load axe into a page (CSP-proof, see the header) and confirm it arrived. */
      async inject(page) {
        await page.evaluate(AXE_SRC);
        report.axeVersion = await page.evaluate(() => (window.axe ? window.axe.version : null));
        if (!report.axeVersion) throw new Error("axe-core did not load");
      },
      /**
       * Run axe over `scope` (a CSS selector for our shadow host, or null for the whole
       * page). WCAG 2.1 A/AA and best practice are judged apart, because "your page has no
       * <main>" and "your text is unreadable" are not the same news.
       */
      async scan(page, where, scope = null) {
        const raw = await page.evaluate(
          async ({ tags, sel }) => {
            let context = document;
            if (sel) {
              const el = document.querySelector(sel);
              if (!el) return { missing: sel };
              context = el;
            }
            const r = await window.axe.run(context, { runOnly: { type: "tag", values: tags } });
            const tgt = (n) => n.target.flat(9).join(" >>> ");
            const trim = (arr) =>
              arr.map((v) => ({
                id: v.id,
                impact: v.impact,
                help: v.help,
                tags: v.tags,
                nodes: v.nodes.map((n) => ({
                  target: tgt(n),
                  html: (n.html ?? "").replace(/\s+/g, " ").slice(0, 140),
                  why: (n.any?.[0]?.message ?? n.all?.[0]?.message ?? n.failureSummary ?? "").split("\n")[0].slice(0, 220),
                })),
              }));
            const nodes = (arr) => arr.reduce((n, v) => n + v.nodes.length, 0);
            return {
              violations: trim(r.violations),
              incomplete: trim(r.incomplete),
              rules: r.violations.length + r.passes.length + r.incomplete.length + r.inapplicable.length,
              checkedNodes: nodes(r.passes) + nodes(r.violations) + nodes(r.incomplete),
              checkedTargets: [...r.passes, ...r.violations, ...r.incomplete].flatMap((v) => v.nodes.map(tgt)),
            };
          },
          { tags: AXE_TAGS, sel: scope },
        );
        expect(raw.missing, `${where}: the scope ${scope} is on the page`).toBeUndefined();
        const shape = (v) => `${v.id} (${v.nodes.length}) @ ${v.nodes[0]?.target}: ${v.nodes[0]?.why}`;
        const wcag = raw.violations.filter((v) => !isBestPractice(v.tags));
        const best = raw.violations.filter((v) => isBestPractice(v.tags));
        report.scans.push({ where, scope, rules: raw.rules, checkedNodes: raw.checkedNodes, violations: raw.violations, incomplete: raw.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length })) });
        expect.soft(wcag.map(shape), `${where} — WCAG 2.1 A/AA (${raw.rules} rules / ${raw.checkedNodes} nodes)`).toEqual([]);
        expect.soft(best.map(shape), `${where} — best practice`).toEqual([]);
        return raw;
      },
      /** A code-level check: every item is a finding, and the test fails on any. */
      findings(check, where, headline, total, items) {
        report.findings.push({ check, where, total, items });
        expect.soft(items.map((it) => it.detail), `${check}: ${where}: ${headline} (${total} checked)`).toEqual([]);
      },
      report,
    });
    await testInfo.attach("a11y.json", { body: JSON.stringify(report, null, 2), contentType: "application/json" });
  },

  /** A fresh page with axe and the probe already in it. The clipboard is granted: Copy
   *  report and a card's Copy text write to it. */
  open: async ({ context, axe, clipboard }, use) => {
    void clipboard;
    await use(async (url, { scheme = "light", viewport = null, media = {}, script } = {}) => {
      const page = await context.newPage();
      if (script) await script(page);
      if (viewport) await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: scheme, ...media });
      await page.goto(url, { waitUntil: "load" });
      await page.evaluate(installProbe);
      await axe.inject(page);
      return page;
    });
  },
});

// =====================================================================================
// the code-level checks
// =====================================================================================

/** Tab through a root and report, per stop, its name, focus ring and hit target. */
async function tabWalk(page, { max = 60, startFromTop = true } = {}) {
  // Blur alone is not a reset: Chrome remembers the sequential-focus starting point, so a
  // walk after a click would begin in the middle of the page and "find" three controls.
  // Focusing <body> itself moves that starting point back to the top of the document.
  if (startFromTop) {
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      document.activeElement?.blur?.();
      document.body.setAttribute("tabindex", "-1");
      document.body.focus();
      document.body.removeAttribute("tabindex");
    });
  }
  const stops = [];
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    // Identity, not a selector, decides when the walk has wrapped: two rows of the same
    // verdict band have the same path, and a name-based check would stop at the second.
    const stop = await page.evaluate(async (n) => {
      const el = window.__a11y.deepActive();
      if (!el || el === document.body || el === document.documentElement) return null;
      if (el.hasAttribute("data-a11y-stop")) return { repeat: true };
      el.setAttribute("data-a11y-stop", String(n));
      // A ring that transitions in (Basecoat's buttons transition `all`) is read once it has
      // arrived: read at its first frame it is still the unfocused style.
      await Promise.all(el.getAnimations({ subtree: true }).filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => {})));
      return {
        key: String(n),
        path: window.__a11y.path(el),
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role"),
        tabindex: el.getAttribute("tabindex"),
        name: window.__a11y.name(el),
        rect: window.__a11y.rect(el),
        hit: window.__a11y.hit24(el),
        focused: window.__a11y.focusStyle(el),
      };
    }, i);
    if (!stop || stop.repeat) break;
    stops.push(stop);
  }
  // The same elements with nothing focused, so a ring is a CHANGE, not a guess.
  const blurred = await page.evaluate(async () => {
    window.__a11y.deepActive()?.blur?.();
    const stops = [];
    const walk = (r) => {
      stops.push(...r.querySelectorAll("[data-a11y-stop]"));
      for (const el of r.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
    // The ring transitions out as it came in: read once it has gone.
    await Promise.all(stops.flatMap((el) => el.getAnimations({ subtree: true })).filter((a) => a.effect?.getComputedTiming().endTime !== Infinity).map((a) => a.finished.catch(() => {})));
    const out = {};
    for (const el of stops) {
      out[el.getAttribute("data-a11y-stop")] = window.__a11y.focusStyle(el);
      el.removeAttribute("data-a11y-stop");
    }
    return out;
  });
  for (const s of stops) s.ring = blurred[s.key] !== undefined && blurred[s.key] !== s.focused;
  return stops;
}

/** Name / focus ring / hit target for a set of keyboard stops. */
function judgeStops(axe, where, stops) {
  axe.findings(
    "names",
    where,
    "every keyboard-reachable control has an accessible name",
    stops.length,
    stops.filter((s) => !usableName(s.name)).map((s) => ({ detail: `${tail(s.path)} name=${JSON.stringify(s.name)}`, path: s.path })),
  );
  axe.findings(
    "focus",
    where,
    "every control shows a visible focus indicator",
    stops.length,
    stops.filter((s) => !s.ring).map((s) => ({ detail: `${tail(s.path)} (no computed change on :focus-visible)`, path: s.path })),
  );
  // Painted smaller than 24x24 is not a failure on its own — an invisible hit area counts.
  axe.findings(
    "target",
    where,
    "every control accepts a pointer over at least 24x24 CSS px (WCAG 2.2 target size, minimum)",
    stops.length,
    stops
      .filter((s) => (s.rect.w < 24 || s.rect.h < 24) && !s.hit.ok)
      .map((s) => ({ detail: `${tail(s.path)} drawn ${s.rect.w}x${s.rect.h}, 24x24 box hits ${s.hit.misses.join("/")}`, path: s.path, ...s.rect })),
  );
}

/** Every text node in one of our shadow roots, measured against what is really behind it. */
async function ourTextContrast(axe, page, where, hostSel) {
  const all = await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    if (!host) return [];
    return window.__a11y.textNodes(host.shadowRoot ?? host).map((el) => window.__a11y.contrast(el)).filter(Boolean);
  }, hostSel);
  axe.findings(
    "contrast",
    where,
    "every text node reaches its WCAG 1.4.3 ratio",
    all.length,
    all.filter((c) => !c.ok).map((c) => ({ detail: `${tail(c.path)} ${c.fg}/${c.bg} ${c.ratio}:1 (needs ${c.need})` })),
  );
}

/** The chip's own number and its card's verdict label, per band, on this page's surface. */
async function chipContrast(axe, page, label) {
  await settleAll(page);
  const measured = await page.evaluate((sel) => {
    const out = [];
    for (const host of document.querySelectorAll(sel)) {
      const root = host.shadowRoot;
      const pill = root?.querySelector(".pill");
      if (!pill) continue;
      const band = [...pill.classList].find((c) => c.startsWith("band-")) ?? "band-?";
      const num = root.querySelector(".num");
      const verdict = root.querySelector(".card .verdict");
      out.push({
        band,
        dark: host.classList.contains("pg-dark"),
        num: num ? window.__a11y.contrast(num) : null,
        verdict: verdict ? window.__a11y.contrast(verdict) : null,
      });
    }
    return out;
  }, BADGE_SEL);
  const flat = [];
  for (const m of measured) {
    if (m.num) flat.push({ what: `.pill .num ${m.band}${m.dark ? " (dark chip)" : ""}`, ...m.num });
    if (m.verdict) flat.push({ what: `.card .verdict ${m.band}${m.dark ? " (dark chip)" : ""}`, ...m.verdict });
  }
  const bands = [...new Set(measured.map((m) => m.band))].sort();
  axe.report.contrast = flat;
  axe.findings(
    "contrast",
    label,
    `chip number + card verdict, every band (${bands.join(", ")}), worst ${flat.length ? Math.min(...flat.map((c) => c.ratio)) : "—"}:1`,
    flat.length,
    flat.filter((c) => !c.ok).map((c) => ({ detail: `${c.what} ${c.fg}/${c.bg} ${c.ratio}:1` })),
  );
  expect(flat.length, `${label}: every chip and card was measured`).toBeGreaterThan(0);
  return measured;
}

// =====================================================================================
// PART 1 — the extension pages, light and dark
// =====================================================================================
const PAGE_SPECS = [
  {
    name: "popup",
    path: "popup.html",
    viewport: { width: 300, height: 620 },
    async prepare(page) {
      await page.waitForTimeout(700);
    },
  },
  {
    name: "options (two site rules, add-rule error)",
    path: "options.html",
    viewport: { width: 1100, height: 900 },
    // Two site rules are written before the options page opens; the add-rule error is then
    // provoked the way a user provokes it (submitting something that is not a hostname).
    async before(storage) {
      await storage.set({ siteOverrides: { "example.com": "off", "news.example.org": "on" } });
    },
    async prepare(page) {
      await page.waitForSelector("#sites table", { timeout: 8000 }).catch(() => {});
      await page.fill("#addHost", "  ");
      await page.click("#addRule button[type=submit]");
      await page.waitForSelector("#addError:not([hidden])", { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(200);
    },
  },
  {
    name: "onboarding (fixture up)",
    path: "onboarding.html",
    viewport: { width: 1100, height: 900 },
    async prepare(page) {
      // The status card is live: scanning it mid-probe would judge "Starting…", not the
      // state the reader ends up looking at.
      await page
        .waitForFunction(() => /Ready$/.test(document.querySelector("#componentSettings .component-status")?.textContent ?? ""), null, { timeout: 15000 })
        .catch(() => {});
      await page.waitForTimeout(300);
    },
  },
  {
    name: "reader (empty, file picker)",
    path: "reader.html",
    viewport: { width: 1100, height: 900 },
    async prepare(page) {
      await page.waitForSelector("#drop:not([hidden])", { timeout: 8000 }).catch(() => {});
    },
  },
  {
    // A chosen file exercises the full packaged viewer without a source-site grant.
    name: "reader (PDF loaded)",
    path: "reader.html",
    viewport: { width: 1100, height: 900 },
    async prepare(page) {
      await page.waitForSelector("#drop:not([hidden])");
      await page.setInputFiles("#file", { name: "doc.pdf", mimeType: "application/pdf", buffer: SMALL_PDF });
      // The pages themselves, drawn by pdf.js: the canvas is presentational and the text
      // layer over it is the accessible text, so the scan has something to read.
      await page.waitForSelector("#viewer .textLayer span", { timeout: 25000 });
      await chipsSettled(page, 1);
      await still(page);
    },
  },
  {
    name: "statistics (off)",
    path: "stats.html",
    viewport: { width: 1100, height: 900 },
    async prepare(page) {
      await page.waitForSelector("#offCard:not([hidden])", { timeout: 8000 });
    },
  },
  {
    // A week recorded in full: the headline, the trend with its table open, how it counts, the
    // tables of kinds, feeds and sites, the coverage, the pages, and a visit's replay.
    name: "statistics (a week recorded)",
    path: "stats.html",
    viewport: { width: 1100, height: 900 },
    async before(storage, extension) {
      await storage.set({ statsConfig: await presetConfig("full") });
      await seedStats(extension.worker(), statsWeek());
      await seedStats(extension.worker(), statsVisit());
    },
    async prepare(page) {
      await page.click('#ranges [data-range="7"]');
      await page.waitForSelector("#trendChart svg g.col", { timeout: 8000 });
      await page.click("#trendCard summary");
      await page.click("#lens summary");
      await page.click("#visitsTable button.linkish");
      await page.waitForSelector("#replay:not([hidden])", { timeout: 8000 });
      await page.waitForTimeout(200);
    },
  },
  {
    // The export dialog, with every field's choice shown and the preview of the file.
    name: "statistics (export)",
    path: "stats.html",
    viewport: { width: 1100, height: 900 },
    async before(storage, extension) {
      await storage.set({ statsConfig: await presetConfig("full") });
      await seedStats(extension.worker(), statsVisit());
    },
    async prepare(page) {
      await page.click("#export");
      await page.waitForSelector("#exportDialog[open]", { timeout: 8000 });
      await page.click("#exportDimsBox summary");
      await page.waitForSelector("#exportPreview details", { timeout: 8000 });
      await page.waitForTimeout(200);
    },
  },
  {
    // Settings' statistics, field by field.
    name: "settings (statistics field by field)",
    path: "options.html#statistics",
    viewport: { width: 1100, height: 900 },
    async before(storage) {
      await storage.set({ statsConfig: await presetConfig("fullText") });
    },
    async prepare(page) {
      await page.waitForSelector("#statsWarnings p", { timeout: 8000 });
      await page.click("#statsCustomize");
      await page.waitForSelector("#statsDims table.dims", { timeout: 8000 });
    },
  },
  {
    // Scan the upstream modal and its labeled password field while it is open.
    name: "reader (password asked)",
    path: "reader.html",
    viewport: { width: 1100, height: 900 },
    async prepare(page) {
      await page.waitForSelector("#drop:not([hidden])");
      await page.setInputFiles("#file", { name: "locked.pdf", mimeType: "application/pdf", buffer: LOCKED_PDF });
      await page.waitForSelector("#passwordDialog[open]", { timeout: 25000 }).catch(() => {});
      await still(page);
    },
  },
];

for (const scheme of ["light", "dark"]) {
  for (const spec of PAGE_SPECS) {
    test(`${spec.name} [${scheme}]`, async ({ extension, storage, open, axe }) => {
      await spec.before?.(storage, extension);
      const page = await open(extension.url(spec.path), { scheme, viewport: spec.viewport });
      await spec.prepare(page);
      await settle(page, scheme);
      await axe.scan(page, `${spec.name} [${scheme}]`);
      // Names, rings and hit targets do not change with the colour scheme.
      if (scheme === "light") judgeStops(axe, spec.name, await tabWalk(page, { max: 80 }));
    });
  }
}

// =====================================================================================
// PART 2 — our own UI, scoped to our nodes
// =====================================================================================

/** The UI fixtures page with its chips settled after a scroll through it. */
async function uiFixtures(open, site) {
  const page = await open(site("/ui-fixtures.html"));
  await chipsSettled(page, 3);
  await page.evaluate(async () => {
    for (let i = 0; i < 8; i++) {
      window.scrollBy(0, window.innerHeight * 0.8);
      await new Promise((r) => setTimeout(r, 250));
    }
    window.scrollTo(0, 0);
  });
  await chipsSettled(page, 5);
  await page.waitForTimeout(1200);
  await settleAll(page);
  return page;
}

test("a chip's detail card pinned open, and Copy text leaves focus outside the aria-hidden chip", async ({ open, site, axe }) => {
  const page = await uiFixtures(open, site);
  // A chip's detail card, pinned open (a tap pins what a hover shows).
  const cardHost = await page.evaluate(async (sel) => {
    const host = [...document.querySelectorAll(sel)].find((h) => h.shadowRoot?.querySelector(".pill.band-ai, .pill.band-heavy"));
    if (!host) return null;
    host.id = host.id || "a11y-card-host";
    host.scrollIntoView({ block: "center" });
    host.dispatchEvent(new MouseEvent("mouseenter"));
    host.click();
    await new Promise((r) => setTimeout(r, 500));
    return host.shadowRoot.querySelector(".card")?.classList.contains("open") ? "#" + host.id : null;
  }, BADGE_SEL);
  expect(cardHost, "a flagged chip to pin").not.toBeNull();
  await still(page, cardHost);
  const scanned = await axe.scan(page, "chip detail card (pinned open)", cardHost);
  // axe has to have gone THROUGH the shadow boundary: the card lives only inside the chip's
  // shadow root, so a checked node whose target crosses into it is proof.
  const targets = scanned.checkedTargets ?? [];
  expect(targets.some((t) => t.includes(">>>")), `axe descends into the chip's open shadow root: ${targets.length} node targets, e.g. ${targets[0] ?? "—"}`).toBe(true);
  // Unfocusable includes the pointer: focus inside the aria-hidden host is what Chrome
  // reports as "Blocked aria-hidden on an element because its descendant retained focus".
  await page.locator(`${cardHost} .act.copy`).click();
  const focused = await page.evaluate((sel) => document.querySelector(sel).shadowRoot.activeElement?.className ?? null, cardHost);
  expect(focused, "chip card: clicking Copy text leaves focus outside the aria-hidden chip").toBeNull();
});

// The selection card, triggered exactly as the context menu triggers it.
test("the selection card", async ({ open, site, axe, extension }) => {
  const page = await open(site("/selection.html"));
  await page.bringToFront();
  await page.evaluate(() => {
    const ta = document.getElementById("draft");
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
  });
  await extension.sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "analyzeSelection" });
    } catch {
      /* the content script answers nothing to this one */
    }
  });
  await page.waitForFunction(
    (sel) => [...document.querySelectorAll(sel)].some((h) => h.shadowRoot?.querySelector(".card .close") && h.shadowRoot.querySelector(".dist")),
    BADGE_SEL,
    { timeout: 15000 },
  );
  await page.evaluate((sel) => {
    const h = [...document.querySelectorAll(sel)].find((x) => x.shadowRoot?.querySelector(".card .close"));
    h.id = "a11y-sel-card";
  }, BADGE_SEL);
  await still(page, "#a11y-sel-card");
  await axe.scan(page, "selection card", "#a11y-sel-card");
  const role = await page.evaluate(() => {
    const card = document.getElementById("a11y-sel-card").shadowRoot.querySelector(".card");
    return { role: card.getAttribute("role"), text: (card.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 50) };
  });
  expect(role.role === "status" && role.text.length > 0, `selection card: the result lands in a polite status region, so it is announced: ${JSON.stringify(role)}`).toBe(true);

  // The selection card's own controls and colours.
  const info = await page.evaluate(() => {
    const close = document.getElementById("a11y-sel-card").shadowRoot.querySelector(".close");
    return { name: window.__a11y.name(close), rect: window.__a11y.rect(close), hit: window.__a11y.hit24(close), path: window.__a11y.path(close) };
  });
  axe.findings(
    "names",
    "selection card",
    "the close button has a name a screen reader can read out",
    1,
    usableName(info.name) ? [] : [{ detail: `${tail(info.path)} name=${JSON.stringify(info.name)} — a symbol, not a word (title="Close" loses to the button's own text)` }],
  );
  axe.findings(
    "target",
    "selection card",
    "the close button accepts a pointer over at least 24x24 CSS px",
    1,
    info.hit.ok ? [] : [{ detail: `${tail(info.path)} drawn ${info.rect.w}x${info.rect.h}, 24x24 box hits ${info.hit.misses.join("/")}` }],
  );
  await ourTextContrast(axe, page, "selection card", "#a11y-sel-card");
});

// =====================================================================================
// PART 3 — the checks axe cannot make
// =====================================================================================

/** The keyboard fixture with every chip settled. */
async function keyboardPage(open, site) {
  const page = await open(site("/keyboard.html"));
  expect(await chipsSettled(page, KEY_TAGS.length), "every paragraph of the keyboard fixture is read").toBe(true);
  await settleAll(page);
  return page;
}

/** The toolbar menu over `page`, at its own size and in `scheme`, with axe and the probe in it. */
async function menuOver(page, axe, scheme = "light") {
  const menu = await popupOver(page, {
    setup: async (p) => {
      await p.setViewportSize({ width: 300, height: 620 });
      await p.emulateMedia({ colorScheme: scheme });
    },
  });
  await menu.waitForFunction(() => !document.getElementById("action").disabled, null, { timeout: 10000 }).catch(() => {});
  await menu.evaluate(installProbe);
  await axe.inject(menu);
  return menu;
}

/**
 * The route the chips deliberately do not provide: the toolbar menu's flagged list. Its rows
 * are buttons in the Tab order, in the page's reading order, each named with its verdict; the
 * list is named by the title that counts them; and everything in the menu has a name, a ring,
 * a target and a contrast that pass, in light and dark.
 */
for (const scheme of ["light", "dark"]) {
  test(`the toolbar menu's flagged list over a page [${scheme}]: its rows, names, Tab order, focus rings, hit targets and contrast`, async ({ open, site, axe }) => {
    const page = await keyboardPage(open, site);
    const menu = await menuOver(page, axe, scheme);
    const flaggedTags = [...AI_TAGS, ...HEAVY_TAGS];
    await expect.poll(async () => (await menuReport(menu))?.rows.length, { message: "the menu's report lists the flagged rows" }).toBe(flaggedTags.length);
    const shown = await menuReport(menu);
    expect.soft(shown.title, "the keyboard fixture's three AI-generated and three heavily edited paragraphs are the list's rows (flagged from Heavily edited, the default)").toBe(`Flagged paragraphs (${flaggedTags.length}/${KEY_TAGS.length})`);
    for (const row of shown.rows) expect.soft(row, "each row is named with its verdict, its score and its text").toMatch(/^(AI-generated|Heavily edited), (0\.\d\d|1\.0): \S/);
    const listName = await menu.evaluate(() => window.__a11y.name(document.querySelector("#pageReport .report-list")));
    expect.soft(listName, "the list is named by the title that counts it").toBe(shown.title);
    await settle(menu, scheme);
    await axe.scan(menu, `toolbar menu with the flagged list [${scheme}]`);
    await ourTextContrast(axe, menu, `toolbar menu's report [${scheme}]`, "#pageReport");
    if (scheme !== "light") return;

    // Names, rings and hit targets do not change with the colour scheme.
    const stops = await tabWalk(menu, { max: 40 });
    judgeStops(axe, "toolbar menu with the flagged list", stops);
    // Tab reaches every row, in DOM order, and nothing has a positive tabindex.
    const order = await menu.evaluate(() => ({
      dom: [...document.querySelectorAll("#pageReport .report-result")].map((el) => el.getAttribute("aria-label")),
      positive: window.__a11y.controls(document.body).filter((el) => Number(el.getAttribute("tabindex") ?? 0) > 0).map((el) => window.__a11y.path(el)),
    }));
    const visited = stops.filter((s) => /\.report-result\b/.test(s.path)).map((s) => s.name);
    expect.soft({ visited, positive: order.positive }, "Tab walks the flagged rows in DOM order, with no positive tabindex").toEqual({ visited: order.dom, positive: [] });
    // Arrow keys are NOT a second navigation model here (the rows are plain buttons in a
    // list, not a listbox) — asserted so a change of mind is a decision, not a drift.
    await menu.locator(".report-result").first().focus();
    const beforeArrow = await menu.evaluate(() => window.__a11y.path(document.activeElement));
    await menu.keyboard.press("ArrowDown");
    await menu.waitForTimeout(80);
    const afterArrow = await menu.evaluate(() => window.__a11y.path(document.activeElement));
    expect.soft(afterArrow, "arrow keys do not move focus in the list (Tab is the only model — by design)").toBe(beforeArrow);
  });
}

// Chip colours on a light page and on a dark one (the chip has a dark variant of its own,
// chosen per anchor — nothing else in this suite would ever measure it).
test("chip colours on a light page", async ({ open, site, axe }) => {
  const page = await uiFixtures(open, site);
  await chipContrast(axe, page, "light page");
});

test("chip colours on a dark page, in the chip's dark variant", async ({ open, site, axe }) => {
  const page = await open(site("/dark.html"));
  await chipsSettled(page, 3);
  const measured = await chipContrast(axe, page, "dark page");
  // The dark fixture exists to exercise the chip's dark variant — if none rendered,
  // everything above measured the light colours twice and proved half of what it says.
  const dark = measured.filter((m) => m.dark).length;
  expect(dark, `dark page: the chip's dark variant is what was measured (${dark} of ${measured.length} chips are pg-dark)`).toBeGreaterThan(0);
});

// prefers-reduced-motion and forced colours: both are page-level emulations, so each gets
// its own page rather than being toggled under a rendered one.
test("prefers-reduced-motion: nothing of ours moves, or is left anything to run", async ({ open, site, axe }) => {
  const page = await open(site("/keyboard.html"), { media: { reducedMotion: "reduce" } });
  await chipsSettled(page, 4);
  const moving = await page.evaluate((sel) => {
    const out = [];
    for (const host of document.querySelectorAll(sel)) out.push(...window.__a11y.running(host));
    return out;
  }, BADGE_SEL);
  // Not a synthetic hover — that proves nothing, because a hover that fails to land
  // reports "no animations" too. Ask the cascade instead: under reduced motion no node of
  // ours may be left with a non-zero transition or animation duration to run AT ALL, on
  // hover, on a class flip or on a popover opening.
  const declared = await page.evaluate((sel) => {
    const out = [];
    const look = (root) => {
      for (const el of root.querySelectorAll("*")) {
        const cs = getComputedStyle(el);
        const dur = (n) => (cs[n] || "").split(",").some((v) => parseFloat(v) > 0);
        if (dur("transitionDuration")) out.push({ path: window.__a11y.path(el), what: `transition ${cs.transitionProperty} ${cs.transitionDuration}` });
        if (cs.animationName !== "none" && dur("animationDuration")) out.push({ path: window.__a11y.path(el), what: `animation ${cs.animationName} ${cs.animationDuration}` });
      }
    };
    for (const h of document.querySelectorAll(sel)) if (h.shadowRoot) look(h.shadowRoot);
    return out;
  }, BADGE_SEL);
  expect.soft([...new Set(declared.map((d) => `${tail(d.path)} ${d.what}`))], "prefers-reduced-motion: nothing of ours has a transition or animation left to run").toEqual([]);

  // The jump-target pulse is the one animation a keyboard user triggers on purpose.
  await page.evaluate((sel) => document.querySelector(sel)?.shadowRoot?.querySelector(".pill")?.classList.add("pg-flash"), BADGE_SEL);
  await page.waitForTimeout(120);
  const flashing = await page.evaluate((sel) => window.__a11y.running(document.querySelector(sel)), BADGE_SEL);
  axe.report.motion = { declared, idle: moving, flash: flashing };
  expect.soft(moving.map((m) => `${tail(m.target)}:${m.name}`), "prefers-reduced-motion: nothing of ours is animating").toEqual([]);
  expect.soft(flashing.map((m) => m.name), "prefers-reduced-motion: the jump-target pulse becomes a static outline").toEqual([]);
});

/** Under forced colours a chip must still read as a chip: a boundary the system draws. */
test("forced colours: chips keep a boundary, and a verdict its colour", async ({ open, site, axe }) => {
  const page = await open(site("/keyboard.html"), { media: { forcedColors: "active" } });
  await chipsSettled(page, 4);
  await settleAll(page);
  const pills = await page.evaluate((sel) => {
    const out = [];
    for (const host of document.querySelectorAll(sel)) {
      const pill = host.shadowRoot?.querySelector(".pill");
      if (!pill) continue;
      const cs = getComputedStyle(pill);
      // A verdict's chip is filled with its colour; a chip still waiting shows a dot.
      const coloured = pill.classList.contains("scored") ? pill : host.shadowRoot.querySelector(".dot");
      out.push({ borderStyle: cs.borderTopStyle, borderWidth: cs.borderTopWidth, borderColor: cs.borderTopColor, background: cs.backgroundColor, colourAdjust: coloured ? getComputedStyle(coloured).forcedColorAdjust : null });
    }
    return out;
  }, BADGE_SEL);
  const bad = pills.filter((p) => p.borderStyle === "none" || parseFloat(p.borderWidth) < 1 || p.borderColor === p.background);
  axe.report.forcedColors = { pills: pills.length, bad };
  expect(pills.length, "chips on the page").toBeGreaterThan(0);
  expect.soft(bad, `chips keep a visible boundary under forced colours: border ${pills[0]?.borderWidth} ${pills[0]?.borderStyle} ${pills[0]?.borderColor} on ${pills[0]?.background}`).toEqual([]);
  expect.soft(pills.map((p) => p.colourAdjust), "a verdict keeps its own colour (forced-color-adjust: none)").toEqual(pills.map(() => "none"));
});

// =====================================================================================
// PART 4 — fixture down (onboarding's other state, and the toolbar menu's)
// =====================================================================================
for (const scheme of ["light", "dark"]) {
  test(`onboarding (fixture down) [${scheme}]`, async ({ extension, nativeHost, open, axe }) => {
    await nativeHost.close();
    const page = await open(extension.url("onboarding.html"), { scheme, viewport: { width: 1100, height: 900 } });
    await page.waitForFunction(() => document.getElementById("install")?.hidden === false, null, { timeout: 15000 });
    await settle(page, scheme);
    await axe.scan(page, `onboarding (fixture down) [${scheme}]`);
    // The install command and its Copy / View script buttons exist ONLY while the fixture
    // is down, so this is the only pass that can see them.
    if (scheme === "light") judgeStops(axe, "onboarding (fixture down)", await tabWalk(page, { max: 80 }));
  });
}

test("the toolbar menu over a page while the fixture is down", async ({ nativeHost, open, site, axe }) => {
  await nativeHost.close();
  const page = await open(site("/keyboard.html"));
  const menu = await menuOver(page, axe);
  await expect(menu.locator("#status.down"), "the menu says the engine is not ready (the state axe is run on)").toHaveText("Local engine is not ready", { timeout: 25000 });
  await settle(menu);
  await axe.scan(menu, "toolbar menu, fixture down");
  await ourTextContrast(axe, menu, "toolbar menu (fixture down)", ".act");
});

// =====================================================================================
// PART 5 — the in-browser engine's setup (a device with no choice)
// =====================================================================================
// Its panel on the setup page in each state people meet on the way to Ready, scripted into
// the page (test/webengine/scripted-engine.mjs; test/inbrowser.mjs drives the real engine
// through them), the reason a download waits for Set up, the confirmation before a download
// is cancelled, the popup offering setup, and the toolbar menu over a page while the engine is
// not set up: a fresh profile's own download, cancelled. On a device with no choice a fresh
// profile starts that download by itself, so Hugging Face resolves to nothing here (NO_MODEL_HOSTS).
test.describe("the in-browser engine's setup", () => {
  test.use({ build: join(TEST_DIR, "..", "output-test", "devices", "linux-cpu-chrome"), launch: { args: [NO_MODEL_HOSTS] } });
  const painted = (page) => page.waitForFunction(() => (document.querySelector("#componentSettings .component-status")?.textContent ?? "Starting…") !== "Starting…", null, { timeout: 15000 });

  for (const scheme of ["light", "dark"]) {
    for (const state of ["needed", "downloading", "paused", "network", "ready_gpu", "ready_cpu", "load_failed"]) {
      test(`setup page, ${state} [${scheme}]`, async ({ extension, open, axe }) => {
        const page = await open(extension.url("onboarding.html"), { scheme, viewport: { width: 1100, height: 900 }, script: (p) => scriptEngine(p, state) });
        await painted(page);
        await page.evaluate(() => { const manage = document.getElementById("manage"); if (manage && !manage.hidden) manage.open = true; });
        await settle(page, scheme);
        await axe.scan(page, `setup page, ${state} [${scheme}]`);
        if (scheme === "light") judgeStops(axe, `setup page, ${state}`, await tabWalk(page, { max: 80 }));
      });
    }
  }

  test("the setup page when the download waits for Set up (Save-Data, no room)", async ({ extension, open, axe }) => {
    const page = await open(extension.url("onboarding.html"), { viewport: { width: 1100, height: 900 },
      script: (p) => scriptEngine(p, "needed", { saveData: true, estimate: { quota: 500e6, usage: 100e6 } }) });
    await painted(page);
    await page.waitForSelector("#componentSettings .engine-note:not([hidden])");
    await page.waitForSelector("#componentSettings .component-error:not([hidden])");
    await settle(page);
    await axe.scan(page, "setup page, waiting for Set up");
    judgeStops(axe, "setup page, waiting for Set up", await tabWalk(page, { max: 80 }));
  });

  test("the confirmation before a download is cancelled", async ({ extension, open, axe }) => {
    const page = await open(extension.url("onboarding.html"), { viewport: { width: 1100, height: 900 }, script: (p) => scriptEngine(p, "paused") });
    await painted(page);
    await page.click("#engine-cancel");
    await page.waitForSelector("#componentSettings dialog[open]");
    await still(page);
    expect(await page.evaluate(() => document.activeElement?.textContent), "focus starts on the button that keeps the download").toBe("Keep downloading");
    await axe.scan(page, "setup page, cancel confirmation");
  });

  test("the popup offering setup", async ({ extension, open, axe }) => {
    const page = await open(extension.url("popup.html"), { viewport: { width: 300, height: 600 }, script: (p) => scriptEngine(p, "downloading") });
    await page.waitForFunction(() => !document.getElementById("action").disabled, null, { timeout: 10000 });
    await settle(page);
    await axe.scan(page, "popup, setup downloading");
    judgeStops(axe, "popup, setup downloading", await tabWalk(page, { max: 20 }));
  });

  test("the toolbar menu over a page while the engine is not set up", async ({ extension, open, site, axe }) => {
    await waitForRegistration(extension.sw);
    await cancelAutoSetup(extension.context, extension.extId);
    const page = await open(site("/keyboard.html"));
    const menu = await menuOver(page, axe);
    await expect(menu.locator("#action"), "the menu offers to set the engine up (the state axe is run on)").toHaveText(/set up/i, { timeout: 15000 });
    await settle(menu);
    await axe.scan(menu, "toolbar menu, setup needed");
    await ourTextContrast(axe, menu, "toolbar menu (setup needed)", ".act");
  });
});

// =====================================================================================
// PART 6 — which engine: the choice, the local engine alone, a device that cannot run
// the model, Settings' switch and the crash fallback
// =====================================================================================
// Each on a copy of the test build that stands in for a device (test/test-build.mjs
// deviceBuild, test/pw/devices.mjs). Nothing downloads on these screens.
const device = (name, granted = false) => join(TEST_DIR, "..", "output-test", "devices", `${name}-chrome${granted ? "-granted" : ""}`);
const choiceUp = (page, selector) => page.waitForFunction((s) => { const el = document.querySelector(s); return !!el && el.getClientRects().length > 0; }, selector, { timeout: 15000 });

for (const [name, what, selector] of [["apple-silicon", "the choice of engines", "#engine-pick-inbrowser"], ["linux-2gb", "a device that cannot run the model", ".engine-cannot"]]) {
  test.describe(`the setup page: ${what}`, () => {
    test.use({ build: device(name), launch: { args: [NO_MODEL_HOSTS] } });
    for (const scheme of ["light", "dark"]) {
      test(`${what} [${scheme}]`, async ({ extension, open, axe }) => {
        const page = await open(extension.url("onboarding.html"), { scheme, viewport: { width: 1100, height: 900 } });
        await choiceUp(page, selector);
        await settle(page, scheme);
        await axe.scan(page, `setup page, ${what} [${scheme}]`);
        if (scheme === "light") judgeStops(axe, `setup page, ${what}`, await tabWalk(page, { max: 80 }));
      });
    }
  });
}

test.describe("the setup page: the local engine refused", () => {
  test.use({ build: device("apple-silicon"), launch: { args: [NO_MODEL_HOSTS] } });
  test("a refused permission, back at the choice", async ({ extension, open, axe }) => {
    // The browser's prompt, which no automation can click, answered No.
    const page = await open(extension.url("onboarding.html"), { viewport: { width: 1100, height: 900 },
      script: (p) => p.addInitScript(() => { chrome.permissions.request = async () => false; }) });
    await choiceUp(page, "#engine-pick-native");
    await page.click("#engine-pick-native");
    await choiceUp(page, ".engine-choice .engine-error");
    await settle(page);
    expect(await page.evaluate(() => document.querySelector(".engine-choice .engine-error")?.getAttribute("role")), "the reason is announced").toBe("alert");
    await axe.scan(page, "setup page, the local engine refused");
  });
});

test.describe("Settings: switching engines", () => {
  test.use({ build: device("linux-cpu"), launch: { args: [NO_MODEL_HOSTS] } });
  test("the switch, and the in-browser engine's files offered for deletion", async ({ extension, open, axe }) => {
    // Files the in-browser engine left, as a download cut short leaves them, beside the local engine in use.
    const seed = await open(extension.url("options.html"));
    await seed.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("anagram-engine", { create: true });
      const writable = await (await dir.getFileHandle("model.onnx.part", { create: true })).createWritable();
      await writable.write(new Uint8Array(3e6)); await writable.close();
    });
    await seed.close();
    for (const scheme of ["light", "dark"]) {
      const page = await open(extension.url("options.html"), { scheme, viewport: { width: 1100, height: 900 }, script: (p) => scriptEngine(p, "needed", { engine: "native" }) });
      await choiceUp(page, "#engine-delete-leftover");
      await choiceUp(page, "#engine-switch");
      await settle(page, scheme);
      await axe.scan(page, `Settings, switch and leftover files [${scheme}]`);
      if (scheme === "light") judgeStops(axe, "Settings, switch and leftover files", await tabWalk(page, { max: 120 }));
      await page.close();
    }
  });
});

test.describe("the local engine kept crashing", () => {
  test.use({ build: device("apple-silicon", true) });
  test("the setup page and the popup offer the in-browser engine beside Retry", async ({ extension, open, axe }) => {
    const setup = await open(extension.url("onboarding.html"), { viewport: { width: 1100, height: 900 }, script: (p) => scriptEngine(p, "ready_gpu", { engine: "native", crashed: true }) });
    await choiceUp(setup, "#engine-crash-switch");
    expect(await setup.evaluate(() => document.getElementById("component-primary")?.textContent), "Retry beside it").toBe("Retry");
    await settle(setup);
    await axe.scan(setup, "setup page, the local engine crashing");
    judgeStops(axe, "setup page, the local engine crashing", await tabWalk(setup, { max: 80 }));
    const popup = await open(extension.url("popup.html"), { viewport: { width: 300, height: 600 }, script: (p) => scriptEngine(p, "ready_gpu", { engine: "native", crashed: true }) });
    await choiceUp(popup, "#switchEngine");
    expect(await popup.evaluate(() => [document.getElementById("status")?.textContent, document.getElementById("action")?.textContent]), "the popup says why, with Retry")
      .toEqual(["The local engine kept stopping unexpectedly", "Retry"]);
    await settle(popup);
    await axe.scan(popup, "popup, the local engine crashing");
    judgeStops(axe, "popup, the local engine crashing", await tabWalk(popup, { max: 20 }));
  });
});
