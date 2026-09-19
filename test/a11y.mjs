// test/a11y.mjs — the automated accessibility suite.
//
//   npm run test:a11y            # everything (headless, fake daemon, no window)
//   node test/a11y.mjs --json    # print the machine report to stdout as well
//
// WHAT IT CHECKS, in three parts:
//
//  1. axe-core (WCAG 2.1 A + AA, with best-practice rules reported separately) on the
//     four extension pages — popup, options, onboarding, the PDF reader — each in LIGHT
//     and DARK, and each in the state that actually has something to get wrong: the
//     options page with two site rules and the add-rule error showing, onboarding with
//     the daemon up and with it stopped, the reader empty (file picker) and with a PDF
//     rendered.
//  2. axe again, SCOPED TO OUR OWN NODES, on the UI we inject into other people's pages:
//     the ball with its panel closed and open (flagged rows + the verdict filters), a
//     chip's detail card, the selection card, and the panel's daemon-down notice. The
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
// HOW axe GETS IN. Extension pages carry the MV3 page CSP (`script-src 'self'`), which
// rejects `page.addScriptTag({ content })` outright — the injected <script> is inline.
// What does work is evaluating the library's SOURCE: Playwright's `page.evaluate(string)`
// goes out as a CDP `Runtime.evaluate`, and debugger evaluations are not subject to the
// page's CSP. So the suite reads node_modules/axe-core/axe.min.js off disk once and hands
// that text to `page.evaluate` on every page it visits, extension pages included. (Every
// other in-page helper below is a plain function, which Playwright ships the same way.)
//
// WHY IT IS NOT RED TODAY. Product code is off limits on this branch, so the suite starts
// from two BASELINES — one for axe's rules, one for the code-level checks: every finding
// that existed the day it was written is listed below, with the node and one line on what
// it costs a user. The suite FAILS only on findings that are NOT in those lists — new
// regressions — and prints "known: N" on every run so the debt cannot quietly become the
// floor. Deliberate exemptions (the chips are aria-hidden and unfocusable ON PURPOSE) are
// a third list: they are decisions, not debts.
//
// WHY IT WAITS. Colours are only read once nothing is moving. A chip that has just learned
// it sits on a dark surface transitions `background-color` over 130 ms, and a reading taken
// inside that window pairs the OLD white surface with the NEW text colour — a 2.5:1 failure
// no user ever sees. settleAll() waits for document.getAnimations() to go quiet (it reaches
// into shadow trees), settle() also waits for the emulated colour scheme to land, and the
// ball is taken out of its idle tuck before anything is measured through its 62% opacity.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import http from "node:http";
import { launchExtension, serveHtml, artifact, BADGE_SEL, requireBuild } from "./harness.mjs";
import { startFakeDaemon } from "./fake-daemon.mjs";
import { SMALL_PDF } from "./a11y-pdf.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PRINT_JSON = process.argv.includes("--json");

// =====================================================================================
// BASELINE — the accessibility debt that already existed when this suite was written.
// =====================================================================================
// An entry is matched on `<where> :: <rule id>` and carries the nodes that fired on the
// day it was written, so the list reads as the debt it is. It is deliberately NOT matched
// per node: axe's targets on the extension pages are nth-child paths ("region@.card:nth-
// child(5)"), and three other branches are editing those pages this week — a button added
// to the popup would renumber every target and turn the whole list red without a single
// new accessibility problem. A rule that was not firing here before IS new, and fails.
// Node counts are printed on every run (`known: R rules / N nodes`) so growth inside a
// known rule is still visible, and an axe entry that stops firing is a FAIL of its own so
// the list shrinks as the debt is paid instead of fossilising.
const BASELINE = [
  // ---- our own injected UI ------------------------------------------------------------

  // ---- the extension pages -------------------------------------------------------------
  {
    where: "popup [light]",
    rule: "color-contrast",
    target: '4 nodes: .hint-line kbd (the "Alt + Shift + P / L" key hints)',
    why: "Basecoat's .kbd is #737373 on #f5f5f5 = 4.34:1 (needs 4.5). Light scheme only; the dark popup passes.",
  },
  {
    where: "options (two site rules, add-rule error) [light]",
    rule: "color-contrast",
    target: "18 nodes: <code> spans (including the new Advanced field's) and .shortcuts .kbd",
    why: "The same #737373-on-#f5f5f5 pair, here on every inline <code> (the daemon commands and URLs a user has to read to fix a broken install) and on the shortcut keys.",
  },
  {
    where: "options (two site rules, add-rule error) [dark]",
    rule: "color-contrast",
    target: ".mode-on (the per-site rules table's \u201cAlways on\u201d cell)",
    why: "oklch(0.55 0.15 150) = #05893e on the dark card #171717 = 3.97:1. The green is picked for a light background and never re-picked for dark. entrypoints/options/index.html .mode-on.",
  },
  {
    where: "options (two site rules, add-rule error) [light]",
    rule: "empty-table-header",
    target: "th:nth-child(3)",
    why: 'The per-site rules table\'s actions column has an empty <th>, so the "Remove" column is announced as nothing.',
  },
  { where: "options (two site rules, add-rule error) [dark]", rule: "empty-table-header", target: "th:nth-child(3)", why: "Same empty <th>, dark scheme." },
  {
    where: "options (two site rules, add-rule error) [light]",
    rule: "landmark-one-main",
    target: "html",
    why: "The options page has no <main>: there is no skip target and no landmark to jump to.",
  },
  { where: "options (two site rules, add-rule error) [dark]", rule: "landmark-one-main", target: "html", why: "Same missing <main>, dark scheme." },
  {
    where: "options (two site rules, add-rule error) [light]",
    rule: "region",
    target: "20 nodes: every .card, the table rows and the new Advanced field",
    why: "Consequence of the missing <main>: none of the page's content sits in a landmark, so a screen-reader user cannot navigate it by region.",
  },
  { where: "options (two site rules, add-rule error) [dark]", rule: "region", target: "20 nodes", why: "Same, dark scheme." },
  {
    where: "onboarding (daemon up) [light]",
    rule: "color-contrast",
    target: "10 nodes: .kbd keys and <code>",
    why: "The same Basecoat .kbd / <code> pair (4.34:1) on the first page a new user ever sees.",
  },
  {
    where: "onboarding (daemon down) [light]",
    rule: "color-contrast",
    target: "11 nodes: #install-cmd plus the same .kbd keys and <code>",
    why:
      "Same page in its daemon-down state, where the setup strip also prints the install " +
      "command as a <code> pill — the one line a user has to read to get anywhere.",
  },
  { where: "onboarding (daemon up) [light]", rule: "landmark-one-main", target: "html", why: "The onboarding page has no <main> either." },
  { where: "onboarding (daemon up) [dark]", rule: "landmark-one-main", target: "html", why: "Same, dark scheme." },
  { where: "onboarding (daemon down) [light]", rule: "landmark-one-main", target: "html", why: "Same, daemon-down state." },
  { where: "onboarding (daemon down) [dark]", rule: "landmark-one-main", target: "html", why: "Same, daemon-down state, dark scheme." },
  { where: "onboarding (daemon up) [light]", rule: "region", target: "9 nodes: .lede, the setup strip's card header and every other .card", why: "Consequence of the missing <main>." },
  { where: "onboarding (daemon up) [dark]", rule: "region", target: "9 nodes", why: "Same, dark scheme." },
  { where: "onboarding (daemon down) [light]", rule: "region", target: "10 nodes (the install line joins them)", why: "Same, daemon-down state." },
  { where: "onboarding (daemon down) [dark]", rule: "region", target: "10 nodes", why: "Same, daemon-down state, dark scheme." },
  {
    where: "reader (empty, file picker) [light]",
    rule: "page-has-heading-one",
    target: "html",
    why: 'The PDF reader\'s document title is a <div class="t">, not an <h1>, so the page a whole PDF is read in has no heading to land on.',
  },
  { where: "reader (empty, file picker) [dark]", rule: "page-has-heading-one", target: "html", why: "Same, dark scheme." },
  { where: "reader (PDF loaded) [light]", rule: "page-has-heading-one", target: "html", why: "Same with a document rendered — the PDF's own heading becomes an <h2> under no <h1>." },
  { where: "reader (PDF loaded) [dark]", rule: "page-has-heading-one", target: "html", why: "Same, dark scheme." },
];

