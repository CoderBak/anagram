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
//     the ball with its panel closed and open (flagged rows + the verdict filters), a
//     chip's detail card, the selection card, and the panel's fixture-down notice. The
//     page's own accessibility is not ours; axe is therefore given our shadow host as its
//     context, and the suite asserts that it really descended into the shadow root rather
//     than quietly checking nothing.
//  3. The things axe cannot do, asserted in code: the keyboard walk to and through the
//     triage panel, an accessible name for every interactive control, a visible focus
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
//     and read ".38" into the middle of every sentence. The triage panel behind the ball
//     is the accessible route to the same verdicts, and it is keyboard-operable.
//   - the underline / tint colours are not contrast-checked (lib/render/marks.ts): they are
//     decoration over the page's own text, never a foreground colour of their own; WCAG
//     1.4.3 applies to the text, which keeps the page's colour.
//   - the host page's own violations are out of scope (test/ui-fixtures.html and every real
//     site): axe is given our shadow host as its context so only our nodes are judged.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "./fixtures.mjs";
import { BADGE_SEL, waitForRegistration } from "../harness.mjs";
import { SMALL_PDF } from "../a11y-pdf.mjs";
import { LOCKED_PDF } from "../pdf-fixture.mjs";
import { installProbe, settle, settleAll, still, fabReady, untuck, chipsSettled } from "../a11y-probe.mjs";
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
// The fake fixture's verdicts are a pure function of the text, so the tags below are chosen
// (with test/fake-native.mjs's own fakeScore) to land three paragraphs AI-generated — the
// flagged ones, the panel's rows — three heavily edited and two below: every word the chips
// can say is on the page, and the panel has rows and a Copy report button.
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
    // Focus landing in the ball brings it out of its idle tuck (half off the edge) with a
    // transition. Measured mid-flight, the counter's 24x24 box still hangs outside the
    // viewport and "hits nothing" — which is what the Windows runner reported for the
    // reader page, the one extension page that has a ball and takes long enough to load
    // for the ball to have tucked. Let it arrive before anything about it is measured.
    if (await page.evaluate(() => document.activeElement?.id === "anagram-fab")) await still(page);
    // Identity, not a selector, decides when the walk has wrapped: two rows of the same
    // verdict band have the same path, and a name-based check would stop at the second.
    const stop = await page.evaluate((n) => {
      const el = window.__a11y.deepActive();
      if (!el || el === document.body || el === document.documentElement) return null;
      if (el.hasAttribute("data-a11y-stop")) return { repeat: true };
      el.setAttribute("data-a11y-stop", String(n));
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
  const blurred = await page.evaluate(() => {
    window.__a11y.deepActive()?.blur?.();
    const out = {};
    const walk = (r) => {
      for (const el of r.querySelectorAll("[data-a11y-stop]")) {
        out[el.getAttribute("data-a11y-stop")] = window.__a11y.focusStyle(el);
        el.removeAttribute("data-a11y-stop");
      }
      for (const el of r.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot);
    };
    walk(document);
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

/** Open the panel from the counter, as a click does. */
const openPanel = (page) =>
  page.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));

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
      // state the reader ends up looking at. The Manage and Advanced folds are closed by
      // default, and a closed one is display:none — open them so they are judged too.
      await page
        .waitForFunction(() => document.querySelector("#componentSettings .component-status")?.textContent === "Ready", null, { timeout: 15000 })
        .catch(() => {});
      await page.evaluate(() => {
        for (const d of document.querySelectorAll("#manage, #advanced")) d.setAttribute("open", "");
      });
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
      await spec.before?.(storage);
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

test("the ball at rest, and axe really descends into its shadow root", async ({ open, site, axe }) => {
  const page = await uiFixtures(open, site);
  // Untuck first: a tucked ball sits half off the edge at 62% opacity, and every colour
  // read through it would be a blend of our surface and the page.
  expect(await fabReady(page), "the ball mounted").toBe(true);
  await untuck(page);
  const closed = await axe.scan(page, "ball (panel closed)", "#anagram-fab");
  // axe has to have gone THROUGH the shadow boundary: the counter button lives only
  // inside #anagram-fab's shadow root, so a checked node whose target names it is proof.
  const targets = closed.checkedTargets ?? [];
  expect(targets.some((t) => t.includes(">>>") && /\.count\b/.test(t)), `axe descends into the ball's open shadow root: ${targets.length} node targets, e.g. ${targets[0] ?? "—"}`).toBe(true);
});

test("the triage panel open with flagged rows", async ({ open, site, axe }) => {
  const page = await uiFixtures(open, site);
  expect(await fabReady(page), "the ball mounted").toBe(true);
  await untuck(page);
  await openPanel(page);
  const panelState = await page.evaluate(() => {
    const panel = document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".panel");
    if (!panel) return { open: false, items: 0, filters: [] };
    return { open: panel.classList.contains("open"), items: panel.querySelectorAll(".pitem").length, filters: [...panel.querySelectorAll(".fchip")].map((c) => c.textContent) };
  });
  await still(page);
  await page
    .waitForFunction(() => getComputedStyle(document.getElementById("anagram-fab").shadowRoot.querySelector(".panel")).opacity === "1", null, { timeout: 4000 })
    .catch(() => {});
  // Which bands this page happens to produce is the fixture's business, not a contract —
  // the deterministic state is scanned on the suite's own keyboard fixture below, where the
  // verdicts are chosen.
  expect(panelState.open && panelState.items > 0, `triage panel opens with flagged rows (the state axe is run on): ${JSON.stringify(panelState)}`).toBe(true);
  await axe.scan(page, "ball (panel open, flagged rows)", "#anagram-fab");
});

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
  await axe.scan(page, "chip detail card (pinned open)", cardHost);
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

/** The keyboard fixture, every chip settled and the ball counting its three flagged rows. */
async function keyboardPage(open, site) {
  const page = await open(site("/keyboard.html"));
  await chipsSettled(page, KEY_TAGS.length);
  await settleAll(page);
  expect(await fabReady(page), "the ball mounted").toBe(true);
  await expect
    .poll(() => page.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".count")?.textContent), { message: "the counter settles on the three flagged paragraphs" })
    .toBe(String(AI_TAGS.length));
  return page;
}

