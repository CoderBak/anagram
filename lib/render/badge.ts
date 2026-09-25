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
// pass was read in several; the chip shows their aggregate and the card says how it was
// read ("Read in 3 passes" with each pass's own number).
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
import { messageLocale, t } from "../i18n";
import { band, bandLabel, isNoVerdict, languageName, type Band } from "./band";
import { formatScore } from "./score";
import { clearActiveUnit, setActiveUnit } from "./highlight";
import { countWords, hasLetters, unitParagraphs } from "../dom/text";
import { coverageNote, windowScores, windowReadout } from "./coverage";
import { distributionHtml, swatchHtml } from "./dist";
import { verdictConfidence } from "./confidence";
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

export interface BadgeLayerOptions {
  /**
   * Put a chip somewhere the page's own flow cannot: the surface places the host itself
   * and says so by returning true. The PDF reader supplies this — a page there is an
   * absolutely positioned text layer over a drawing, where "after the last text node" is
   * a place with no meaning, and a chip belongs in the white space at the end of the
   * paragraph's last line, in the page's own coordinates. Everything else about the chip
   * — its look, its card, its theme, its flash — is unchanged, and the default path (a
   * chip in the flow after the last run) is untouched.
   */
  place?: (unit: Unit, host: HTMLElement) => boolean;
}