// The same idea for the checks axe cannot make (names, focus rings, hit targets, contrast).
// The key is `<check> :: <where> :: <the element's own selector>` — the tail of the path,
// because everything above it renumbers when a page is edited.
const CODE_BASELINE = [
  // Empty, and meant to stay that way: every name, focus ring, hit target and computed
  // contrast this suite measures now passes. An entry here is a debt, not a setting.
];

// Deliberate decisions, listed apart from the debts above so the two are never confused.
const EXEMPTIONS = [
  {
    what: 'per-paragraph chips are aria-hidden="true" and unfocusable',
    where: "lib/render/badge.ts (buildHost)",
    why:
      "A page can carry hundreds of chips. Exposing them would add hundreds of tab stops " +
      'and read "38%" into the middle of every sentence. The triage panel behind the ball ' +
      "is the accessible route to the same verdicts, and it is keyboard-operable.",
  },
  {
    what: "the underline / tint colours are not contrast-checked",
    where: "lib/render/marks.ts (CSS Custom Highlight API)",
    why:
      "They are decoration over the page's own text, never a foreground colour of their " +
      "own; WCAG 1.4.3 applies to the text, which keeps the page's colour.",
  },
  {
    what: "the host page's own violations are out of scope",
    where: "test/ui-fixtures.html and every real site",
    why: "axe is given our shadow host as its context so only our nodes are judged.",
  },
];

// =====================================================================================
// plumbing
// =====================================================================================
// A name made only of punctuation is not a name: "✕" is announced as "multiplication x"
// or skipped altogether. A usable name has to carry a letter or a digit.
const usableName = (n) => /[\p{L}\p{N}]/u.test(n ?? "");

const results = []; // { group, name, status, note }
const record = (group, name, ok, note = "") =>
  results.push({ group, name, status: ok === null ? "SKIP" : ok ? "PASS" : "FAIL", note });

/** Everything the JSON report carries, beyond the PASS/FAIL lines. */
const report = {
  tool: "axe-core",
  axeVersion: null,
  when: new Date().toISOString(),
  scans: [], // { where, scope, rules, checkedNodes, violations, bestPractice, incomplete }
  newViolations: [],
  knownViolations: [],
  // keyed by the check name recordFindings() is called with
  contrast: [],
  target: [],
  names: [],
  focus: [],
  motion: [],
  forcedColors: [],
  exemptions: EXEMPTIONS,
};

const AXE_SRC = readFileSync(join(__dirname, "..", "node_modules", "axe-core", "axe.min.js"), "utf8");
const AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"];
const isBestPractice = (tags) => tags.includes("best-practice") && !tags.some((t) => /^wcag\d/.test(t));

const baselineKeys = new Set(BASELINE.map((b) => `${b.where} :: ${b.rule}`));
const baselineHit = new Set();

const codeBaselineKeys = new Set(CODE_BASELINE.map((b) => `${b.check} :: ${b.where} :: ${b.item}`));
const codeBaselineHit = new Set();

/** An element's own selector — the part of a path that survives an edit above it. */
const tail = (path) => String(path).split(" > ").pop();

/**
 * One PASS/FAIL line for a code-level check, with the same baseline rule axe gets: known
 * findings are counted, anything else fails. `items` are `{ key, detail }`.
 */
function recordFindings(check, where, headline, total, items) {
  const fresh = [];
  const known = [];
  for (const it of items) {
    const k = `${check} :: ${where} :: ${it.key}`;
    if (codeBaselineKeys.has(k)) {
      codeBaselineHit.add(k);
      known.push(it);
    } else {
      fresh.push(it);
    }
  }
  (report[check] ??= []).push({ where, total, fresh, known });
  record(
    check,
    `${where}: ${headline}`,
    fresh.length === 0,
    `${total} checked · new: ${fresh.length} · known: ${known.length}` +
      (fresh.length ? ` · NEW: ${fresh.map((f) => f.detail).join("; ")}` : ""),
  );
  return { fresh, known };
}

/** Load axe into a page (CSP-proof, see the header) and confirm it arrived. */
async function injectAxe(page) {
  await page.evaluate(AXE_SRC);
  const v = await page.evaluate(() => (window.axe ? window.axe.version : null));
  if (!v) throw new Error("axe-core did not load");
  report.axeVersion = v;
  return v;
}

/**
 * Nothing half-painted may be scanned. A colour read mid-transition (or before the page
 * has picked up the emulated colour scheme) is the one thing that would make this suite
 * flaky, and a flaky accessibility suite is worse than none.
 */
async function settle(page, scheme = null) {
  if (scheme) {
    await page
      .waitForFunction((want) => document.documentElement.classList.contains("dark") === (want === "dark"), scheme, { timeout: 6000 })
      .catch(() => {});
  }
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
  await settleAll(page);
}

/**
 * Run axe over `scope` (a CSS selector for our shadow host, or null for the whole page)
 * and fold the result into the run: WCAG violations and best-practice ones are recorded
 * separately, and each violating node is matched against the baseline.
 */
