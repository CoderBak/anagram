// lib/render/badge.ts — Shadow-DOM per-unit badge layer.
//
// v2 renders each badge as an INLINE-FLOW chip inserted right after the unit's
// last text run (climbing out of inline ancestors so it never lands inside a
// link). Because it participates in layout it reflows with the text — no absolute
// positioning, no `position:relative` injection into page elements, no marker
// attributes on page DOM, no clipping by overflow ancestors, correct in RTL and
// with floats. The chip shows a colored dot + the extent-of-AI-editing number; a
// hover card carries the full readout.
//
// v3: a unit can render a PENDING chip the moment its batch is actually sent
// (renderPending) and morph in place when the verdict lands — the host is reused
// so the surrounding line lays out once. Hover cards are pointer-interactive
// (Copy-text action); Escape closes a pinned card.
//
// v4 (EditLens): the card shows the model's four-bucket distribution — human /
// lightly edited / heavily edited / AI-generated — as a stacked bar plus rows.
//
// v5: the chip states the UNIT's verdict. A paragraph longer than the model reads in one
// pass was read in windows; the chip shows their aggregate and the card says how it was
// read ("Scored in 3 windows" with each window's own number).
//
// The card renders in the browser's TOP LAYER (Popover API, manual mode), so no
// ancestor overflow:hidden / clip / stacking context can cut it off — an absolutely
// positioned descendant of the chip was clipped to the paragraph box on sites whose
// paragraphs hide overflow. Floating UI places it in viewport coordinates (flip
// above/below, shift to stay on screen, arrow middleware aims the caret) and
// autoUpdate re-places it while it shows (scroll, resize, content growth). Hover and
// pin drive show/hide from JS; where the Popover API is missing the card falls back to
// an absolutely positioned element with the same rules.
import { arrow, autoUpdate, computePosition, flip, offset, shift } from "@floating-ui/dom";
import type { Unit } from "../types";
import { MARK_ATTR } from "../types";
import type { UnitVerdict } from "../capture/windows";
import { band, BAND_LABEL, isNoVerdict, languageName, scorePct, type Band } from "./band";
import { countWords, hasLetters } from "../dom/text";
import { clipsOwnText } from "../dom/style";
import { coverageNote, windowPcts, windowReadout } from "./coverage";
import { distributionHtml } from "./dist";
import { BADGE_CSS } from "./badge.css";
import { isDarkContext } from "./theme";

export interface BadgeLayer {
  render(unit: Unit, verdict: UnitVerdict): void;
  /** Insert the chip in its "analyzing…" state (no verdict yet). */
  renderPending(unit: Unit): void;
  remove(id: string): void;
  /** Show/hide all badges without removing them (instant toggle, keeps results). */
  setVisible(visible: boolean): void;
  /** Forget cached background verdicts (site theme toggled; used by Rescan). */
  resetTheme(): void;
  /** Briefly pulse a badge (triage-panel jump target). */
  flash(id: string): void;
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
  /** Everything the layer knows about one box that clips (or is about to clip) its own
   *  text, keyed by the box. See settle() for the rule the group exists to keep. */
  const groups = new WeakMap<Element, ClipGroup>();
  const liveGroups = new Set<ClipGroup>();
  /** The group a unit's chip belongs to, so removing a chip frees the box's slot. */
  const groupOfUnit = new Map<string, ClipGroup>();

  /**
   * The chips of ONE box that clips its own text, and the one slot after it.
   *
   * A box like Goodreads' `div.TruncatedContent__text` or Steam's
   * `div.apphub_CardContentMain` shows a few lines of a review and keeps the rest in the
   * DOM. Every unit of such a review ends out of sight, so inserting each chip after the
   * box put ALL of them there: a live survey of one book page found 91 chips of distinct
   * units piled at 16 anchors, twelve in a row at the worst of them, reading 12%/85%/57%
   * one after another. So a box has exactly ONE slot after it, held by the FIRST unit in
   * document order whose own anchor is out of sight — the visible lines belong to it, or to
   * a unit before it that still shows its own chip. Every later unit keeps its chip at its
   * own anchor, out of sight while the box is collapsed and exactly right the moment the
   * reader opens it.
   */
  interface ClipGroup {
    box: Element;
    /** unit id → the chip and the node it closes, for every chip anchored in this box. */
    chips: Map<string, { host: HTMLElement; at: ChildNode }>;
    /** The unit holding the slot after the box, or null while nothing is out of sight. */
    parked: string | null;
    /** Rooted AT the box: it reports a chip crossing the edge of the visible band. */
    io: IntersectionObserver;
    /** The box's own height: "see more" and "see less", and a late image or web font. */
    ro: ResizeObserver;
  }