/**
 * The three things a screen reader would otherwise never be told. Automation can only go
 * as far as reading what the live region says after the event — whether a real screen
 * reader speaks it is for a human with VoiceOver.
 */
test("the ball's live region: its shape, the settled count, and Copy report said out loud", async ({ open, site }) => {
  const page = await keyboardPage(open, site);
  const live = () => page.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".live")?.textContent ?? null);
  const shape = await page.evaluate(() => {
    const el = document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".live");
    if (!el) return null;
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      role: el.getAttribute("role"),
      polite: el.getAttribute("aria-live"),
      hiddenToEyes: r.width <= 1 && r.height <= 1,
      // display:none would take it out of the accessibility tree along with the pixels.
      rendered: cs.display !== "none" && cs.visibility !== "hidden",
    };
  });
  expect.soft(shape, "the ball carries one polite live region, clipped rather than hidden").toEqual({ role: "status", polite: "polite", hiddenToEyes: true, rendered: true });

  // The count settles over several seconds; the announcement waits for it to hold still.
  await page.waitForTimeout(2500);
  const said = await live();
  const counter = await page.evaluate(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent ?? null);
  expect.soft(
    typeof said === "string" && new RegExp(`^${counter} flagged paragraphs? on this page$`).test(said),
    `the settled flagged count is said once, and matches the counter: ${JSON.stringify({ said, counter })}`,
  ).toBe(true);

  // Copy report confirms itself by swapping a label — invisible to a screen reader.
  await openPanel(page);
  await still(page);
  await page.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".pcopy")?.click());
  await page.waitForTimeout(500);
  const copied = await live();
  const label = await page.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".pcopy")?.textContent ?? null);
  expect.soft(/copied/i.test(copied ?? "") && /Copied/.test(label ?? ""), `"Copy report" says so out loud, not only by changing its own label: ${JSON.stringify({ copied, label })}`).toBe(true);
});