async function axeScan(page, where, scope = null) {
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
            why: (n.any?.[0]?.message ?? n.all?.[0]?.message ?? n.failureSummary ?? "")
              .split("\n")[0]
              .slice(0, 220),
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

  if (raw.missing) {
    record("axe", `${where}`, null, `scope ${raw.missing} not present`);
    return { checkedTargets: [], fresh: [] };
  }

  const split = (v) => (isBestPractice(v.tags) ? "best-practice" : "wcag");
  const buckets = { wcag: { fresh: [], known: [] }, "best-practice": { fresh: [], known: [] } };
  for (const v of raw.violations) {
    const kind = split(v);
    const key = `${where} :: ${v.id}`;
    const entry = {
      where,
      rule: v.id,
      kind,
      impact: v.impact ?? "n/a",
      help: v.help,
      nodes: v.nodes.map((n) => n.target),
      why: v.nodes[0]?.why ?? "",
      html: v.nodes[0]?.html ?? "",
    };
    if (baselineKeys.has(key)) {
      baselineHit.add(key);
      buckets[kind].known.push(entry);
      report.knownViolations.push(entry);
    } else {
      buckets[kind].fresh.push(entry);
      report.newViolations.push(entry);
    }
  }
  const nodesOf = (list) => list.reduce((n, e) => n + e.nodes.length, 0);
  report.scans.push({
    where,
    scope,
    rules: raw.rules,
    checkedNodes: raw.checkedNodes,
    wcagViolations: buckets.wcag.fresh.length + buckets.wcag.known.length,
    bestPracticeViolations: buckets["best-practice"].fresh.length + buckets["best-practice"].known.length,
    incomplete: raw.incomplete.map((v) => ({ id: v.id, nodes: v.nodes.length })),
  });
  // Two lines, because "your page has no <main>" and "your text is unreadable" are not
  // the same news: WCAG 2.1 A/AA first, axe's best-practice rules after it.
  for (const kind of ["wcag", "best-practice"]) {
    const b = buckets[kind];
    const label = kind === "wcag" ? "WCAG 2.1 A/AA" : "best practice";
    record(
      "axe",
      `${where} — ${label}`,
      b.fresh.length === 0,
      `${raw.rules} rules / ${raw.checkedNodes} nodes · new: ${b.fresh.length} · ` +
        `known: ${b.known.length} rules / ${nodesOf(b.known)} nodes` +
        (b.fresh.length
          ? ` · NEW: ${b.fresh.map((f) => `${f.rule} (${f.nodes.length}) @ ${f.nodes[0]}`).join(" | ")}`
          : ""),
    );
  }
  return { ...raw, fresh: [...buckets.wcag.fresh, ...buckets["best-practice"].fresh] };
}

// =====================================================================================
// in-page probe — the helpers the code-level checks run inside the page
// =====================================================================================
// Installed with page.evaluate(fn); Playwright ships the function's source, so it is
// subject to no page CSP and needs no escaping. It must be self-contained.
function installProbe() {
  const P = {};

  /** Focus, descended through every open shadow root. */
  P.deepActive = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };

  /** A readable path across shadow boundaries, for the report. */
  P.path = (el) => {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1) {
      let s = node.tagName.toLowerCase();
      if (node.id) s += "#" + node.id;
      else if (node.classList.length) s += "." + [...node.classList].slice(0, 2).join(".");
      parts.unshift(s);
      const root = node.getRootNode();
      node = node.parentElement || (root instanceof ShadowRoot ? root.host : null);
    }
    return parts.join(" > ");
  };

  const text = (el) => (el.textContent || "").replace(/\s+/g, " ").trim();

  /**
   * Accessible name — the four sources that occur in this product, in spec order:
   * aria-labelledby, aria-label, a <label>/alt/value, then the element's own text, then
   * title. Enough to answer "does this control announce as anything at all".
   */
  P.name = (el) => {
    const root = el.getRootNode();
    const ids = el.getAttribute("aria-labelledby");
    if (ids) {
      const t = ids
        .split(/\s+/)
        .map((id) => {
          const r = root.getElementById ? root.getElementById(id) : document.getElementById(id);
          return r ? text(r) : "";
        })
        .join(" ")
        .trim();
      if (t) return t;
    }
    const label = el.getAttribute("aria-label");
    if (label && label.trim()) return label.trim();
    if (el.labels && el.labels.length) {
      const t = [...el.labels].map(text).join(" ").trim();
      if (t) return t;
    }
    if (el.tagName === "IMG") return (el.getAttribute("alt") || "").trim();
    if (el.tagName === "INPUT" && (el.type === "button" || el.type === "submit" || el.type === "reset"))
      return (el.value || "").trim();
    const own = text(el);
    if (own) return own;
    const title = el.getAttribute("title");
    if (title && title.trim()) return title.trim();
    return "";
  };

  const FOCUSABLE =
    'a[href],button,input,select,textarea,summary,[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

  /** Every interactive control in a root, shadow roots included, in DOM order. */
  P.controls = (root) => {
    const out = [];
    const walk = (r) => {
      for (const el of r.querySelectorAll("*")) {
        if (el.matches(FOCUSABLE)) out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    };
    walk(root);
    return out.filter((el) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") return false;
      if (el.hasAttribute("hidden") || el.disabled) return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  };

  /** The style facets a focus indicator can live in. */
  P.focusStyle = (el) => {
    const cs = getComputedStyle(el);
    return [
      cs.outlineStyle,
      cs.outlineWidth,
      cs.outlineColor,
      cs.outlineOffset,
      cs.boxShadow,
      cs.borderColor,
      cs.borderWidth,
      cs.backgroundColor,
      cs.color,
      cs.textDecorationLine,
    ].join("|");
  };

  P.rect = (el) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 };
  };

  /**
   * WCAG 2.5.8 measures the region that ACCEPTS THE POINTER, not the painted box: a
   * control drawn smaller than 24x24 still passes if an invisible hit area (a positioned
   * pseudo-element with a negative inset) brings it up. So the honest test is to ask the
   * document what is actually under the corners and the centre of a 24x24 box on the
   * control. elementFromPoint retargets to the shadow host from outside, so the question
   * is put to the element's own root.
   */
  P.hit24 = (el) => {
    let r = el.getBoundingClientRect();
    // A control the browser left flush against the fold has a 24x24 box that falls off
    // the viewport, and elementFromPoint answers null for that — "hits nothing", which is
    // the tool's problem, not the page's. Centre it first, then measure.
    const off = (rect) =>
      rect.top < 12 || rect.left < 12 || rect.bottom > window.innerHeight - 12 || rect.right > window.innerWidth - 12;
    if (off(r)) {
      // behavior:"instant" on purpose: the pages set scroll-behavior:smooth, and a rect
      // read in the middle of a smooth scroll is a rect of nowhere.
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      r = el.getBoundingClientRect();
    }
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // 11.99, not 11.5: the corners have to be the corners of a 24 px box. Sampling half a
    // pixel in would pass a control drawn 23.1 px tall, which is exactly the case this
    // check exists to catch.
    const E = 11.99;
    const pts = [
      [cx - E, cy - E],
      [cx + E, cy - E],
      [cx - E, cy + E],
      [cx + E, cy + E],
      [cx, cy],
    ];
    const root = el.getRootNode();
    const at = (x, y) => (root.elementFromPoint ? root.elementFromPoint(x, y) : document.elementFromPoint(x, y));
    const misses = [];
    for (const [x, y] of pts) {
      const hit = at(x, y);
      if (!hit || (hit !== el && !el.contains(hit))) {
        misses.push(hit ? hit.tagName.toLowerCase() + (hit.classList.length ? "." + hit.classList[0] : "") : "nothing");
      }
    }
    return { ok: misses.length === 0, misses: [...new Set(misses)] };
  };

  // ---- colour ---------------------------------------------------------------------
  const parse = (str) => {
    const m = String(str).match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[,/\s]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = (c) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  const hex = (c) =>
    "#" + [c.r, c.g, c.b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");

  /** The colour actually behind `el`, composited up through shadow hosts to the canvas. */
  P.backdrop = (el) => {
    const layers = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const c = parse(getComputedStyle(node).backgroundColor);
      if (c && c.a > 0) layers.push(c);
      const root = node.getRootNode();
      node = node.parentElement || (root instanceof ShadowRoot ? root.host : null);
    }
    let bg = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (!bg || bg.a === 0) bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) bg = over(layers[i], bg);
    return bg;
  };

  /** WCAG 1.4.3 for one text node: ratio, the threshold its type requires, and the pair. */
  P.contrast = (el) => {
    const cs = getComputedStyle(el);
    const fgRaw = parse(cs.color);
    if (!fgRaw) return null;
    const bg = P.backdrop(el);
    const fg = over(fgRaw, bg);
    const l1 = lum(fg);
    const l2 = lum(bg);
    const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    const px = parseFloat(cs.fontSize);
    const weight = Number(cs.fontWeight) || 400;
    const large = px >= 24 || (px >= 18.66 && weight >= 700);
    return {
      path: P.path(el),
      text: text(el).slice(0, 40),
      fg: hex(fg),
      bg: hex(bg),
      px: Math.round(px * 10) / 10,
      weight,
      large,
      need: large ? 3 : 4.5,
      ratio: Math.round(ratio * 100) / 100,
      ok: ratio + 0.005 >= (large ? 3 : 4.5),
    };
  };

  /** Leaf elements that paint text of their own, inside a root. */
  P.textNodes = (root) => {
    const out = [];
    const walk = (r) => {
      for (const el of r.querySelectorAll("*")) {
        if (el.shadowRoot) walk(el.shadowRoot);
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden") continue;
        const own = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== "");
        if (own) out.push(el);
      }
    };
    walk(root);
    return out;
  };

  /** Animations still running on our own nodes (shadow descendants included). */
  P.running = (host) =>
    host
      .getAnimations({ subtree: true })
      .filter((a) => a.playState === "running")
      .map((a) => ({
        name: a.animationName || (a.transitionProperty ?? "transition"),
        target: P.path(a.effect && a.effect.target ? a.effect.target : host),
        kind: a.constructor.name,
      }));

  window.__a11y = P;
  return true;
}