  function groupFor(box: Element): ClipGroup {
    let g = groups.get(box);
    if (g) return g;
    const wake = () => settle(g!);
    g = {
      box,
      chips: new Map(),
      parked: null,
      io: new IntersectionObserver(wake, { root: box, threshold: 0 }),
      ro: new ResizeObserver(wake),
    };
    g.ro.observe(box);
    groups.set(box, g);
    liveGroups.add(g);
    return g;
  }

  function retire(g: ClipGroup): void {
    g.io.disconnect();
    g.ro.disconnect();
    for (const id of g.chips.keys()) groupOfUnit.delete(id);
    g.chips.clear();
    g.parked = null;
    groups.delete(g.box);
    liveGroups.delete(g);
  }

  /** Forget one chip: its box's slot must never point at a unit that is gone. */
  function leaveGroup(id: string): void {
    const g = groupOfUnit.get(id);
    if (!g) return;
    const chip = g.chips.get(id);
    if (chip) g.io.unobserve(chip.host);
    g.chips.delete(id);
    groupOfUnit.delete(id);
    const wasParked = g.parked === id;
    if (wasParked) g.parked = null;
    if (g.chips.size === 0) retire(g);
    // The chip the reader could see has just left (the site edited that paragraph away, a
    // feed recycled it): the next paragraph that is out of sight takes the slot, so the
    // post does not end up collapsed with no verdict under it at all. settle() never
    // reaches this with a parked chip, so there is no way round for it to call itself.
    else if (wasParked) settle(g);
  }

  /**
   * Put every chip of one box where the rule says it goes.
   *
   * A page does not stand still: on a Goodreads book page the reviews grow after the chips
   * land, as their images and web fonts arrive (a box that showed the end of a review at
   * 141 px of 160 px showed it at 228 px seconds later), and a reader opens and closes a
   * post whenever they like. The box's own IntersectionObserver reports a chip crossing the
   * edge of the visible band and its ResizeObserver reports the box growing or shrinking;
   * either way the answer is the same — work out from ONE layout who is out of sight, then
   * move only the chips that are not where they belong. Reading first and writing second
   * keeps a move from changing the answer for the next chip, and moving nothing when
   * nothing changed is what keeps a standing page still: a move reflows the box, which
   * fires these very observers again.
   */
  function settle(g: ClipGroup): void {
    if (!g.box.isConnected) {
      retire(g);
      return;
    }
    let clipping = false;
    try {
      clipping = clipsOwnText(g.box, getComputedStyle(g.box));
    } catch {
      clipping = false; // detached mid-flight: nothing is hidden that we could know about
    }
    const band = g.box.getBoundingClientRect().bottom - 1;
    // READ — who has gone out of sight, and which of them comes first in the document.
    const gone = new Set<string>();
    let first: { id: string; at: ChildNode } | null = null;
    for (const [id, chip] of g.chips) {
      if (!chip.at.isConnected || !g.box.contains(chip.at)) {
        gone.add(id);
        continue;
      }
      if (!clipping) continue;
      const end = endRectOf(chip.at);
      // A node with no box of its own (a collapsed whitespace node, a hidden subtree) says
      // nothing about where it is drawn; leave such a chip at its anchor.
      if (!end || (end.width === 0 && end.height === 0) || end.top < band) continue;
      if (!first || precedes(chip.at, first.at)) first = { id, at: chip.at };
    }
    // WRITE — the slot first, then everyone's own anchor.
    g.parked = first ? first.id : null;
    for (const [id, chip] of g.chips) {
      if (gone.has(id)) continue;
      const target: ChildNode = id === g.parked ? g.box : chip.at;
      if (chip.host.previousSibling !== target) target.after(chip.host);
      // A parked chip is no longer a descendant of the root, so the observer has nothing to
      // say about it; the box's ResizeObserver is what brings it home again.
      if (id === g.parked) g.io.unobserve(chip.host);
      else g.io.observe(chip.host);
    }
    for (const id of gone) leaveGroup(id);
  }

