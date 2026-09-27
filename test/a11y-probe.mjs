// test/a11y-probe.mjs — what the accessibility suite (test/pw/a11y.spec.mjs) runs inside the
// page, and the waits that make its readings honest.
//
// WHY IT WAITS. Colours are only read once nothing is moving. A chip that has just learned
// it sits on a dark surface transitions `background-color` over 130 ms, and a reading taken
// inside that window pairs the OLD white surface with the NEW text colour — a 2.5:1 failure
// no user ever sees. settleAll() waits for document.getAnimations() to go quiet (it reaches
// into shadow trees), settle() also waits for the emulated colour scheme to land, and the
// ball is taken out of its idle tuck before anything is measured through its 62% opacity.
import { BADGE_SEL } from "./harness.mjs";

// The in-page probe — the helpers the code-level checks run inside the page.
// Installed with page.evaluate(fn); Playwright ships the function's source, so it is
// subject to no page CSP and needs no escaping. It must be self-contained.
export function installProbe() {
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
 * Nothing half-painted may be scanned. A colour read mid-transition (or before the page
 * has picked up the emulated colour scheme) is the one thing that would make this suite
 * flaky, and a flaky accessibility suite is worse than none.
 */
export async function settle(page, scheme = null) {
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
 * Wait until NOTHING on the page is animating. This is not belt and braces: a chip that
 * has just learned it sits on a dark surface transitions `background-color` over 130 ms,
 * and a colour sampled inside that window reads the OLD white against the NEW text colour
 * — a phantom 2.5:1 failure that no user ever sees. Shadow trees are included:
 * Document.getAnimations() reaches into them.
 */
export async function settleAll(page, timeout = 8000) {
  // Two frames first: a transition started by a class change this tick does not exist in
  // getAnimations() until the style is recalculated, and polling before that would answer
  // "nothing is moving" about a fade that is one frame from starting.
  await frames(page);
  await page
    .waitForFunction(() => document.getAnimations().every((a) => a.playState !== "running"), null, { timeout })
    .catch(() => {});
  await page.waitForTimeout(250);
}

/** Let the page recalculate style and paint twice. */
export function frames(page) {
  return page
    .evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))))
    .catch(() => {});
}

/** Wait until nothing in our shadow UI is moving, so a scan reads settled colours. */
export async function still(page, hostSel = "#anagram-fab") {
  await frames(page);
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

/** The ball has to be there before anything can be asked about it. */
export const fabReady = (page) =>
  page
    .waitForFunction(() => !!document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count"), null, { timeout: 15000 })
    .then(() => true, () => false);

/**
 * Bring the ball out of its idle tuck (half off the edge, 62% opacity) and wait for the
 * fade to finish. The opacity is checked explicitly, not just the animation list: a colour
 * read at 0.97 opacity gives axe #fef8f8 on #dd2d2d and a 4.45:1 "failure" of a pair that
 * is 4.83:1 the moment the fade lands.
 */
export async function untuck(page) {
  await page.evaluate(() => {
    const stack = document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".stack");
    stack?.dispatchEvent(new PointerEvent("pointerenter", { bubbles: false }));
  });
  await still(page);
  await page
    .waitForFunction(
      () => {
        const wrap = document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".fabwrap");
        return !wrap || getComputedStyle(wrap).opacity === "1";
      },
      null,
      { timeout: 4000 },
    )
    .catch(() => {});
}

/** Chips settled (none left in the "analyzing…" state) — the state a scan may read. */
export async function chipsSettled(page, min = 1) {
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