/**
 * Wait until NOTHING on the page is animating. This is not belt and braces: a chip that
 * has just learned it sits on a dark surface transitions `background-color` over 130 ms,
 * and a colour sampled inside that window reads the OLD white against the NEW text colour
 * — a phantom 2.5:1 failure that no user ever sees. Shadow trees are included:
 * Document.getAnimations() reaches into them.
 */
async function settleAll(page, timeout = 8000) {
  await page
    .waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout })
    .catch(() => {});
  await page.waitForTimeout(250);
}

/** Wait until nothing in our shadow UI is moving, so a scan reads settled colours. */
async function still(page, hostSel = "#anagram-fab") {
  await page
    .waitForFunction(
      (sel) => {
        const host = document.querySelector(sel);
        if (!host) return true;
        return host.getAnimations({ subtree: true }).every((a) => a.playState !== "running");
      },
      hostSel,
      { timeout: 6000 },
    )
    .catch(() => {});
  await page.waitForTimeout(150);
}

/** Bring the ball out of its idle tuck (half off the edge, 62% opacity) and settle. */
async function untuck(page) {
  await page.evaluate(() => {
    const stack = document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".stack");
    stack?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
  });
  await still(page);
}

// =====================================================================================
// fixtures
// =====================================================================================
const PARA = (tag) =>
  `${tag} paragraph is long enough to be scored on its own because it carries well over fifty ordinary ` +
  "English words describing nothing in particular except the fact that a reader who never touches a mouse " +
  "must still be able to reach every verdict this extension produces, which is what the floating ball, its " +
  "counter and the triage panel behind them exist for on a page like this one.";
// The fake daemon's verdicts are a pure function of the text, so the tags below are chosen
// (with test/fake-daemon.mjs's own fakeScore) to land three paragraphs in each FLAGGED
// band and two outside them: the panel then has rows, a Copy report button AND the verdict
// filter chips, which only appear when both flagged bands are present.
const AI_TAGS = ["FLAG-2", "FLAG-6", "FLAG-11"];
const HEAVY_TAGS = ["FLAG-3", "FLAG-4", "FLAG-7"];
const CALM_TAGS = ["FLAG-1", "FLAG-17"]; // lightly edited, human
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

requireBuild();
const server = await serveHtml({
  "/ui-fixtures.html": readFileSync(join(__dirname, "ui-fixtures.html"), "utf8"),
  "/keyboard.html": KEYS_HTML,
  "/selection.html": SEL_HTML,
  "/dark.html": DARK_HTML,
});
// The reader fetches BYTES; serveHtml answers everything as text/html, which a PDF is not.
const fileServer = http.createServer((req, res) => {
  if (req.url.split("?")[0] !== "/doc.pdf") return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": "application/pdf", "content-length": SMALL_PDF.length });
  res.end(SMALL_PDF);
});
await new Promise((r) => fileServer.listen(0, "127.0.0.1", r));
const pdfUrl = `http://localhost:${fileServer.address().port}/doc.pdf`;

let daemon = await startFakeDaemon();
const { context, sw } = await launchExtension({ backendUrl: daemon.url });
await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => {});
const extId = sw ? new URL(sw.url()).host : null;
console.log("extension SW:", sw ? "loaded" : "NOT loaded", "· fake daemon at", daemon.url);
if (!extId) {
  console.error("no extension id — the service worker never started");
  process.exit(2);
}
const extUrl = (p) => `chrome-extension://${extId}/${p}`;

/** A fresh page with axe and the probe already in it. */
async function openPage(url, { scheme = "light", viewport = null, media = {} } = {}) {
  const page = await context.newPage();
  if (viewport) await page.setViewportSize(viewport);
  await page.emulateMedia({ colorScheme: scheme, ...media });
  await page.goto(url, { waitUntil: "load" });
  await page.evaluate(installProbe);
  await injectAxe(page);
  return page;
}

/** Chips settled (none left in the "analyzing…" state) — the state a scan may read. */
async function chipsSettled(page, min = 1) {
  return page
    .waitForFunction(
      ({ sel, min }) => {
        const pills = [...document.querySelectorAll(sel)]
          .map((h) => h.shadowRoot?.querySelector(".pill"))
          .filter(Boolean);
        return pills.length >= min && !pills.some((p) => p.classList.contains("pending"));
      },
      { sel: BADGE_SEL, min },
      { timeout: 25000 },
    )
    .then(() => true)
    .catch(() => false);
}