  /** Find or (re)build the chip host for a unit, inserted after its last run. */
  function ensureHost(unit: Unit): HTMLElement | null {
    let host = hosts.get(unit.id);
    if (!host || !host.isConnected) {
      host?.remove();
      const placement = insertionPoint(unit);
      if (!placement) return null; // unit detached mid-flight — purge will collect it
      host = buildHost();
      hosts.set(unit.id, host);
      if (!placement.clip) {
        leaveGroup(unit.id);
        placement.at.after(host);
      } else {
        // Inside a box that clips its own text the chip is not placed on its own: the box
        // settles all of its chips together, so that only one of them can sit after it.
        leaveGroup(unit.id);
        const g = groupFor(placement.clip.box);
        g.chips.set(unit.id, { host, at: placement.at });
        groupOfUnit.set(unit.id, g);
        placement.at.after(host);
        settle(g);
      }
    }
    host.classList.toggle("pg-hidden", !visible);
    host.classList.toggle("pg-dark", darkFor(unit.container, darkCache));
    return host;
  }

  function render(unit: Unit, verdict: UnitVerdict): void {
    const result = verdict.result;
    const b: Band = band(result);
    const host = ensureHost(unit);
    if (!host) return;

    const root = host.shadowRoot!;
    const pill = root.querySelector(".pill") as HTMLElement;
    const num = root.querySelector(".num") as HTMLElement;
    const pct = scorePct(result);

    pill.className = `pill band-${b}`;
    // The bare number ("38%") — what it means is in the card and the intro, not on
    // every line. A merged unit says so up front ("38% ×3"): one verdict covering N
    // short paragraphs must never masquerade as a single-paragraph judgment.
    const xn = unit.parts.length > 1 ? ` ×${unit.parts.length}` : "";
    // Unsupported language → the detected code ("zh"), never a number.
    num.textContent =
      (b === "unknown" ? "?" : b === "unsupported" ? (result.lang ?? "n/a") : `${pct}%`) + xn;

    renderCard(root.querySelector(".card") as HTMLElement, unit, verdict, b, pct);
  }

  function renderPending(unit: Unit): void {
    if (hosts.get(unit.id)?.shadowRoot?.querySelector(".card .head")) return; // verdict already painted
    const host = ensureHost(unit);
    if (!host) return;
    const root = host.shadowRoot!;
    const pill = root.querySelector(".pill") as HTMLElement;
    if (pill.classList.contains("pending")) return;
    pill.className = "pill band-unknown pending";
    (root.querySelector(".num") as HTMLElement).textContent = "···";
    (root.querySelector(".card") as HTMLElement).innerHTML =
      `<div class="foot" style="margin:0;padding:0;border:0">Analyzing this paragraph…</div>`;
  }