/** The keyboard route the chips deliberately do not provide: ball → counter → panel. */
test("the keyboard walk: Tab to the ball and the counter, Enter into the panel, Tab through it, Escape out", async ({ open, site }) => {
  const page = await keyboardPage(open, site);
  await untuck(page);
  // 1. Tab reaches the ball, and then the counter — in that order.
  const order = await tabWalk(page, { max: 12 });
  const ball = order.findIndex((s) => /\.chip\.fab|\.fab\b/.test(s.path));
  const count = order.findIndex((s) => /\.count\b/.test(s.path));
  expect.soft(ball >= 0 && count >= 0 && ball < count, `Tab reaches the ball and then the flagged counter: ${JSON.stringify({ order: order.map((s) => tail(s.path)), ball, count })}`).toBe(true);

  // 2. Enter on the counter opens the panel and hands the keyboard over.
  await page.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".count").focus());
  await page.keyboard.press("Enter");
  await page.waitForTimeout(400);
  const opened = await page.evaluate(() => {
    const sr = document.getElementById("anagram-fab").shadowRoot;
    const panel = sr.querySelector(".panel");
    return {
      open: panel.classList.contains("open"),
      role: panel.getAttribute("role"),
      named: !!sr.getElementById(panel.getAttribute("aria-labelledby") ?? "")?.textContent,
      inside: !!sr.activeElement && panel.contains(sr.activeElement),
      landedOn: sr.activeElement ? window.__a11y.path(sr.activeElement).split(" > ").pop() : null,
      expanded: sr.querySelector(".count").getAttribute("aria-expanded"),
    };
  });
  expect.soft(opened, "Enter opens the panel as a named dialog and focus lands inside it").toMatchObject({ open: true, role: "dialog", named: true, inside: true, expanded: "true" });

  // 3. Tab order inside the panel: DOM order, everything reachable, nothing with a
  //    positive tabindex, and the last stop is the panel's own last control.
  const inner = await page.evaluate(() => {
    const panel = document.getElementById("anagram-fab").shadowRoot.querySelector(".panel");
    return {
      dom: window.__a11y.controls(panel).map((el) => window.__a11y.path(el).split(" > ").pop()),
      positive: window.__a11y.controls(panel).filter((el) => Number(el.getAttribute("tabindex") ?? 0) > 0).map((el) => window.__a11y.path(el)),
    };
  });
  const visited = [];
  for (let i = 0; i < inner.dom.length + 3; i++) {
    const at = await page.evaluate(() => {
      const sr = document.getElementById("anagram-fab").shadowRoot;
      const el = sr.activeElement;
      return el && sr.querySelector(".panel").contains(el) ? window.__a11y.path(el).split(" > ").pop() : null;
    });
    if (at) visited.push(at);
    else break;
    await page.keyboard.press("Tab");
    await page.waitForTimeout(40);
  }
  const start = inner.dom.indexOf(visited[0]);
  const expected = start >= 0 ? inner.dom.slice(start) : [];
  expect.soft(
    visited.length > 1 && inner.positive.length === 0 && JSON.stringify(visited) === JSON.stringify(expected),
    `Tab walks the panel's controls in DOM order, with no positive tabindex: ${JSON.stringify({ visited, expected, positive: inner.positive })}`,
  ).toBe(true);
  // Arrow keys are NOT a second navigation model here (the rows are plain buttons in a
  // dialog, not a listbox) — asserted so a change of mind is a decision, not a drift.
  await page.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".panel .pitem")?.focus());
  const beforeArrow = await page.evaluate(() => window.__a11y.path(document.getElementById("anagram-fab").shadowRoot.activeElement));
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(80);
  const afterArrow = await page.evaluate(() => window.__a11y.path(document.getElementById("anagram-fab").shadowRoot.activeElement));
  expect.soft(afterArrow, "arrow keys do not move focus in the panel (Tab is the only model — by design)").toBe(beforeArrow);

  // 4. Escape closes it and gives the keyboard back to the counter.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => {
    const sr = document.getElementById("anagram-fab").shadowRoot;
    return { open: !!sr.querySelector(".panel.open"), back: sr.activeElement === sr.querySelector(".count"), expanded: sr.querySelector(".count").getAttribute("aria-expanded") };
  });
  expect.soft(closed, "Escape closes the panel and returns focus to the counter").toEqual({ open: false, back: true, expanded: "false" });
});

