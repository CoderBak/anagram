// lib/render/badge.ts — Shadow-DOM per-unit badge layer.
//
// v2 renders each badge as an INLINE-FLOW chip inserted right after the unit's
// last text run (climbing out of inline ancestors so it never lands inside a
// link). Because it participates in layout it reflows with the text — no absolute
// positioning, no `position:relative` injection into page elements, no marker
// attributes on page DOM, no clipping by overflow ancestors, correct in RTL and
// with floats. The chip shows a colored dot + the AI-involvement number; a hover
// card carries the full calibrated readout.
import type { Unit } from "../types";
import { MARK_ATTR } from "../types";
import type { ScoreResult } from "../contract";
import { band, BAND_LABEL, type Band } from "./band";
import { BADGE_CSS } from "./badge.css";
import { isDarkContext } from "./theme";

export interface BadgeLayer {
  render(unit: Unit, result: ScoreResult): void;
  remove(id: string): void;
  /** Show/hide all badges without removing them (instant toggle, keeps results). */
  setVisible(visible: boolean): void;
  /** Forget cached background verdicts (site theme toggled; used by Rescan). */
  resetTheme(): void;
  teardownAll(): void;
}

// Build the constructable stylesheet once; every shadow root adopts the same instance.
let _sheet: CSSStyleSheet | null = null;
function badgeSheet(): CSSStyleSheet {
  if (!_sheet) {
    _sheet = new CSSStyleSheet();
    _sheet.replaceSync(BADGE_CSS);
  }
  return _sheet;
}