// =====================================================================================
// PART 1 — the four extension pages, light and dark
// =====================================================================================
// Two site rules are written before the options page opens; the add-rule error is then
// provoked the way a user provokes it (submitting something that is not a hostname).
{
  const seed = await context.newPage();
  await seed.goto(extUrl("options.html"));
  await seed.evaluate(
    () =>
      new Promise((res) =>
        chrome.storage.local.set({ siteOverrides: { "example.com": "off", "news.example.org": "on" } }, res),
      ),
  );
  await seed.close();
}

const PAGE_SPECS = [
  {
    name: "popup",
    url: () => extUrl("popup.html"),
    viewport: { width: 300, height: 620 },
    async prepare(page) {
      await page.waitForTimeout(700);
    },
  },
  {
    name: "options (two site rules, add-rule error)",
    url: () => extUrl("options.html"),
    viewport: { width: 1100, height: 900 },
    async prepare(page) {
      await page.waitForSelector("#sites table", { timeout: 8000 }).catch(() => {});
      await page.fill("#addHost", "  ");
      await page.click("#addRule button[type=submit]");
      await page.waitForSelector("#addError:not([hidden])", { timeout: 4000 }).catch(() => {});
      await page.waitForTimeout(200);
    },
  },
  {
    name: "onboarding (daemon up)",
    url: () => extUrl("onboarding.html"),
    viewport: { width: 1100, height: 900 },
    async prepare(page) {
      // The setup strip is live: scanning it mid-probe would judge "checking…", not the
      // state the reader ends up looking at.
      await page
        .waitForFunction(() => document.getElementById("row-daemon")?.dataset.state !== "idle", null, { timeout: 15000 })
        .catch(() => {});
      await page.waitForFunction(() => (document.getElementById("backend-note")?.textContent ?? "") !== "", null, { timeout: 8000 }).catch(() => {});
    },
  },
  {
    name: "reader (empty, file picker)",
    url: () => extUrl("reader.html"),
    viewport: { width: 1100, height: 900 },
    async prepare(page) {
      await page.waitForSelector("#drop:not([hidden])", { timeout: 8000 }).catch(() => {});
    },
  },
  {
    name: "reader (PDF loaded)",
    url: () => `${extUrl("reader.html")}?src=${encodeURIComponent(pdfUrl)}`,
    viewport: { width: 1100, height: 900 },
    async prepare(page) {
      await page.waitForSelector("#paper > p", { timeout: 25000 }).catch(() => {});
      await chipsSettled(page, 1);
      await still(page);
    },
  },
];

for (const scheme of ["light", "dark"]) {
  for (const spec of PAGE_SPECS) {
    const page = await openPage(spec.url(), { scheme, viewport: spec.viewport });
    await spec.prepare(page);
    await settle(page, scheme);
    await axeScan(page, `${spec.name} [${scheme}]`);
    if (scheme === "light") await pageCodeChecks(page, spec.name);
    await page.close();
  }
}

// =====================================================================================
// PART 2 — our own UI, scoped to our nodes
// =====================================================================================
let fixturePage = null;
{
  const page = await openPage(server.url("/ui-fixtures.html"));
  fixturePage = page;
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

  // The ball at rest. Untuck first: a tucked ball sits half off the edge at 62% opacity,
  // and every colour read through it would be a blend of our surface and the page.
  await untuck(page);
  const closed = await axeScan(page, "ball (panel closed)", "#anagram-fab");

  // axe has to have gone THROUGH the shadow boundary: the counter button lives only
  // inside #anagram-fab's shadow root, so a checked node whose target names it is proof.
  const sawShadow = (closed.checkedTargets ?? []).some((t) => t.includes(">>>") && /\.count\b/.test(t));
  record(
    "axe",
    "axe descends into the ball's open shadow root (a known shadow node was checked)",
    sawShadow,
    `${(closed.checkedTargets ?? []).length} node targets, e.g. ${(closed.checkedTargets ?? [])[0] ?? "—"}`,
  );

  // Panel open, with flagged rows and — both bands being present here — the filter chips.
  const panelState = await page.evaluate(() => {
    const sr = document.getElementById("anagram-fab").shadowRoot;
    sr.querySelector(".count").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    const panel = sr.querySelector(".panel");
    return {
      open: panel.classList.contains("open"),
      items: panel.querySelectorAll(".pitem").length,
      filters: [...panel.querySelectorAll(".fchip")].map((c) => c.textContent),
    };
  });
  await still(page);
  await page.waitForFunction(
    () => getComputedStyle(document.getElementById("anagram-fab").shadowRoot.querySelector(".panel")).opacity === "1",
    null,
    { timeout: 4000 },
  ).catch(() => {});
  // Which bands this page happens to produce is the fixture's business, not a contract —
  // the deterministic both-bands state (and therefore the filter chips) is scanned on the
  // suite's own keyboard fixture below, where the verdicts are chosen.
  record(
    "axe",
    "triage panel opens with flagged rows (the state axe is run on)",
    panelState.open && panelState.items > 0,
    JSON.stringify(panelState),
  );
  await axeScan(page, "ball (panel open, flagged rows)", "#anagram-fab");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);

  // A chip's detail card, pinned open (a tap pins what a hover shows).
  const cardHost = await page.evaluate(async (sel) => {
    const host = [...document.querySelectorAll(sel)].find((h) =>
      h.shadowRoot?.querySelector(".pill.band-ai, .pill.band-heavy"),
    );
    if (!host) return null;
    host.id = host.id || "a11y-card-host";
    host.scrollIntoView({ block: "center" });
    host.dispatchEvent(new MouseEvent("mouseenter"));
    host.click();
    await new Promise((r) => setTimeout(r, 500));
    return host.shadowRoot.querySelector(".card")?.classList.contains("open") ? "#" + host.id : null;
  }, BADGE_SEL);
  if (cardHost) {
    await still(page, cardHost);
    await axeScan(page, "chip detail card (pinned open)", cardHost);
  } else {
    record("axe", "chip detail card (pinned open)", null, "no flagged chip to pin");
  }
}

// The selection card, triggered exactly as the context menu triggers it.
{
  const page = await openPage(server.url("/selection.html"));
  await page.bringToFront();
  await page.evaluate(() => {
    const ta = document.getElementById("draft");
    ta.focus();
    ta.setSelectionRange(0, ta.value.length);
  });
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    try {
      await chrome.tabs.sendMessage(tab.id, { action: "analyzeSelection" });
    } catch {
      /* the content script answers nothing to this one */
    }
  });
  const shown = await page
    .waitForFunction(
      (sel) =>
        [...document.querySelectorAll(sel)].some(
          (h) => h.shadowRoot?.querySelector(".card .close") && h.shadowRoot.querySelector(".dist"),
        ),
      BADGE_SEL,
      { timeout: 15000 },
    )
    .then(() => true)
    .catch(() => false);
  if (shown) {
    await page.evaluate((sel) => {
      const h = [...document.querySelectorAll(sel)].find((x) => x.shadowRoot?.querySelector(".card .close"));
      h.id = "a11y-sel-card";
    }, BADGE_SEL);
    await still(page, "#a11y-sel-card");
    await axeScan(page, "selection card", "#a11y-sel-card");
    await selectionCardCodeChecks(page);
  } else {
    record("axe", "selection card", null, "the card never rendered");
  }
  await page.close();
}