/** Names, rings, hit targets and contrast for the panel's own controls. */
test("the panel's controls: its rows, names, focus rings, hit targets and contrast", async ({ open, site, axe }) => {
  const page = await keyboardPage(open, site);
  await openPanel(page);
  await still(page);
  const state = await page.evaluate(() => {
    const panel = document.getElementById("anagram-fab").shadowRoot.querySelector(".panel");
    return { open: panel.classList.contains("open"), items: panel.querySelectorAll(".pitem").length, filters: [...panel.querySelectorAll(".fchip")].map((c) => c.textContent), copy: !!panel.querySelector(".pcopy") };
  });
  expect.soft(state, "the keyboard fixture's three AI-generated paragraphs are the panel's rows (heavily edited ones are not flagged)").toEqual({ open: true, items: 3, filters: [], copy: true });
  await axe.scan(page, "ball (panel open)", "#anagram-fab");
  const stops = await tabWalk(page, { max: 40 });
  const ours = stops.filter((s) => s.path.includes("#anagram-fab"));
  expect.soft(ours.length, "ball + panel: the walk reached our controls at all").toBeGreaterThan(2);
  judgeStops(axe, "ball + panel", ours);

  // The counter and the panel's scores, computed from the resolved colours: axe
  // reads these through a top-layer popover inside a shadow root and can get them wrong.
  await ourTextContrast(axe, page, "panel (flagged)", "#anagram-fab");
  const counter = await page.evaluate(() => window.__a11y.contrast(document.getElementById("anagram-fab").shadowRoot.querySelector(".count")));
  axe.findings(
    "contrast",
    "counter (flagged)",
    `the flagged counter's number reads on its own surface (${counter.fg} on ${counter.bg} = ${counter.ratio}:1)`,
    1,
    counter.ok ? [] : [{ detail: `button.count ${counter.fg}/${counter.bg} ${counter.ratio}:1 (needs ${counter.need})` }],
  );
  const pscore = await page.evaluate(() => [...document.getElementById("anagram-fab").shadowRoot.querySelectorAll(".panel .pscore")].map((el) => window.__a11y.contrast(el)));
  axe.findings(
    "contrast",
    "panel .pscore",
    `every verdict score reads on the panel surface (worst ${pscore.length ? Math.min(...pscore.map((c) => c.ratio)) : "—"}:1)`,
    pscore.length,
    pscore.filter((c) => !c.ok).map((c) => ({ detail: `${tail(c.path)} ${c.fg}/${c.bg} ${c.ratio}:1` })),
  );
});

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

// The panel on a dark page. It has a dark variant of its own (the chip card's, same
// probe), so the surface every colour in it is judged against is a different one.
test("the triage panel on a dark page", async ({ open, site, axe }) => {
  const page = await open(site("/dark.html"));
  await chipsSettled(page, 4);
  await settleAll(page);
  expect(await fabReady(page), "the ball mounted").toBe(true);
  await untuck(page);
  await openPanel(page);
  await still(page);
  const state = await page.evaluate(() => {
    const host = document.getElementById("anagram-fab");
    const panel = host?.shadowRoot?.querySelector(".panel");
    if (!panel) return { dark: false, open: false, surface: null, items: 0 };
    return { dark: host.classList.contains("pg-dark"), open: panel.classList.contains("open"), surface: getComputedStyle(panel).backgroundColor, items: panel.querySelectorAll(".pitem").length };
  });
  expect.soft(
    state.dark && state.open && state.surface === "rgb(23, 23, 23)" && state.items > 0,
    `the triage panel takes the page's dark surface (the same probe the chips use): ${JSON.stringify(state)}`,
  ).toBe(true);
  await axe.scan(page, "ball (panel open, dark page)", "#anagram-fab");
  await ourTextContrast(axe, page, "panel (dark page)", "#anagram-fab");
  // A near-black focus ring on a near-black panel is no ring at all.
  const stops = await tabWalk(page, { max: 40 });
  judgeStops(axe, "ball + panel (dark page)", stops.filter((s) => s.path.includes("#anagram-fab")));
});