  function buildHost(): HTMLElement {
    const host = document.createElement("span");
    host.setAttribute(MARK_ATTR, "host");
    host.setAttribute("aria-hidden", "true");
    // Inline styles back up the !important :host rules against page CSS.
    host.style.cssText = "display:inline-block;position:relative;margin-inline-start:6px;";
    // A badge can legitimately sit inside an <a>; a click on it must never
    // navigate or trigger page handlers. A click/tap also PINS the card open
    // (the hover story for touch devices); a second tap unpins. Clicks INSIDE
    // the card (Copy action) must not toggle the pin.
    host.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = cardOf(host);
      if (!card) return;
      if (e.composedPath().includes(card)) return; // card-internal click (action button)
      const opening = !card.classList.contains("open");
      closeOpenCard();
      if (opening) {
        showCard(host);
        card.classList.add("open"); // pinned
        _openCardHost = host;
      }
    });
    // Hover shows the card; leaving hides it unless it is pinned.
    host.addEventListener("mouseenter", () => showCard(host));
    host.addEventListener("mouseleave", () => {
      if (_openCardHost !== host) hideCard(host);
    });
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
    // Top layer where available (Chrome 114+, Firefox 125+): immune to clipping.
    if ("showPopover" in card) card.setAttribute("popover", "manual");

    shadow.append(pill, card);
    return host;
  }

  function renderCard(
    card: HTMLElement,
    unit: Unit,
    verdict: UnitVerdict,
    b: Band,
    pct: number,
  ): void {
    const result = verdict.result;
    const row = (k: string, v: string, cls = "") =>
      `<div class="row${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    const partsRow =
      unit.parts.length > 1
        ? row("Paragraphs analyzed together", `${unit.parts.length}`)
        : "";

    // The model's whole 4-way distribution is the honest part of the readout. Skip
    // it for "unknown" — a flat gray bar reads as data when the message is "no answer".
    const dist = isNoVerdict(b) ? "" : distributionHtml(result, b);
    // Coverage, honestly. "Words" is the whole unit. A unit read in one pass says nothing
    // more; one read in windows shows each window's own number, in reading order, next to
    // the aggregate above; and "Scored: first N words" is left for the one case in which
    // the model really saw less than the unit — a text past the window cap.
    const read = isNoVerdict(b) ? null : windowReadout(verdict);
    const last = verdict.windows[verdict.windows.length - 1];
    const coverageRows = isNoVerdict(b)
      ? ""
      : (read ? row(`Scored in ${read.count} windows`, windowPcts(read), " wins") : "") +
        (verdict.unreadChars > 0 && last
          ? row("Scored", `first ${countWords(unit.text.slice(0, last.end))} words`)
          : "") +
        (read && read.cutShort > 0 ? row("Windows cut short", `${read.cutShort} of ${read.count}`) : "") +
        (read && read.skipped > 0 ? row("Windows not in English", `${read.skipped} of ${read.count}`) : "");
    // Formula-heavy prose was scored with holes where the math was — say so.
    const formulaRow = !isNoVerdict(b) && unit.formulas > 0 ? row("Formulas omitted", `${unit.formulas}`) : "";
    const langRow =
      b === "unsupported"
        ? row("Detected language", `${languageName(result.lang)} · ${Math.round((result.lang_prob ?? 0) * 100)}%`)
        : "";
    const foot =
      b === "unknown"
        ? "The scoring daemon did not answer. Retried automatically once it is running."
        : b === "unsupported"
          ? "EditLens is trained on English text only, so this paragraph was not scored."
          : coverageNote(verdict, "paragraph") +
            "The number is EditLens's estimate of how far this text sits from untouched " +
            "human writing toward fully AI-generated — not a share of words, not proof.";
    card.innerHTML =
      `<div class="head"><span class="verdict band-${b}">${BAND_LABEL[b]}</span>` +
      `<span class="big" title="Extent of AI editing (EditLens scale)">${isNoVerdict(b) ? "—" : pct + "%"}</span></div>` +
      dist +
      langRow +
      partsRow +
      row("Words", `${unit.wordCount}`) +
      coverageRows +
      formulaRow +
      // tabindex="-1": the chip host is aria-hidden on purpose (see the header), so a
      // focusable button inside it would be a tab stop that announces nothing at all —
      // one per pinned card. This action is a pointer affordance; the keyboard route to
      // the same text is "Copy report" in the triage panel, which is properly exposed.
      `<div class="actions"><button type="button" tabindex="-1" class="act copy">Copy text</button></div>` +
      `<div class="foot">${foot}</div>` +
      `<span class="caret"></span>`;

    const copy = card.querySelector(".act.copy") as HTMLButtonElement;
    copy.addEventListener("click", (e) => {
      e.stopPropagation();
      copyText(unit.text, copy);
    });
  }

  function remove(id: string): void {
    const host = hosts.get(id);
    if (!host) return;
    if (host === _openCardHost) _openCardHost = null;
    hideCard(host);
    host.remove();
    hosts.delete(id);
    leaveGroup(id);
  }

  function setVisible(v: boolean): void {
    visible = v;
    for (const [, host] of hosts) host.classList.toggle("pg-hidden", !v);
  }

  function resetTheme(): void {
    darkCache = new WeakMap();
  }

  function flash(id: string): void {
    const pill = hosts.get(id)?.shadowRoot?.querySelector(".pill");
    if (!pill) return;
    pill.classList.remove("pg-flash"); // restart if already flashing
    void (pill as HTMLElement).offsetWidth;
    pill.classList.add("pg-flash");
    setTimeout(() => pill.classList.remove("pg-flash"), 1600);
  }

  function teardownAll(): void {
    for (const [, host] of hosts) {
      hideCard(host);
      host.remove();
    }
    hosts.clear();
    for (const g of [...liveGroups]) retire(g);
    groupOfUnit.clear();
    _openCardHost = null;
  }

  return { render, renderPending, remove, setVisible, resetTheme, flash, teardownAll };
}

/** Copy with execCommand fallback (Clipboard API can be permission-blocked). */
function copyText(text: string, button: HTMLElement): void {
  const done = () => {
    const prev = button.textContent;
    button.textContent = "Copied ✓";
    button.classList.add("done");
    setTimeout(() => {
      button.textContent = prev;
      button.classList.remove("done");
    }, 1400);
  };
  navigator.clipboard.writeText(text).then(done, () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      done();
    } finally {
      ta.remove();
    }
  });
}

// One pinned card at a time; tapping anywhere else (or Escape) closes it.
let _openCardHost: HTMLElement | null = null;
let _outsideCloserInstalled = false;

function closeOpenCard(): void {
  const host = _openCardHost;
  if (!host) return;
  _openCardHost = null;
  cardOf(host)?.classList.remove("open");
  if (!host.matches(":hover")) hideCard(host); // still hovered → stays as a hover card
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
  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Escape" && _openCardHost) closeOpenCard();
    },
    true,
  );
}

// ---- card show / hide / placement --------------------------------------------------

const _floating = new WeakMap<HTMLElement, () => void>();

function cardOf(host: HTMLElement): HTMLElement | null {
  return (host.shadowRoot?.querySelector(".card") as HTMLElement | null) ?? null;
}

/** Make the card visible (top-layer popover, or the CSS fallback) and keep it placed. */
function showCard(host: HTMLElement): void {
  const card = cardOf(host);
  if (!card) return;
  if (card.hasAttribute("popover")) {
    if (!card.matches(":popover-open")) {
      try {
        card.showPopover();
      } catch {
        /* not connected — nothing to show */
      }
    }
  } else {
    card.classList.add("showing");
  }
  startFloating(host); // after showing: a display:none popover has no size to measure
}

function hideCard(host: HTMLElement): void {
  stopFloating(host);
  const card = cardOf(host);
  if (!card) return;
  if (card.hasAttribute("popover")) {
    if (card.matches(":popover-open")) {
      try {
        card.hidePopover();
      } catch {
        /* already hidden */
      }
    }
  } else {
    card.classList.remove("showing");
  }
}

/** Place the card once: above the chip, flipped below when that would leave the
 *  viewport, shifted to stay inside it, caret aimed at the chip. In a window too short
 *  for the card on either side of the chip (a docked devtools pane, a half-height tile)
 *  the card slides over the chip rather than off the screen; the caret then points at
 *  nothing and is hidden. */
function positionCard(host: HTMLElement): void {
  const root = host.shadowRoot;
  const pill = root?.querySelector(".pill") as HTMLElement | null;
  const card = root?.querySelector(".card") as HTMLElement | null;
  if (!pill || !card) return;
  const caret = card.querySelector(".caret") as HTMLElement | null;
  void computePosition(pill, card, {
    placement: "top",
    // Top-layer elements are positioned against the viewport; the fallback card is
    // positioned inside the host.
    strategy: card.hasAttribute("popover") ? "fixed" : "absolute",
    middleware: [
      offset(9),
      flip({ padding: 8 }),
      shift({ padding: 8, crossAxis: true }),
      ...(caret ? [arrow({ element: caret, padding: 10 })] : []),
    ],
  }).then(({ x, y, placement, middlewareData }) => {
    card.style.left = `${x}px`;
    card.style.top = `${y}px`;
    card.classList.toggle("below", placement.startsWith("bottom"));
    card.classList.toggle("overlap", Math.abs(middlewareData.shift?.y ?? 0) > 0.5);
    if (caret) {
      const ax = middlewareData.arrow?.x;
      caret.style.left = ax != null ? `${ax}px` : "";
    }
  });
}

/** Keep the card placed while it shows (scroll, resize, content growth). Idempotent. */
function startFloating(host: HTMLElement): void {
  if (_floating.has(host)) return;
  const root = host.shadowRoot;
  const pill = root?.querySelector(".pill");
  const card = root?.querySelector(".card") as HTMLElement | null;
  if (!pill || !card) return;
  _floating.set(host, autoUpdate(pill, card, () => positionCard(host)));
}

function stopFloating(host: HTMLElement): void {
  _floating.get(host)?.();
  _floating.delete(host);
}

/**
 * Where the badge goes: after the unit's last text node, climbed out of inline
 * ancestors so the chip sits in the block's flow (never inside an <a>/<em>), then
 * moved past whatever decorates the end of the line. Climbing only continues while
 * the node is the LAST meaningful child of its inline parent — an inline wrapper can
 * span many BR-separated paragraphs (1990s-style <font> essays), and climbing past
 * mid-wrapper content would pile every badge at the wrapper's end.
 */
function insertionPoint(unit: Unit): Placement | null {
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
  const at = lastDecoratedSibling(n as ChildNode);
  return { at, clip: clippingBoxOf(at) };
}

/** The node a chip closes and — when that node is inside a box that clips its own text, or
 *  is about to — which box that is, so the layer settles the box's chips together. */
interface Placement {
  at: ChildNode;
  clip: { box: Element } | null;
}

/** The container a chip must never leave: it belongs to the post it judges. */
const POST_SELECTOR = 'article,[role="article"],[role="link"],main,body';
/** How far above the text a "see more" box may sit. LinkedIn's is the text's own parent,
 *  Goodreads' two levels up; more than this and the box is page layout, not a post. */
const CLIP_BOX_LEVELS = 6;

/**
 * Feeds show three lines of a post and keep the rest in the DOM behind "see more"
 * (LinkedIn's `span[data-testid=expandable-text-box]` and its older
 * `div.feed-shared-inline-show-more-text`, Goodreads' `div.TruncatedContent__text`,
 * Substack's line-clamped `div.pencraft`). The text is read — it is one author's post
 * and the reader can open it — but the chip must not be inserted after its last word,
 * because that word is inside the clipped box where nobody sees it.
 *
 * So: the nearest ancestor that clips its own text is found (at most CLIP_BOX_LEVELS up),
 * and that box then decides where its chips go — at most one of them after it, the rest at
 * their own anchors (see the ClipGroup above). A box that merely CAPS its own height is
 * found too, although it hides nothing yet: Goodreads' review boxes are not clipping when
 * the chips land, because the cover images and the web font arrive afterwards and push the
 * text past the cap, and a chip nobody is watching is a chip that stays out of sight for
 * good (the survey left 25 of them on one Steam page).
 *
 * The one thing the chip may not do is leave its POST, so the box has to lie inside the
 * post the anchor belongs to. Structure INSIDE the clipped text — a quotation, a list, a
 * spoiler span — is not a post boundary: stopping the climb at every `blockquote`/`li`
 * left the chips of quoted passages in Goodreads reviews inside the truncated box, out
 * of sight (measured: 2 of 150 chips on one book page).
 */
function clippingBoxOf(at: ChildNode): { box: Element } | null {
  const start = at.nodeType === Node.ELEMENT_NODE ? (at as Element) : at.parentElement;
  if (!start) return null;
  let box: Element | null = null;
  try {
    for (let el: Element | null = start, i = 0; el && i < CLIP_BOX_LEVELS; i++, el = el.parentElement) {
      const cs = getComputedStyle(el);
      if (clipsOwnText(el, cs) || capsOwnHeight(el, cs)) {
        box = el;
        break;
      }
    }
    if (!box) return null;
    const post = start.closest(POST_SELECTOR);
    if (post && (post === box || !post.contains(box))) return null; // the box is not inside the post
  } catch {
    return null;
  }
  // No box of its own (a collapsed whitespace node): leave the chip where it is.
  const anchor = endRectOf(at);
  if (!anchor || (anchor.width === 0 && anchor.height === 0)) return null;
  return { box };
}

/** Page-level boxes, the ones lib/dom/style.ts also refuses to call clipped: `body` under
 *  an open modal, an app's own scrolling region, a `<details>` that hides its content by
 *  other means. A cap on one of those is layout, never a post behind "see more". */
const NEVER_CAPPED_TAGS = new Set(["HTML", "BODY", "MAIN", "DETAILS"]);
/** A box as tall as the screen is the page's own, not a preview of a post. */
const CAP_MAX_VIEWPORT_SHARE = 0.9;

/**
 * A box that CAPS its own height and hides whatever grows past the cap — it may not be
 * clipping anything yet. Only a DECLARED cap counts (`max-height`, a line clamp): plain
 * `overflow: hidden` sits on half the wrappers of a modern page and none of those is a
 * post behind "see more", while `max-height` with the text still short of it is exactly
 * the Goodreads review whose images have not arrived.
 */
function capsOwnHeight(el: Element, cs: CSSStyleDeclaration): boolean {
  const overflowY = cs.overflowY;
  if (overflowY !== "hidden" && overflowY !== "clip") return false;
  if (NEVER_CAPPED_TAGS.has(el.nodeName) || el.getAttribute("role") === "main") return false;
  if (cs.maxHeight === "none" && cs.getPropertyValue("-webkit-line-clamp") === "none") return false;
  const viewport = typeof window !== "undefined" ? window.innerHeight : 0;
  return viewport === 0 || el.clientHeight < viewport * CAP_MAX_VIEWPORT_SHARE;
}

/**
 * True when the line `a` closes comes before the line `b` closes — which of two hidden
 * units owns the one slot after their box is a question about reading order, not about the
 * order the daemon answered in. Anchors nest: a Goodreads review is one `<span>` of
 * BR-separated paragraphs, so the last paragraph's anchor is the span ITSELF and holds
 * every earlier anchor inside it. A container starts before its contents and ENDS after
 * them, and it is the end that the chip closes.
 */
function precedes(a: Node, b: Node): boolean {
  const rel = a.compareDocumentPosition(b);
  if (rel & Node.DOCUMENT_POSITION_CONTAINED_BY) return false; // b sits inside a, so a ends later
  if (rel & Node.DOCUMENT_POSITION_CONTAINS) return true; // a sits inside b, so a ends first
  return (rel & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

/**
 * Rectangle of the LAST line of a node — where the chip would actually be drawn. The
 * whole-node rectangle is no use here: the text of a clipped post starts at the top of
 * the box, on screen, and ends far below it.
 */
function endRectOf(node: ChildNode): DOMRect | null {
  try {
    let rects: DOMRectList;
    if (node.nodeType === Node.ELEMENT_NODE) {
      rects = (node as Element).getClientRects();
      if (rects.length === 0) return (node as Element).getBoundingClientRect();
    } else {
      const range = document.createRange();
      range.selectNodeContents(node);
      rects = range.getClientRects();
      if (rects.length === 0) return range.getBoundingClientRect();
    }
    return rects[rects.length - 1];
  } catch {
    return null;
  }
}

/**
 * Trailing inline decoration: the emoji image, icon or citation mark a sentence ends
 * with. It carries no letters of its own and the walker never scored it, so the chip
 * belongs AFTER it — otherwise the chip lands mid-line, in front of the emoji that
 * closes a comment (Zhihu, chat apps) or in front of a "[7]" reference (Wikipedia).
 * <br> is never a decoration: the chip must not jump to the next line.
 */
function isTrailingDecoration(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").trim() === "";
  if (node.nodeType !== Node.ELEMENT_NODE) return true; // comments, processing instructions
  const el = node as Element;
  if (el.hasAttribute(MARK_ATTR)) return true; // our own UI
  if (el.nodeName === "BR") return false;
  if (hasLetters(el.textContent ?? "")) return false; // real words — the run ends before it
  return isInlineFlowElement(el);
}

/** `n`, or the last trailing decoration after it (so the chip closes the line). */
function lastDecoratedSibling(n: ChildNode): ChildNode {
  let last = n;
  for (let sib = n.nextSibling; sib && isTrailingDecoration(sib); sib = sib.nextSibling) {
    if (sib.nodeType === Node.ELEMENT_NODE && !(sib as Element).hasAttribute(MARK_ATTR)) {
      last = sib as ChildNode;
    }
  }
  return last;
}

/** True if nothing but whitespace, decorations or our own hosts follows `n`. */
function isLastMeaningfulChild(n: Node, _parent: Element): boolean {
  for (let sib = n.nextSibling; sib; sib = sib.nextSibling) {
    if (!isTrailingDecoration(sib)) return false;
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