export function createBadgeLayer(options: BadgeLayerOptions = {}): BadgeLayer {
  installOutsideCloser();
  const hosts = new Map<string, HTMLElement>();
  // Dark-context verdict per container (invalidated via resetTheme on Rescan).
  let darkCache = new WeakMap<Element, boolean>();
  let visible = true;
  /** Everything the layer knows about one box that clips (or is about to clip) its own
   *  text, keyed by the box. See planFor() for the rule the group exists to keep. */
  const groups = new WeakMap<Element, ClipGroup>();
  const liveGroups = new Set<ClipGroup>();
  /** The group a unit's chip belongs to, so removing a chip frees the box's slot. */
  const groupOfUnit = new Map<string, ClipGroup>();
  /** Boxes woken since the last flush, and the frame (or timer) that will answer them. */
  const dirty = new Set<ClipGroup>();
  let rafId = 0;
  let timerId = 0;

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
    /** What the box measured when its chips were last placed. A box woken by nothing but
     *  its own ResizeObserver, measuring what it measured last time, has nothing to say. */
    sig: string;
    /** A chip has crossed the box's edge: the anchors have to be read again whatever the
     *  box itself measures. */
    crossed: boolean;
  }

  function groupFor(box: Element): ClipGroup {
    let g = groups.get(box);
    if (g) return g;
    g = {
      box,
      chips: new Map(),
      parked: null,
      io: new IntersectionObserver(() => wake(g!, true), { root: box, threshold: 0 }),
      ro: new ResizeObserver(() => wake(g!, false)),
      sig: "",
      crossed: false,
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
    dirty.delete(g);
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
    // post does not end up collapsed with no verdict under it at all.
    else if (wasParked) wake(g, true);
  }

  /**
   * A page does not stand still: on a Goodreads book page the reviews grow after the chips
   * land, as their images and web fonts arrive (a box that showed the end of a review at
   * 141 px of 160 px showed it at 228 px seconds later), and a reader opens and closes a
   * post whenever they like. Each box's IntersectionObserver reports a chip crossing the
   * edge of its visible band and its ResizeObserver reports the box growing or shrinking.
   *
   * Every one of those wakes a box; they are answered TOGETHER, once a frame. Measuring one
   * box and moving its chips, then measuring the next, makes the browser lay the page out
   * again between every pair — a page of sixty clamped cards paid 443 layouts more than the
   * same page without the extension, one per chip and one per observer tick. So a wake only
   * marks the box dirty, and the flush reads every dirty box first and writes to all of them
   * afterwards: one layout for the batch, however many boxes are in it.
   */
  function wake(g: ClipGroup, crossed: boolean): void {
    if (crossed) g.crossed = true;
    dirty.add(g);
    if (rafId || timerId) return;
    const run = () => {
      unschedule();
      flush();
    };
    rafId = requestAnimationFrame(run);
    // A tab in the background is served no frames at all, and a chip still has to be where
    // it belongs by the time the reader comes back to it.
    timerId = setTimeout(run, 50) as unknown as number;
  }

  function unschedule(): void {
    if (rafId) cancelAnimationFrame(rafId);
    if (timerId) clearTimeout(timerId);
    rafId = 0;
    timerId = 0;
  }

  function flush(): void {
    const batch = [...dirty];
    dirty.clear();
    const plans: ClipPlan[] = [];
    for (const g of batch) {
      const plan = planFor(g); // READS only
      if (plan) plans.push(plan);
    }
    for (const plan of plans) apply(plan); // WRITES only
  }

  /** Where every chip of one box belongs, worked out from ONE layout. Reads nothing back
   *  after a write, so the answer for the last chip is as true as the answer for the first. */
  interface ClipPlan {
    g: ClipGroup;
    parked: string | null;
    gone: Set<string>;
  }

  function planFor(g: ClipGroup): ClipPlan | null {
    if (!g.box.isConnected) {
      retire(g);
      return null;
    }
    let clipping = false;
    let sig = "";
    try {
      clipping = hidesOwnText(g.box, getComputedStyle(g.box));
      sig = `${clipping}|${g.box.clientHeight}|${g.box.scrollHeight}|${g.chips.size}`;
    } catch {
      return null; // detached mid-flight: nothing is hidden that we could know about
    }
    // The box measures what it measured when its chips were placed and nothing has crossed
    // its edge since: reading every anchor again would answer the same question twice. A
    // ResizeObserver reports its target once as soon as it is observed, and a page of sixty
    // cards would otherwise pay sixty pointless measurements to be told nothing had changed.
    if (!g.crossed && sig === g.sig) return null;
    g.crossed = false;
    g.sig = sig;
    const band = g.box.getBoundingClientRect().bottom - 1;
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
    return { g, parked: first ? first.id : null, gone };
  }

  function apply(plan: ClipPlan): void {
    const g = plan.g;
    g.parked = plan.parked;
    for (const [id, chip] of g.chips) {
      if (plan.gone.has(id)) continue;
      const target: ChildNode = id === g.parked ? g.box : chip.at;
      if (chip.host.previousSibling !== target) {
        target.after(chip.host);
        g.sig = ""; // the box holds different content now: measure it again when next woken
      }
      // A parked chip is no longer a descendant of the root, so the observer has nothing to
      // say about it; the box's ResizeObserver is what brings it home again.
      if (id === g.parked) g.io.unobserve(chip.host);
      else g.io.observe(chip.host);
    }
    for (const id of plan.gone) leaveGroup(id);
  }

  /**
   * Where ONE chip goes, the moment it is built. insertionPoint has just measured both
   * things the rule needs — whether the box hides text of its own, and whether this chip's
   * own last line is in the hidden part — so no page geometry is read here at all. Settling
   * the whole box on every insertion instead cost one measurement per chip (180 chips in 60
   * cards: 180 whole-box settles, each forcing a layout of its own). Whatever ELSE the
   * insertion moved is the observers' business, and they answer in one batch.
   */
  function placeOne(g: ClipGroup, id: string, hidden: boolean): void {
    const chip = g.chips.get(id);
    if (!chip) return;
    const held = g.parked && g.parked !== id ? g.chips.get(g.parked) : null;
    if (hidden && (!held || precedes(chip.at, held.at))) {
      if (held) {
        // An earlier paragraph takes the slot; the one that held it goes back to its own
        // last word, which is out of sight until the reader opens the post.
        held.at.after(held.host);
        g.io.observe(held.host);
      }
      g.parked = id;
      g.box.after(chip.host);
      g.io.unobserve(chip.host);
    } else {
      g.io.observe(chip.host);
    }
    g.sig = ""; // the box holds one more chip than it did: measure it again when next woken
  }

  /** Find or (re)build the chip host for a unit, inserted after its last run. */
  function ensureHost(unit: Unit): HTMLElement | null {
    let host = hosts.get(unit.id);
    if (!host || !host.isConnected) {
      host?.remove();
      if (options.place) {
        const own = buildHost(unit.id);
        if (!options.place(unit, own)) return null;
        hosts.set(unit.id, own);
        host = own;
        host.classList.toggle("pg-hidden", !visible);
        host.classList.toggle("pg-dark", darkFor(unit.container, darkCache));
        return host;
      }
      const placement = insertionPoint(unit);
      if (!placement) return null; // unit detached mid-flight — purge will collect it
      host = buildHost(unit.id);
      hosts.set(unit.id, host);
      if (!placement.clip) {
        leaveGroup(unit.id);
        placement.at.after(host);
      } else {
        // Inside a box that clips its own text a chip belongs to the box, which owns the one
        // slot after it and hands it to the first paragraph that is out of sight.
        leaveGroup(unit.id);
        const g = groupFor(placement.clip.box);
        g.chips.set(unit.id, { host, at: placement.at });
        groupOfUnit.set(unit.id, g);
        placement.at.after(host);
        placeOne(g, unit.id, placement.clip.clipping && placement.clip.hidden);
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
    const score = formatScore(result.score);

    // The dot is the score's own colour (lib/render/scale.ts), a thinner ring the less likely
    // its word is right (lib/render/confidence.ts); the text stays in ink, whatever the verdict.
    const sure = verdictConfidence(verdict);
    pill.className = `pill band-${b}${isNoVerdict(b) ? "" : " scored"}`;
    pill.style.setProperty("--s", result.score.toFixed(3));
    pill.style.setProperty("--u", (1 - sure).toFixed(3));
    // The bare number (".38") — what it means is in the card and the intro, not on
    // every line. A merged unit says so up front (".38 ×3"): one verdict covering N
    // short paragraphs must never masquerade as a single-paragraph judgment. How many
    // paragraphs that is is the unit's to say (unitParagraphs): in a PDF the parts are the
    // pieces a page break or a column cut ONE paragraph into.
    const paragraphs = unitParagraphs(unit);
    const xn = paragraphs > 1 ? ` ×${paragraphs}` : "";
    // Unsupported language → the detected code ("zh"), never a number.
    num.textContent =
      (b === "unknown" ? "?" : b === "unsupported" ? (result.lang ?? "n/a") : score) + xn;

    renderCard(root.querySelector(".card") as HTMLElement, unit, verdict, b, score);
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
      `<div class="foot" style="margin:0;padding:0;border:0">${t("cardPending")}</div>`;
  }

  function buildHost(id: string): HTMLElement {
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
        setActiveUnit(id);
      }
    });
    // Hover shows the card and lights up everything this unit was read from; leaving
    // hides the card and puts the marks back unless the card is pinned.
    host.addEventListener("mouseenter", () => {
      showCard(host);
      setActiveUnit(id);
    });
    host.addEventListener("mouseleave", () => {
      if (_openCardHost === host) return;
      hideCard(host);
      clearActiveUnit(id);
    });
    _hostUnit.set(host, id);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = [badgeSheet()];

    const pill = document.createElement("span");
    pill.className = "pill";
    // The chip and its card are ours, not the page's: they are in the UI's language,
    // whatever the article around them is written in. Screen readers and the CJK font
    // fallback both need that said on the elements themselves.
    pill.lang = messageLocale();
    const dot = document.createElement("span");
    dot.className = "dot";
    const num = document.createElement("span");
    num.className = "num";
    pill.append(dot, num);

    const card = document.createElement("div");
    card.className = "card";
    card.lang = pill.lang;
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
    score: string,
  ): void {
    const result = verdict.result;
    const row = (k: string, v: string, cls = "") =>
      `<div class="row${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    const paragraphs = unitParagraphs(unit);
    const partsRow = paragraphs > 1 ? row(t("cardPartsTogether"), `${paragraphs}`) : "";

    // The model's whole 4-way distribution is the honest part of the readout. Skip
    // it for "unknown" — a flat gray bar reads as data when the message is "no answer".
    const dist = isNoVerdict(b) ? "" : distributionHtml(result);
    // Coverage, honestly. "Words" is the whole unit. A unit read in one pass says nothing
    // more; one read in several passes shows each pass's own number, in reading order, next to
    // the aggregate above; and "Scored: first N words" is left for the one case in which
    // the model really saw less than the unit — a text past the pass cap.
    const read = isNoVerdict(b) ? null : windowReadout(verdict);
    const last = verdict.windows[verdict.windows.length - 1];
    const coverageRows = isNoVerdict(b)
      ? ""
      : (read ? row(t("cardWindows", read.count), windowScores(read), " wins") : "") +
        (verdict.unreadChars > 0 && last
          ? row(t("cardScored"), t("cardFirstWords", countWords(unit.text.slice(0, last.end))))
          : "") +
        (read && read.cutShort > 0 ? row(t("cardWindowsCut"), t("cardOfCount", read.cutShort, read.count)) : "") +
        (read && read.skipped > 0 ? row(t("cardWindowsSkipped"), t("cardOfCount", read.skipped, read.count)) : "");
    // Formula-heavy prose was scored with holes where the math was — say so.
    const formulaRow = !isNoVerdict(b) && unit.formulas > 0 ? row(t("cardFormulas"), `${unit.formulas}`) : "";
    const langRow =
      b === "unsupported"
        ? row(t("cardDetectedLang"), `${languageName(result.lang)} · ${Math.round((result.lang_prob ?? 0) * 100)}%`)
        : "";
    const foot =
      b === "unknown"
        ? t("cardFootUnavailable")
        : b === "unsupported"
          ? t("cardFootUnsupported")
          : coverageNote(verdict, "paragraph") + t("cardFootEstimate");
    card.innerHTML =
      `<div class="head"><span class="verdict band-${b}">${isNoVerdict(b) ? "" : swatchHtml(result, verdictConfidence(verdict))}${bandLabel(b)}</span>` +
      `<span class="big" title="${t("cardScaleTitle")}">${isNoVerdict(b) ? "—" : score}</span></div>` +
      dist +
      langRow +
      partsRow +
      row(t("cardWords"), `${unit.wordCount}`) +
      coverageRows +
      formulaRow +
      // tabindex="-1": the chip host is aria-hidden on purpose (see the header), so a
      // focusable button inside it would be a tab stop that announces nothing at all —
      // one per pinned card. This action is a pointer affordance; the keyboard route to
      // the same text is "Copy report" in the triage panel, which is properly exposed.
      `<div class="actions"><button type="button" tabindex="-1" class="act copy">${t("cardCopyText")}</button></div>` +
      `<div class="foot">${foot}</div>` +
      `<span class="caret"></span>`;

    const copy = card.querySelector(".act.copy") as HTMLButtonElement;
    // tabindex="-1" keeps the keyboard out; a press would still focus the button in Chrome,
    // which then un-hides the host and warns "Blocked aria-hidden on an element…".
    copy.addEventListener("mousedown", (e) => e.preventDefault());
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
    clearActiveUnit(id);
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
    // A jump landed here: show what was read, the way a hover would, for as long as the
    // pulse lasts. Whoever pressed the key has no pointer on the chip to hold it open.
    setActiveUnit(id);
    setTimeout(() => {
      pill.classList.remove("pg-flash");
      const host = hosts.get(id);
      if (host && host !== _openCardHost && !host.matches(":hover")) clearActiveUnit(id);
    }, 1600);
  }

  function teardownAll(): void {
    for (const [id, host] of hosts) {
      hideCard(host);
      clearActiveUnit(id);
      host.remove();
    }
    hosts.clear();
    unschedule();
    for (const g of [...liveGroups]) retire(g);
    groupOfUnit.clear();
    dirty.clear();
    _openCardHost = null;
  }

  return { render, renderPending, remove, setVisible, resetTheme, flash, teardownAll };
}

/** Copy with execCommand fallback (Clipboard API can be permission-blocked). */
function copyText(text: string, button: HTMLElement): void {
  const flash = (text: string, cls: string) => {
    const prev = button.textContent;
    button.textContent = text;
    button.classList.add(cls);
    setTimeout(() => {
      button.textContent = prev;
      button.classList.remove(cls);
    }, 1400);
  };
  const done = () => flash(t("copied"), "done");
  const failed = () => flash(t("reportCopyFailed"), "failed");
  navigator.clipboard.writeText(text).then(done, () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta);
    ta.select();
    try {
      if (document.execCommand("copy")) done();
      else failed();
    } finally {
      ta.remove();
    }
  });
}

// One pinned card at a time; tapping anywhere else (or Escape) closes it.
let _openCardHost: HTMLElement | null = null;
let _outsideCloserInstalled = false;
/** Which unit a chip host speaks for — closing a pinned card has only the host in hand,
 *  and the marks it lit up are the unit's. */
const _hostUnit = new WeakMap<HTMLElement, string>();

function closeOpenCard(): void {
  const host = _openCardHost;
  if (!host) return;
  _openCardHost = null;
  cardOf(host)?.classList.remove("open");
  if (host.matches(":hover")) return; // still hovered → stays as a hover card, marks and all
  hideCard(host);
  const id = _hostUnit.get(host);
  if (id) clearActiveUnit(id);
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
    if (!isLastMeaningfulChild(n)) break;
    n = p;
  }
  const at = lastDecoratedSibling(n as ChildNode);
  return { at, clip: clippingBoxOf(at) };
}

/** The node a chip closes and — when that node is inside a box that clips its own text, or
 *  is about to — which box that is, so the layer settles the box's chips together. */
interface Placement {
  at: ChildNode;
  clip: ClipAnchor | null;
}

/** The box that hides text around this anchor, and what it measured while it was found. */
interface ClipAnchor {
  box: Element;
  /** The box is keeping text of its own out of sight right now, not merely capped. */
  clipping: boolean;
  /** This anchor's last line is below the box's visible band. */
  hidden: boolean;
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
 * So: the nearest ancestor that hides text of its own is found (at most CLIP_BOX_LEVELS
 * up), and that box then decides where its chips go — at most one of them after it, the
 * rest at their own anchors (see the ClipGroup above). A box that merely CAPS its own
 * height is found too, although it hides nothing yet: Goodreads' review boxes are not
 * clipping when the chips land, because the cover images and the web font arrive afterwards
 * and push the text past the cap, and a chip nobody is watching is a chip that stays out of
 * sight for good.
 *
 * The one thing the chip may not do is leave its POST, so the box has to lie inside the
 * post the anchor belongs to. Structure INSIDE the clipped text — a quotation, a list, a
 * spoiler span — is not a post boundary: stopping the climb at every `blockquote`/`li`
 * left the chips of quoted passages in Goodreads reviews inside the truncated box, out
 * of sight (measured: 2 of 150 chips on one book page).
 */
function clippingBoxOf(at: ChildNode): ClipAnchor | null {
  const start = at.nodeType === Node.ELEMENT_NODE ? (at as Element) : at.parentElement;
  if (!start) return null;
  let box: Element | null = null;
  let clipping = false;
  try {
    for (let el: Element | null = start, i = 0; el && i < CLIP_BOX_LEVELS; i++, el = el.parentElement) {
      const cs = getComputedStyle(el);
      const hides = hidesOwnText(el, cs);
      if (hides || capsOwnHeight(el, cs)) {
        box = el;
        clipping = hides;
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
  // Everything the layer needs to place THIS chip, measured in the one layout this function
  // has already forced: no caller has to ask the page about it a second time.
  return { box, clipping, hidden: anchor.top >= box.getBoundingClientRect().bottom - 1 };
}

/** Page-level boxes, the ones lib/dom/style.ts also refuses to call clipped: `body` under
 *  an open modal, an app's own scrolling region, a `<details>` that hides its content by
 *  other means. Hidden text in one of those is layout, never a post behind "see more". */
const NEVER_CLIPPED_TAGS = new Set(["HTML", "BODY", "MAIN", "DETAILS"]);
/** A box as tall as the screen is the page's own scrolling region, not a preview of a post. */
const CLIP_MAX_VIEWPORT_SHARE = 0.9;
/** Less hidden than this is a shadow, a descender or a sticky row — not a line of text. */
const CLIP_MIN_HIDDEN_PX = 32;

/**
 * Does this box keep text of its own below its bottom edge, where the reader cannot get at
 * it? That is the only question placement has to answer, and it is NOT the question
 * lib/dom/style.ts asks: `clipsOwnText` decides whether a box is a post behind "see more"
 * — worth scoring although only three lines show — and for that it insists on twice as much
 * content as box. A Steam review card 663 px tall holding 771 px of review fails that test
 * by a mile, and the 108 px it cuts off still held whole paragraphs and the chips that
 * close them: the session survey counted 25 such chips out of sight on one page. So this
 * rule asks only whether something is hidden, and leaves it to each chip's own last line
 * (settle) to decide whether that chip is one of the hidden things.
 */
function hidesOwnText(el: Element, cs: CSSStyleDeclaration): boolean {
  if (!canHideText(el, cs)) return false;
  return el.scrollHeight - el.clientHeight >= CLIP_MIN_HIDDEN_PX;
}

/**
 * A box that CAPS its own height and will hide whatever grows past the cap — it may not be
 * hiding anything yet. Only a DECLARED cap counts (`max-height`, a line clamp): plain
 * `overflow: hidden` sits on half the wrappers of a modern page, while `max-height` with
 * the text still short of it is exactly the Goodreads review whose images have not arrived.
 */
function capsOwnHeight(el: Element, cs: CSSStyleDeclaration): boolean {
  if (!canHideText(el, cs)) return false;
  return cs.maxHeight !== "none" || cs.getPropertyValue("-webkit-line-clamp") !== "none";
}

/** The guards both rules share: the box must cut its overflow off, and be a box inside the
 *  page rather than one of the page's own. */
function canHideText(el: Element, cs: CSSStyleDeclaration): boolean {
  const overflowY = cs.overflowY;
  if (overflowY !== "hidden" && overflowY !== "clip") return false;
  if (NEVER_CLIPPED_TAGS.has(el.nodeName) || el.getAttribute("role") === "main") return false;
  const viewport = typeof window !== "undefined" ? window.innerHeight : 0;
  return viewport === 0 || el.clientHeight < viewport * CLIP_MAX_VIEWPORT_SHARE;
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
function isLastMeaningfulChild(n: Node): boolean {
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