// =====================================================================================
// PART 3 — the checks axe cannot make
// =====================================================================================
const keyboard = await openPage(server.url("/keyboard.html"));
await chipsSettled(keyboard, 4);
await settleAll(keyboard);
await keyboardWalkthrough(keyboard);
await panelCodeChecks(keyboard);
await keyboard.close();

// Chip colours on a light page and on a dark one (the chip has a dark variant of its own,
// chosen per anchor — nothing else in this suite would ever measure it).
for (const [label, url] of [
  ["light page", server.url("/ui-fixtures.html")],
  ["dark page", server.url("/dark.html")],
]) {
  const page = label === "light page" && fixturePage ? fixturePage : await openPage(url);
  if (page !== fixturePage) await chipsSettled(page, 3);
  await chipContrast(page, label);
  if (page !== fixturePage) await page.close();
}
if (fixturePage) await fixturePage.close();

// prefers-reduced-motion and forced colours: both are page-level emulations, so each gets
// its own page rather than being toggled under a rendered one.
await reducedMotionCheck();
await forcedColorsCheck();

// =====================================================================================
// PART 4 — daemon down (onboarding's other state, and the panel's notice)
// =====================================================================================
await daemon.close();
daemon = null;
for (const scheme of ["light", "dark"]) {
  const page = await openPage(extUrl("onboarding.html"), { scheme, viewport: { width: 1100, height: 900 } });
  await page
    .waitForFunction(() => /not running|Unavailable|update it/.test(document.getElementById("backend-note")?.textContent ?? ""), null, { timeout: 15000 })
    .catch(() => {});
  await page
    .waitForFunction(() => document.getElementById("row-daemon")?.dataset.state === "bad", null, { timeout: 15000 })
    .catch(() => {});
  await settle(page, scheme);
  await axeScan(page, `onboarding (daemon down) [${scheme}]`);
  // The setup strip's Copy pills, its "Open options" link and the install command exist
  // ONLY while the daemon is down, so this is the only pass that can see them.
  if (scheme === "light") await pageCodeChecks(page, "onboarding (daemon down)");
  await page.close();
}
{
  const page = await openPage(server.url("/keyboard.html"));
  const down = await page
    .waitForFunction(() => document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent === "!", null, { timeout: 25000 })
    .then(() => true)
    .catch(() => false);
  if (down) {
    await untuck(page);
    await page.evaluate(() => {
      const sr = document.getElementById("anagram-fab").shadowRoot;
      sr.querySelector(".count").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await still(page);
    const notice = await page.evaluate(
      () => document.getElementById("anagram-fab").shadowRoot.querySelector(".panel .pnotice")?.textContent ?? null,
    );
    record("axe", "daemon-down notice renders in the panel (the state axe is run on)", !!notice, (notice ?? "").slice(0, 60));
    await axeScan(page, "ball (panel open, daemon-down notice)", "#anagram-fab");
    await ourTextContrast(page, "panel (daemon down)", "#anagram-fab");
  } else {
    record("axe", "ball (panel open, daemon-down notice)", null, "the counter never went to !");
  }
  await page.close();
}

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
function judgeStops(where, stops) {
  recordFindings(
    "names",
    where,
    "every keyboard-reachable control has an accessible name",
    stops.length,
    stops.filter((s) => !usableName(s.name)).map((s) => ({ key: tail(s.path), detail: `${tail(s.path)} name=${JSON.stringify(s.name)}`, path: s.path })),
  );
  recordFindings(
    "focus",
    where,
    "every control shows a visible focus indicator",
    stops.length,
    stops.filter((s) => !s.ring).map((s) => ({ key: tail(s.path), detail: `${tail(s.path)} (no computed change on :focus-visible)`, path: s.path })),
  );
  // Painted smaller than 24x24 is not a failure on its own — an invisible hit area counts.
  const drawnSmall = stops.filter((s) => s.rect.w < 24 || s.rect.h < 24);
  recordFindings(
    "target",
    where,
    "every control accepts a pointer over at least 24x24 CSS px (WCAG 2.2 target size, minimum)",
    stops.length,
    drawnSmall
      .filter((s) => !s.hit.ok)
      .map((s) => ({
        key: tail(s.path),
        detail: `${tail(s.path)} drawn ${s.rect.w}x${s.rect.h}, 24x24 box hits ${s.hit.misses.join("/")}`,
        path: s.path,
        ...s.rect,
      })),
  );
  const rescued = drawnSmall.filter((s) => s.hit.ok);
  if (rescued.length) {
    record(
      "target",
      `${where}: controls drawn under 24x24 that reach it through a hit area`,
      true,
      rescued.map((s) => `${tail(s.path)} ${s.rect.w}x${s.rect.h}`).join(", "),
    );
  }
}

/** Name / focus ring / hit target for every keyboard-reachable control on a page. */
async function pageCodeChecks(page, where) {
  judgeStops(where, await tabWalk(page, { max: 80 }));
}

/** The keyboard route the chips deliberately do not provide: ball → counter → panel. */
async function keyboardWalkthrough(page) {
  await untuck(page);
  // 1. Tab reaches the ball, and then the counter — in that order.
  const order = await tabWalk(page, { max: 12 });
  const ball = order.findIndex((s) => /\.chip\.fab|\.fab\b/.test(s.path));
  const count = order.findIndex((s) => /\.count\b/.test(s.path));
  record(
    "keyboard",
    "Tab reaches the ball and then the flagged counter",
    ball >= 0 && count >= 0 && ball < count,
    JSON.stringify({ order: order.map((s) => s.path.split(" > ").pop()), ball, count }),
  );

  // 2. Enter on the counter opens the panel and hands the keyboard over.
  await page.evaluate(() => {
    const sr = document.getElementById("anagram-fab").shadowRoot;
    sr.querySelector(".count").focus();
  });
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
  record(
    "keyboard",
    "Enter opens the panel as a named dialog and focus lands inside it",
    opened.open && opened.role === "dialog" && opened.named && opened.inside && opened.expanded === "true",
    JSON.stringify(opened),
  );

  // 3. Tab order inside the panel: DOM order, everything reachable, nothing with a
  //    positive tabindex, and the last stop is the panel's own last control.
  const inner = await page.evaluate(() => {
    const sr = document.getElementById("anagram-fab").shadowRoot;
    const panel = sr.querySelector(".panel");
    return {
      dom: window.__a11y.controls(panel).map((el) => window.__a11y.path(el).split(" > ").pop()),
      positive: window.__a11y
        .controls(panel)
        .filter((el) => Number(el.getAttribute("tabindex") ?? 0) > 0)
        .map((el) => window.__a11y.path(el)),
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
  record(
    "keyboard",
    "Tab walks the panel's controls in DOM order, with no positive tabindex",
    visited.length > 1 && inner.positive.length === 0 && JSON.stringify(visited) === JSON.stringify(expected),
    JSON.stringify({ visited, expected, positive: inner.positive }),
  );
  // Arrow keys are NOT a second navigation model here (the rows are plain buttons in a
  // dialog, not a listbox) — recorded so a change of mind is visible, not as a failure.
  await page.evaluate(() => document.getElementById("anagram-fab").shadowRoot.querySelector(".panel .pitem")?.focus());
  const beforeArrow = await page.evaluate(() => window.__a11y.path(document.getElementById("anagram-fab").shadowRoot.activeElement));
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(80);
  const afterArrow = await page.evaluate(() => window.__a11y.path(document.getElementById("anagram-fab").shadowRoot.activeElement));
  record("keyboard", "arrow keys do not move focus in the panel (Tab is the only model — by design)", beforeArrow === afterArrow, `${beforeArrow.split(" > ").pop()} → ${afterArrow.split(" > ").pop()}`);

  // 4. Escape closes it and gives the keyboard back to the counter.
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  const closed = await page.evaluate(() => {
    const sr = document.getElementById("anagram-fab").shadowRoot;
    return {
      open: !!sr.querySelector(".panel.open"),
      back: sr.activeElement === sr.querySelector(".count"),
      expanded: sr.querySelector(".count").getAttribute("aria-expanded"),
    };
  });
  record(
    "keyboard",
    "Escape closes the panel and returns focus to the counter",
    !closed.open && closed.back && closed.expanded === "false",
    JSON.stringify(closed),
  );
}

/** Names, rings, hit targets and contrast for the panel's own controls. */
async function panelCodeChecks(page) {
  await page.evaluate(() => {
    const sr = document.getElementById("anagram-fab").shadowRoot;
    sr.querySelector(".count").dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
  await still(page);
  const state = await page.evaluate(() => {
    const panel = document.getElementById("anagram-fab").shadowRoot.querySelector(".panel");
    return {
      open: panel.classList.contains("open"),
      items: panel.querySelectorAll(".pitem").length,
      filters: [...panel.querySelectorAll(".fchip")].map((c) => c.textContent),
      copy: !!panel.querySelector(".pcopy"),
    };
  });
  record(
    "axe",
    "the keyboard fixture puts both flagged bands in the panel, so the verdict filters are there to scan",
    state.open && state.items === 6 && state.filters.length === 3 && state.copy,
    JSON.stringify(state),
  );
  await axeScan(page, "ball (panel open, verdict filters)", "#anagram-fab");
  const stops = await tabWalk(page, { max: 40 });
  const ours = stops.filter((s) => s.path.includes("#anagram-fab"));
  record("keyboard", "ball + panel: the walk reached our controls at all", ours.length > 2, `${ours.length} stops`);
  judgeStops("ball + panel", ours);

  // The counter and the panel's percentages, computed from the resolved colours: axe
  // reads these through a top-layer popover inside a shadow root and can get them wrong.
  await ourTextContrast(page, "panel (flagged)", "#anagram-fab");
  const counter = await page.evaluate(() => {
    const sr = document.getElementById("anagram-fab").shadowRoot;
    return window.__a11y.contrast(sr.querySelector(".count"));
  });
  report.contrast.push({ where: "counter (flagged)", ...counter });
  recordFindings(
    "contrast",
    "counter (flagged)",
    `the flagged counter's number reads on its own surface (${counter.fg} on ${counter.bg} = ${counter.ratio}:1)`,
    1,
    counter.ok ? [] : [{ key: "button.count", detail: `button.count ${counter.fg}/${counter.bg} ${counter.ratio}:1 (needs ${counter.need})` }],
  );
  const ppct = await page.evaluate(() => {
    const sr = document.getElementById("anagram-fab").shadowRoot;
    return [...sr.querySelectorAll(".panel .ppct")].map((el) => window.__a11y.contrast(el));
  });
  for (const c of ppct) report.contrast.push({ where: "panel .ppct", ...c });
  recordFindings(
    "contrast",
    "panel .ppct",
    `every verdict percentage reads on the panel surface (worst ${ppct.length ? Math.min(...ppct.map((c) => c.ratio)) : "—"}:1)`,
    ppct.length,
    ppct.filter((c) => !c.ok).map((c) => ({ key: tail(c.path), detail: `${tail(c.path)} ${c.fg}/${c.bg} ${c.ratio}:1` })),
  );
  await page.keyboard.press("Escape");
}

/** Every text node in one of our shadow roots, measured against what is really behind it. */
async function ourTextContrast(page, where, hostSel) {
  const all = await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    if (!host) return [];
    return window.__a11y
      .textNodes(host.shadowRoot ?? host)
      .map((el) => window.__a11y.contrast(el))
      .filter(Boolean);
  }, hostSel);
  const bad = all.filter((c) => !c.ok);
  for (const c of bad) report.contrast.push({ where, ...c });
  recordFindings(
    "contrast",
    where,
    "every text node reaches its WCAG 1.4.3 ratio",
    all.length,
    bad.map((c) => ({ key: tail(c.path), detail: `${tail(c.path)} ${c.fg}/${c.bg} ${c.ratio}:1 (needs ${c.need})` })),
  );
}

/** The chip's own number and its card's verdict label, per band, on this page's surface. */
async function chipContrast(page, label) {
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
  for (const c of flat) report.contrast.push({ where: label, ...c });
  const bad = flat.filter((c) => !c.ok);
  const bands = [...new Set(measured.map((m) => m.band))].sort();
  recordFindings(
    "contrast",
    label,
    `chip number + card verdict, every band (${bands.join(", ")}), worst ${flat.length ? Math.min(...flat.map((c) => c.ratio)) : "—"}:1`,
    flat.length,
    bad.map((c) => ({ key: c.what, detail: `${c.what} ${c.fg}/${c.bg} ${c.ratio}:1` })),
  );
  record("contrast", `${label}: every chip and card was measured`, flat.length > 0, `${flat.length} readings`);
  // The dark fixture exists to exercise the chip's dark variant — if none rendered,
  // everything above measured the light colours twice and proved half of what it says.
  const dark = measured.filter((m) => m.dark).length;
  if (label === "dark page") {
    record("contrast", `${label}: the chip's dark variant is what was measured`, dark > 0, `${dark} of ${measured.length} chips are pg-dark`);
  }
}

/** The selection card's own controls and colours. */
async function selectionCardCodeChecks(page) {
  const info = await page.evaluate(() => {
    const host = document.getElementById("a11y-sel-card");
    const close = host.shadowRoot.querySelector(".close");
    return {
      name: window.__a11y.name(close),
      rect: window.__a11y.rect(close),
      hit: window.__a11y.hit24(close),
      path: window.__a11y.path(close),
    };
  });
  recordFindings(
    "names",
    "selection card",
    "the close button has a name a screen reader can read out",
    1,
    usableName(info.name)
      ? []
      : [{ key: tail(info.path), detail: `${tail(info.path)} name=${JSON.stringify(info.name)} — a symbol, not a word (title="Close" loses to the button's own text)` }],
  );
  recordFindings(
    "target",
    "selection card",
    "the close button accepts a pointer over at least 24x24 CSS px",
    1,
    info.hit.ok ? [] : [{ key: tail(info.path), detail: `${tail(info.path)} drawn ${info.rect.w}x${info.rect.h}, 24x24 box hits ${info.hit.misses.join("/")}` }],
  );
  await ourTextContrast(page, "selection card", "#a11y-sel-card");
}

/** Nothing of ours may still be moving when the reader asked for less motion. */
async function reducedMotionCheck() {
  const page = await openPage(server.url("/keyboard.html"), { media: { reducedMotion: "reduce" } });
  await chipsSettled(page, 4);
  await untuck(page);
  const moving = await page.evaluate(
    (sel) => {
      const out = [];
      for (const host of [document.getElementById("anagram-fab"), ...document.querySelectorAll(sel)]) {
        if (host) out.push(...window.__a11y.running(host));
      }
      return out;
    },
    BADGE_SEL,
  );
  // The jump-target pulse is the one animation a keyboard user triggers on purpose.
  await page.evaluate((sel) => {
    const host = document.querySelector(sel);
    const pill = host?.shadowRoot?.querySelector(".pill");
    pill?.classList.add("pg-flash");
  }, BADGE_SEL);
  await page.waitForTimeout(120);
  const flashing = await page.evaluate((sel) => window.__a11y.running(document.querySelector(sel)), BADGE_SEL);
  report.motion.push({ idle: moving, flash: flashing });
  record(
    "motion",
    "prefers-reduced-motion: nothing of ours is animating",
    moving.length === 0,
    moving.length ? moving.map((m) => `${m.target.split(" > ").pop()}:${m.name}`).join(", ") : "no running animations",
  );
  record(
    "motion",
    "prefers-reduced-motion: the jump-target pulse becomes a static outline",
    flashing.length === 0,
    flashing.length ? flashing.map((m) => m.name).join(", ") : "no animation on flash",
  );
  await page.close();
}

/** Under forced colours a chip must still read as a chip: a boundary the system draws. */
async function forcedColorsCheck() {
  const page = await openPage(server.url("/keyboard.html"), { media: { forcedColors: "active" } });
  await chipsSettled(page, 4);
  await settleAll(page);
  const pills = await page.evaluate((sel) => {
    const out = [];
    for (const host of document.querySelectorAll(sel)) {
      const pill = host.shadowRoot?.querySelector(".pill");
      if (!pill) continue;
      const cs = getComputedStyle(pill);
      const dot = host.shadowRoot.querySelector(".dot");
      out.push({
        borderStyle: cs.borderTopStyle,
        borderWidth: cs.borderTopWidth,
        borderColor: cs.borderTopColor,
        background: cs.backgroundColor,
        dotAdjust: dot ? getComputedStyle(dot).forcedColorAdjust : null,
      });
    }
    return out;
  }, BADGE_SEL);
  const bad = pills.filter(
    (p) => p.borderStyle === "none" || parseFloat(p.borderWidth) < 1 || p.borderColor === p.background,
  );
  report.forcedColors.push({ pills: pills.length, bad });
  record(
    "forced-colors",
    "chips keep a visible boundary under forced colours",
    pills.length > 0 && bad.length === 0,
    `${pills.length} chips · border ${pills[0]?.borderWidth} ${pills[0]?.borderStyle} ${pills[0]?.borderColor} on ${pills[0]?.background}`,
  );
  record(
    "forced-colors",
    "the verdict dot keeps its own colour (forced-color-adjust: none)",
    pills.length > 0 && pills.every((p) => p.dotAdjust === "none"),
    `forced-color-adjust=${pills[0]?.dotAdjust}`,
  );
  await page.close();
}

// =====================================================================================
// summary
// =====================================================================================
await context.close();
await server.close();
await new Promise((r) => fileServer.close(() => r()));
if (daemon) await daemon.close();

// A baseline entry that no longer fires is debt that was paid — say so, loudly, so the
// list shrinks instead of fossilising.
const stale = BASELINE.filter((b) => !baselineHit.has(`${b.where} :: ${b.rule}`));
if (BASELINE.length > 0) {
  record(
    "baseline",
    "every baselined axe violation still fires (a fixed one must be deleted from the list)",
    stale.length === 0,
    stale.length ? `no longer firing: ${stale.map((b) => `${b.where} :: ${b.rule}`).join(" | ")}` : `${BASELINE.length} known`,
  );
}
// The code-level baseline is NOT failed for going quiet. A hit target measured at 23.1 px
// here is 24.4 px on a Windows runner with different font metrics, and a suite that turns
// red on another platform for that is a suite people switch off. It is printed instead, so
// an entry that has really been fixed still gets deleted.
const staleCode = CODE_BASELINE.filter((b) => !codeBaselineHit.has(`${b.check} :: ${b.where} :: ${b.item}`));
if (CODE_BASELINE.length > 0) {
  record(
    "baseline",
    "known code-level findings, and which of them no longer fire (delete those)",
    true,
    staleCode.length
      ? `${CODE_BASELINE.length} known · quiet here: ${staleCode.map((b) => `${b.check}/${b.where}/${b.item}`).join(" | ")}`
      : `${CODE_BASELINE.length} known, all still firing`,
  );
}
report.codeBaseline = CODE_BASELINE;

report.baseline = BASELINE;
report.known = BASELINE.length;
report.results = results;
writeFileSync(artifact("a11y.json"), JSON.stringify(report, null, 2));

console.log("\n=== ACCESSIBILITY RESULTS ===");
for (const r of results) {
  console.log(`${r.status.padEnd(4)}  [${r.group}]  ${r.name}${r.note ? `  —  ${r.note}` : ""}`);
}
const fails = results.filter((r) => r.status === "FAIL");
const skips = results.filter((r) => r.status === "SKIP");
const nodes = report.scans.reduce((n, s) => n + s.checkedNodes, 0);
console.log(
  `\naxe-core ${report.axeVersion} · ${report.scans.length} scans · ${nodes} nodes checked · ` +
    `${report.newViolations.length} new violations · known: ${BASELINE.length} axe rules + ` +
    `${CODE_BASELINE.length} code-level findings`,
);
console.log(`report: ${artifact("a11y.json")}`);
console.log(`\n${results.length - fails.length - skips.length} pass / ${fails.length} fail / ${skips.length} skip`);
if (PRINT_JSON) console.log(JSON.stringify(report, null, 2));
console.log(fails.length === 0 ? "✅ A11Y GREEN" : "❌ A11Y FAILURES");
process.exit(fails.length === 0 ? 0 : 1);