export function createBadgeLayer(): BadgeLayer {
  installOutsideCloser();
  const hosts = new Map<string, HTMLElement>();
  // Dark-context verdict per container (invalidated via resetTheme on Rescan).
  let darkCache = new WeakMap<Element, boolean>();
  let visible = true;

  function render(unit: Unit, result: ScoreResult): void {
    const b: Band = band(result);
    let host = hosts.get(unit.id);

    if (!host || !host.isConnected) {
      host?.remove();
      host = buildHost();
      const anchor = insertionPoint(unit);
      if (!anchor) return; // unit detached mid-flight — purge will collect it
      anchor.after(host);
      hosts.set(unit.id, host);
    }

    host.classList.toggle("pg-hidden", !visible);
    host.classList.toggle("pg-dark", darkFor(unit.container, darkCache));

    const root = host.shadowRoot!;
    const pill = root.querySelector(".pill") as HTMLElement;
    const num = root.querySelector(".num") as HTMLElement;
    const pct = Math.round(result.e_theta * 100);

    pill.className = `pill band-${b}`;
    // Number + its unit tag, readable without hovering ("38% AI"); the calibrated
    // detail stays in the card.
    num.textContent = b === "unknown" ? "?" : `${pct}% AI`;

    renderCard(root.querySelector(".card") as HTMLElement, unit, result, b, pct);
  }

  function buildHost(): HTMLElement {
    const host = document.createElement("span");
    host.setAttribute(MARK_ATTR, "host");
    host.setAttribute("aria-hidden", "true");
    // Inline styles back up the !important :host rules against page CSS.
    host.style.cssText = "display:inline-block;position:relative;margin-inline-start:6px;";
    // A badge can legitimately sit inside an <a>; a click on it must never
    // navigate or trigger page handlers. A click/tap also PINS the card open
    // (the hover story for touch devices); a second tap unpins.
    host.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = host.shadowRoot?.querySelector(".card");
      if (!card) return;
      const opening = !card.classList.contains("open");
      closeOpenCard();
      if (opening) {
        positionCard(host);
        card.classList.add("open");
        _openCardHost = host;
      }
    });
    // Edge-aware hover card: flip below near the viewport top, pin horizontally
    // near the left/right edges. Decided at hover time — layout may have changed.
    host.addEventListener("mouseenter", () => positionCard(host));
    const shadow = host.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = [badgeSheet()];

    const pill = document.createElement("span");
    pill.className = "pill";
    const dot = document.createElement("span");
    dot.className = "dot";
    const num = document.createElement("span");
    num.className = "num";
    pill.append(dot, num);

    const card = document.createElement("div");
    card.className = "card";

    shadow.append(pill, card);
    return host;
  }

  function renderCard(
    card: HTMLElement,
    unit: Unit,
    result: ScoreResult,
    b: Band,
    pct: number,
  ): void {
    const [lo, hi] = result.theta_interval;
    const row = (k: string, v: string) =>
      `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    const partsNote =
      unit.parts.length > 1 ? ` · ${unit.parts.length} paragraphs analyzed together` : "";
    card.innerHTML =
      `<div class="head"><span class="verdict band-${b}">${BAND_LABEL[b]}</span>` +
      `<span class="big">${b === "unknown" ? "—" : pct + "%"}</span></div>` +
      row("AI involvement (est.)", `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`) +
      row("p-value vs human", result.p_value.toFixed(3)) +
      row("Words analyzed", `${unit.wordCount}`) +
      `<div class="foot">Calibrated estimate, not proof${partsNote}.</div>`;
  }

  function remove(id: string): void {
    const host = hosts.get(id);
    if (!host) return;
    host.remove();
    hosts.delete(id);
  }

  function setVisible(v: boolean): void {
    visible = v;
    for (const [, host] of hosts) host.classList.toggle("pg-hidden", !v);
  }

  function resetTheme(): void {
    darkCache = new WeakMap();
  }

  function teardownAll(): void {
    for (const [, host] of hosts) host.remove();
    hosts.clear();
  }

  return { render, remove, setVisible, resetTheme, teardownAll };
}

// One pinned card at a time; tapping anywhere else closes it.
let _openCardHost: HTMLElement | null = null;
let _outsideCloserInstalled = false;

function closeOpenCard(): void {
  _openCardHost?.shadowRoot?.querySelector(".card")?.classList.remove("open");
  _openCardHost = null;
}

function installOutsideCloser(): void {
  if (_outsideCloserInstalled) return;
  _outsideCloserInstalled = true;
  document.addEventListener(
    "pointerdown",
    (e) => {
      // composedPath: for badges inside a page shadow root, e.target retargets to
      // the outer host and a raw comparison would close (then instantly re-open)
      // the card on every tap of the badge itself.
      if (_openCardHost && !e.composedPath().includes(_openCardHost)) closeOpenCard();
    },
    true,
  );
}

/** Edge-aware placement: flip below near the viewport top, pin near the sides. */
function positionCard(host: HTMLElement): void {
  const card = host.shadowRoot?.querySelector(".card");
  if (!card) return;
  card.classList.remove("below", "align-left", "align-right");
  const r = host.getBoundingClientRect();
  if (r.top < 190) card.classList.add("below");
  const vw = window.innerWidth || document.documentElement.clientWidth;
  if (r.left < 150) card.classList.add("align-left");
  else if (vw - r.right < 150) card.classList.add("align-right");
}

/**
 * Where the badge goes: after the unit's last text node, climbed out of inline
 * ancestors so the chip sits in the block's flow (never inside an <a>/<em>).
 * Climbing only continues while the node is the LAST meaningful child of its
 * inline parent — an inline wrapper can span many BR-separated paragraphs
 * (1990s-style <font> essays), and climbing past mid-wrapper content would pile
 * every badge at the wrapper's end.
 */
function insertionPoint(unit: Unit): ChildNode | null {
  const lastPart = unit.parts[unit.parts.length - 1];
  const nodes = lastPart.nodes;
  const lastNode = nodes[nodes.length - 1];
  if (!lastNode || !lastNode.isConnected) return null;
  let n: Node = lastNode;
  for (let i = 0; i < 12; i++) {
    const p = n.parentElement;
    if (!p || p === lastPart.container) break;
    if (!isInlineFlowElement(p)) break;
    if (!isLastMeaningfulChild(n, p)) break;
    n = p;
  }
  return n as ChildNode;
}

/** True if nothing but whitespace / our own hosts follows `n` inside `parent`. */
function isLastMeaningfulChild(n: Node, _parent: Element): boolean {
  let sib = n.nextSibling;
  while (sib) {
    if (sib.nodeType === Node.TEXT_NODE) {
      if ((sib.textContent ?? "").trim()) return false;
    } else if (sib.nodeType === Node.ELEMENT_NODE) {
      if (!(sib as Element).hasAttribute(MARK_ATTR)) return false;
    }
    sib = sib.nextSibling;
  }
  return true;
}

function isInlineFlowElement(el: Element): boolean {
  try {
    const d = getComputedStyle(el).display;
    return d.startsWith("inline") || d === "ruby" || d === "contents";
  } catch {
    return false;
  }
}

/** Cached per-anchor dark verdict via the shared theme probe. */
function darkFor(el: Element, cache: WeakMap<Element, boolean>): boolean {
  const hit = cache.get(el);
  if (hit !== undefined) return hit;
  const dark = isDarkContext(el);
  cache.set(el, dark);
  return dark;
}