// prefers-reduced-motion and forced colours: both are page-level emulations, so each gets
// its own page rather than being toggled under a rendered one.
test("prefers-reduced-motion: nothing of ours moves, or is left anything to run", async ({ open, site, axe }) => {
  const page = await open(site("/keyboard.html"), { media: { reducedMotion: "reduce" } });
  await chipsSettled(page, 4);
  expect(await fabReady(page), "the ball mounted").toBe(true);
  await untuck(page);
  const moving = await page.evaluate((sel) => {
    const out = [];
    for (const host of [document.getElementById("anagram-fab"), ...document.querySelectorAll(sel)]) if (host) out.push(...window.__a11y.running(host));
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
    const fab = document.getElementById("anagram-fab");
    if (fab?.shadowRoot) look(fab.shadowRoot);
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
test("forced colours: chips keep a boundary, and the verdict dot its colour", async ({ open, site, axe }) => {
  const page = await open(site("/keyboard.html"), { media: { forcedColors: "active" } });
  await chipsSettled(page, 4);
  await settleAll(page);
  const pills = await page.evaluate((sel) => {
    const out = [];
    for (const host of document.querySelectorAll(sel)) {
      const pill = host.shadowRoot?.querySelector(".pill");
      if (!pill) continue;
      const cs = getComputedStyle(pill);
      const dot = host.shadowRoot.querySelector(".dot");
      out.push({ borderStyle: cs.borderTopStyle, borderWidth: cs.borderTopWidth, borderColor: cs.borderTopColor, background: cs.backgroundColor, dotAdjust: dot ? getComputedStyle(dot).forcedColorAdjust : null });
    }
    return out;
  }, BADGE_SEL);
  const bad = pills.filter((p) => p.borderStyle === "none" || parseFloat(p.borderWidth) < 1 || p.borderColor === p.background);
  axe.report.forcedColors = { pills: pills.length, bad };
  expect(pills.length, "chips on the page").toBeGreaterThan(0);
  expect.soft(bad, `chips keep a visible boundary under forced colours: border ${pills[0]?.borderWidth} ${pills[0]?.borderStyle} ${pills[0]?.borderColor} on ${pills[0]?.background}`).toEqual([]);
  expect.soft(pills.map((p) => p.dotAdjust), "the verdict dot keeps its own colour (forced-color-adjust: none)").toEqual(pills.map(() => "none"));
});

// =====================================================================================
// PART 4 — fixture down (onboarding's other state, and the panel's notice)
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

test("the fixture-down notice in the panel", async ({ nativeHost, open, site, axe }) => {
  await nativeHost.close();
  const page = await open(site("/keyboard.html"));
  await page.waitForFunction(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent === "!", null, { timeout: 25000 });
  await untuck(page);
  await openPanel(page);
  await still(page);
  const notice = await page.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".panel .pnotice")?.textContent ?? null);
  expect(notice, "fixture-down notice renders in the panel (the state axe is run on)").toBeTruthy();
  await axe.scan(page, "ball (panel open, fixture-down notice)", "#anagram-fab");
  await ourTextContrast(axe, page, "panel (fixture down)", "#anagram-fab");
});

// =====================================================================================
// PART 5 — the in-browser engine's setup (the oneclick build)
// =====================================================================================
// Its panel on the setup page in each state people meet on the way to Ready, scripted into
// the page (test/webengine/scripted-engine.mjs; test/oneclick.mjs drives the real engine
// through them), the reason a download waits for Set up, the confirmation before a download
// is cancelled, the popup offering setup, and the panel's notice on a page while the engine is
// not set up: a fresh profile's own download, cancelled. A fresh profile starts that download
// by itself, so Hugging Face resolves to nothing here (NO_MODEL_HOSTS).
test.describe("the in-browser engine's setup (oneclick build)", () => {
  test.use({ build: join(TEST_DIR, "..", "output-test", "oneclick-chrome-mv3"), launch: { args: [NO_MODEL_HOSTS] } });
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

  test("the panel's notice while the engine is not set up", async ({ extension, open, site, axe }) => {
    await waitForRegistration(extension.sw);
    await cancelAutoSetup(extension.context, extension.extId);
    const page = await open(site("/keyboard.html"));
    await page.waitForFunction(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent === "!", null, { timeout: 25000 });
    await untuck(page);
    await openPanel(page);
    await page.waitForFunction(() => /set up/i.test(document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".panel .pnotice button")?.textContent ?? ""), null, { timeout: 15000 });
    await still(page);
    await axe.scan(page, "ball (panel open, setup notice)", "#anagram-fab");
    await ourTextContrast(axe, page, "panel (setup notice)", "#anagram-fab");
  });
});
