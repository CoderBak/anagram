// lib/render/fab.ts — floating overlay toggle (edge-snapped ball), Shadow DOM.
//
// An always-present control (like Immersive Translate's floating ball) that
// shows/hides the detection overlay WITHOUT re-running detection, plus an
// optional secondary ACTION chip stacked above it (e.g. "Analyze document" on
// Google Docs). DRAGGABLE: grab the ball to move it; on release it SNAPS to the
// nearest screen edge and the position persists per host. After a few idle
// seconds the ball TUCKS half-off the edge (hover or focus restores it) so it never
// competes with page content. Hidden entirely while the page is fullscreen
// (video). Where the Popover API exists, the host is promoted to the top layer
// so cookie walls and modal overlays cannot bury it. Its host carries
// MARK_ATTR="host" so the walker skips it, and id="anagram-fab" so tests can
// find/click it.
//
// KEYBOARD. The per-paragraph chips stay aria-hidden and unfocusable on purpose
// (hundreds of tab stops, percentages read out mid-sentence), so this control IS
// the accessible route to the verdicts: every part of it is a labelled button, and
// the counter opens a role="dialog" panel that takes focus when a key opened it
// (Escape gives it back). A pointer click still leaves the page's focus alone.
import { computePosition, flip, offset, shift, size } from "@floating-ui/dom";
import { MARK_ATTR } from "../types";
import { settings, setSiteOverride } from "../settings/settings";
import { messageLocale, t, tn } from "../i18n";
import { bandLabel, type Band } from "./band";
import { formatScore, spokenScore } from "./score";
import { isDarkPage } from "./theme";
import { scaleColorCss } from "./scale";

export interface PanelEntry {
  id: string;
  /** The unit's own score, 0–1 — formatted here, never upstream. */
  score: number;
  band: Band;
  snippet: string;
  order: number;
}

/**
 * How much of the page was read, in numbers. "0 flagged" is the answer a reader most
 * often gets, and on its own it reads as "all clear" — when it can equally mean that
 * nothing on the page was long enough to judge, or that none of it was English.
 */
export interface PanelCounts {
  /** Units with a real verdict behind them. */
  read: number;
  /** Prose the walker found and left unread: under the 50-word evidence floor, with no
   *  neighbour of its own voice to join. Zero — and left off the line — in strict
   *  per-paragraph mode, where the walk never decides what a short run was. */
  short: number;
  /** Units the language gate refused — EditLens reads English only. */
  notEnglish: number;
  /** Units still waiting for the daemon. */
  pending: number;
  /** Units the daemon never answered for. */
  unavailable: number;
}

export interface PanelHooks {
  /** Current flagged units, document order. Called each time the panel opens. */
  entries(): PanelEntry[];
  /** The coverage line's numbers, read at the same moment. */
  counts(): PanelCounts;
  /** Scroll to a unit and flash its chip. */
  onJump(id: string): void;
  /** Markdown report of the page's verdicts (for the Copy report button). */
  buildReport(): string | Promise<string>;
  /** Explicit coverage limits for a virtualized document surface. */
  scopeNote?(): string;
}

export interface Fab {
  mount(): void;
  /** Reflect whether the overlay is currently shown. */
  setActive(active: boolean): void;
  /** The scoring daemon stopped answering (counter shows "!", panel explains + Retry). */
  setBackendDown(down: boolean): void;
  /** Update the flagged-paragraph counter. */
  setCount(flagged: number): void;
  /** Show (label + callback) or hide (null) the secondary action chip. */
  setAction(label: string | null, onAction?: () => void, opts?: { attention?: boolean }): void;
  /** Open the triage panel; with `focus`, move keyboard focus into it (the
   *  keyboard command hands the panel over, a pointer never does). */
  openPanel(focus?: boolean): void;
  unmount(): void;
}

const BALL = 42; // ball diameter (px) — layout math + clamping use this
const TUCK_AFTER_MS = 3500;
/** How long the flagged count has to hold still before it is worth saying out loud. */
const COUNT_ANNOUNCE_MS = 1500;
const PANEL_MAX_HEIGHT = 360; // matches .panel max-height; placePanel lowers it in short windows
const PANEL_MIN_HEIGHT = 140; // header + filter row + two entries
/** aria-controls / aria-labelledby targets, resolved inside our own shadow root. */
const PANEL_ID = "anagram-panel";
const PANEL_TITLE_ID = "anagram-panel-title";

const FAB_CSS = `
:host { all: initial; }

.stack {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483647;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 8px;
}
/* Anchored by LEFT when parked on the left edge: hover-expansion and the panel
   then grow rightward, staying on-screen. */
.stack.anchor-left { align-items: flex-start; }
.stack.snapping { transition: left 200ms ease, right 200ms ease, bottom 200ms ease; }
.stack.fs-hidden { display: none; }

/* Basecoat (Vega) surface: white, hairline border, one flat shadow, 8–10 px radius. */
.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  border: 1px solid #e5e5e5;
  border-radius: 10px;
  background: #ffffff;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
  font: 600 12px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #252525;
  cursor: pointer;
  user-select: none;
  transition: background-color 140ms ease, border-color 140ms ease, opacity 140ms ease;
}
.chip:hover { background: #f5f5f5; border-color: #d4d4d4; }
.chip:active { background: #ededed; }

/* Compact by default (a ${BALL}px ball, like Immersive Translate); the label
   slides out on hover. The count sits as a corner bubble so it reads at a glance. */
.fabwrap { position: relative; transition: transform 240ms ease, opacity 240ms ease; }

/* Idle tuck: slide half off the snapped edge; any hover/drag restores. */
.stack.tucked.side-right .fabwrap { transform: translateX(56%); opacity: 0.62; }
.stack.tucked.side-left  .fabwrap { transform: translateX(-56%); opacity: 0.62; }
/* A keyboard focus anywhere in the stack counts exactly like a hover: a tucked
   ball must never leave the control the reader is on hanging off the edge. */
.stack.tucked .fabwrap:hover,
.stack.tucked:focus-within .fabwrap { transform: none; opacity: 1; }
/* An open panel always presents a fully visible ball, whatever the tuck state. */
.stack:has(.panel.open) .fabwrap { transform: none; opacity: 1; }

.fab {
  height: ${BALL}px;
  min-width: ${BALL}px;
  padding: 0 10px; /* 20 px mark + 2×10 + 2×1 border = a ${BALL} px square */
  justify-content: center;
  /* No flex gap here: the collapsed label would still claim it and push the mark
     off-centre. The label brings its own margin when it slides out. */
  gap: 0;
  overflow: hidden;
  touch-action: none; /* pointer-drag must not turn into page scroll */
}

.label {
  white-space: nowrap;
  max-width: 0;
  opacity: 0;
  overflow: hidden;
  transition: max-width 180ms ease, opacity 140ms ease, margin-left 180ms ease;
  margin-left: 0;
}
.fab:hover .label {
  max-width: 120px;
  opacity: 1;
  margin-left: 8px;
}

.action {
  height: 30px;
  padding: 0 12px;
  font-size: 11px;
  border-radius: 8px;
  color: #252525;
  display: none;
}
.action.show { display: inline-flex; }

/* Brief attention pulse (Docs editor: the action chip is the useful control). */
@keyframes anagram-attn {
  0%, 100% { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08); }
  50% { box-shadow: 0 0 0 4px rgba(23, 23, 23, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08); }
}
.action.attn { animation: anagram-attn 1.3s ease-in-out 3; }

/* The mark: the primary token (near-black) — no gradient, no accent colour. */
.mark {
  width: 20px;
  height: 20px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: #171717;
  color: #fafafa;
  font-size: 11px;
  font-weight: 700;
}

/* Flagged counter: colour ONLY when something is flagged (destructive token); a zero
   count and the daemon-down "!" stay neutral. It is a real button (the panel behind it
   is the accessible route to the results), so the four declarations a <button> would
   otherwise bring from the UA sheet are pinned back to what the old <span> rendered. */
.count {
  position: absolute;
  top: -6px;
  right: -6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  margin: 0;
  box-sizing: border-box;
  border-radius: 6px;
  border: 1px solid #ffffff;
  background: #dc2626;
  color: #fff;
  appearance: none;
  font-family: inherit;
  font-size: 10px;
  font-weight: 700;
  line-height: normal;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  cursor: pointer; /* opens the flagged-paragraphs panel */
}
/* Hit area, not paint. WCAG 2.5.8 (target size, minimum) measures the region that
   ACCEPTS the pointer, so the bubble stays the 18 px badge it is drawn as and an
   invisible 24x24 box centred on it does the accepting. It sits above the ball in the
   paint order already, being the later positioned sibling, so the overlap resolves to
   the counter — which is what a reader aiming at the counter wants. */
.count::after {
  content: "";
  position: absolute;
  top: 50%;
  left: 50%;
  width: 24px;
  height: 24px;
  transform: translate(-50%, -50%);
}
.count:hover { filter: brightness(1.08); }
.count.zero { background: #737373; }
.count.down { background: #737373; }
.stack.anchor-left .count { right: auto; left: -5px; }

/* ---- flagged-paragraphs triage panel ----
   Absolutely positioned against the stack so it never shifts the ball; Floating UI
   places it (above the ball, flipped below / shifted when the ball sits near a
   viewport edge — fab.ts togglePanel). */
.panel {
  display: flex;
  visibility: hidden;
  opacity: 0;
  transform: translateY(5px);
  pointer-events: none;
  position: absolute;
  top: 0;
  left: 0;
  flex-direction: column;
  width: 336px;
  max-height: 360px;
  box-sizing: border-box;
  padding: 6px;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  background: #ffffff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
  font: 400 12px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #252525;
  cursor: default;
  transition: opacity 150ms ease, transform 150ms ease, visibility 0s linear 150ms;
}
.panel.open {
  visibility: visible;
  opacity: 1;
  transform: none;
  pointer-events: auto;
  transition-delay: 0s;
}
.panel.below { transform: translateY(-5px); }
.panel.below.open { transform: none; }

.panel .phead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  font-weight: 600;
  color: #737373;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 7px 8px 5px;
}
/* The dialog's own heading (and its accessible name). Kept typographically identical
   to the plain span it replaced — the row only gained semantics. */
.panel .phead h2 { font: inherit; margin: 0; }
/* Basecoat "primary" button: near-black surface, light text. */
.panel .pcopy {
  font: 500 10.5px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  text-transform: none;
  letter-spacing: 0;
  color: #fafafa;
  border: 1px solid transparent;
  background: #171717;
  border-radius: 6px;
  padding: 6px 9px; /* 6, not 5: 24 px tall — WCAG 2.5.8 target size, minimum */
  cursor: pointer;
}
.panel .pcopy:hover { background: #333333; }
.panel .pcopy.done { color: #116a37; border-color: rgba(26, 127, 55, 0.4); background: rgba(26, 127, 55, 0.08); }

/* Daemon-down notice at the top of the panel. */
.panel .pnotice {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 2px 2px 6px;
  padding: 8px 10px;
  border-radius: 6px;
  background: #f5f5f5;
  color: #525252;
  font-size: 11.5px;
  line-height: 1.4;
}
.panel .pnotice .fchip { flex: 0 0 auto; }

/* Verdict filter chips. */
.panel .pfilters { display: flex; gap: 5px; padding: 0 8px 6px; }
.panel .fchip {
  font: 500 10.5px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #525252;
  border: 1px solid #e5e5e5;
  background: #ffffff;
  border-radius: 6px;
  padding: 6px 9px; /* 6, not 4: 24 px tall — WCAG 2.5.8 target size, minimum */
  cursor: pointer;
}
.panel .fchip:hover { background: #f5f5f5; color: #252525; }
.panel .fchip[aria-pressed="true"] { color: #fafafa; border-color: transparent; background: #171717; }

.panel .plist { overflow-y: auto; overscroll-behavior: contain; }
.panel .pitem {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 6px;
  cursor: pointer;
  text-align: left;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  width: 100%;
}
.panel .pitem:hover { background: #f5f5f5; }
/* The row's score on the one scale (lib/render/scale.ts), read from --s on the row. */
.panel .pdot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; align-self: center; background: ${scaleColorCss(false)}; }
.panel .pscore {
  flex: 0 0 auto;
  min-width: 26px; /* ".93" and "1.0" — the widest row number there is */
  text-align: right;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}
.panel .ptext {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #404040;
}
.panel .pempty { padding: 10px 8px; color: #737373; }
/* How much of the page was read: numbers with one-word labels, under the title, in the
   same muted ink as the title itself. No sentence and no icon — it is there to keep
   "0 flagged" from reading as "all clear", not to explain itself. */
.panel .pcov {
  padding: 0 8px 6px;
  font-size: 11px;
  line-height: 1.45;
  color: #737373;
  font-variant-numeric: tabular-nums;
}
.panel .pfoot {
  display: flex;
  justify-content: flex-end;
  padding: 5px 8px 3px;
  border-top: 1px solid #f0f0f0;
  margin-top: 4px;
}
.panel .psiteoff {
  font: 500 10px/1.2 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #737373;
  border: none;
  background: none;
  cursor: pointer;
  padding: 6px 4px; /* 6, not 3: 24 px tall — WCAG 2.5.8 target size, minimum */
}
.panel .psiteoff:hover { color: #b42318; text-decoration: underline; }

/* inactive (overlay hidden) → muted */
.fab.off { opacity: 0.62; }
.fab.off .mark { filter: grayscale(0.5); }
.fab.off + .count, .fabwrap.off .count { opacity: 0.5; }

/* The only thing here that is not drawn: a polite live region. The counter changes
   silently as scoring lands, and the panel's Copy report confirms itself by swapping a
   label — both are invisible events to a screen reader, and neither is worth a word of
   visible chrome. Clipped rather than display:none, which would take it out of the
   accessibility tree along with the pixels. */
.live {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  border: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

/* ---- dark surfaces ---------------------------------------------------------------
   The chip's detail card has had a dark variant since v4; the panel had none, so on a
   dark page the one piece of chrome a keyboard reader lives in was a white rectangle.
   Same trigger as the card (the shared theme probe, isDarkPage), same surface, ink and
   border values as lib/render/badge.css.ts — no new hue, nothing rounder. The verdict
   dots keep their colours, exactly as the card's do. */
:host(.pg-dark) .panel {
  border-color: rgba(255, 255, 255, 0.10);
  background: #171717;
  color: #fafafa;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
  color-scheme: dark; /* the list scrolls — its scrollbar belongs to this surface */
}
:host(.pg-dark) .panel .phead { color: #a3a3a3; }
/* The primary button inverts, the way a primary button does in dark mode. */
:host(.pg-dark) .panel .pcopy { color: #171717; background: #fafafa; }
:host(.pg-dark) .panel .pcopy:hover { background: #e5e5e5; }
:host(.pg-dark) .panel .pcopy.done { color: #4ecb71; border-color: rgba(78, 203, 113, 0.4); background: rgba(78, 203, 113, 0.12); }
:host(.pg-dark) .panel .pnotice { background: rgba(255, 255, 255, 0.06); color: #d4d4d4; }
:host(.pg-dark) .panel .fchip { color: #a3a3a3; border-color: rgba(255, 255, 255, 0.15); background: rgba(255, 255, 255, 0.06); }
:host(.pg-dark) .panel .fchip:hover { background: rgba(255, 255, 255, 0.12); color: #fafafa; }
:host(.pg-dark) .panel .fchip[aria-pressed="true"] { color: #171717; border-color: transparent; background: #fafafa; }
:host(.pg-dark) .panel .pitem:hover { background: rgba(255, 255, 255, 0.08); }
:host(.pg-dark) .panel .pdot { background: ${scaleColorCss(true)}; }
:host(.pg-dark) .panel .ptext { color: #d4d4d4; }
:host(.pg-dark) .panel .pempty { color: #8a8a8a; }
:host(.pg-dark) .panel .pcov { color: #8a8a8a; }
:host(.pg-dark) .panel .pfoot { border-top-color: rgba(255, 255, 255, 0.08); }
:host(.pg-dark) .panel .psiteoff { color: #8a8a8a; }
:host(.pg-dark) .panel .psiteoff:hover { color: #ff7b81; }

/* ---- keyboard focus -------------------------------------------------------------
   One ring for every control here: the primary near-black token, two pixels, held off
   the surface so the counter's white hairline still reads. No glow, no accent colour —
   :focus-visible keeps it off the pointer path. */
.fab:focus-visible,
.action:focus-visible,
.count:focus-visible,
.panel .pcopy:focus-visible,
.panel .fchip:focus-visible,
.panel .pitem:focus-visible,
.panel .psiteoff:focus-visible,
.panel .phead h2:focus-visible {
  outline: 2px solid #171717;
  outline-offset: 2px;
}
/* The list scrolls inside the panel: an offset ring on the first/last row would be
   clipped by it, so those sit on the row itself. */
.panel .pitem:focus-visible { outline-offset: -2px; }

/* A near-black ring is invisible on a near-black panel. */
:host(.pg-dark) .panel .pcopy:focus-visible,
:host(.pg-dark) .panel .fchip:focus-visible,
:host(.pg-dark) .panel .pitem:focus-visible,
:host(.pg-dark) .panel .psiteoff:focus-visible,
:host(.pg-dark) .panel .phead h2:focus-visible {
  outline-color: #fafafa;
}

/* Forced colours override our palette wholesale; name the system focus colour so the
   ring survives the substitution instead of landing on a forced border colour. */
@media (forced-colors: active) {
  .fab:focus-visible,
  .action:focus-visible,
  .count:focus-visible,
  .panel .pcopy:focus-visible,
  .panel .fchip:focus-visible,
  .panel .pitem:focus-visible,
  .panel .psiteoff:focus-visible,
  .panel .phead h2:focus-visible {
    outline-color: Highlight;
  }
}

@media (prefers-reduced-motion: reduce) {
  .action.attn { animation: none; }
  /* .chip and .label were left out: the ball's hover colour fade and the label sliding
     out of the edge of the screen are small, but they are motion, and a reader who asked
     for less of it asked for all of it. */
  .chip, .label, .fabwrap, .panel, .stack.snapping { transition: none; }
}
@media print { .stack { display: none !important; } }
`;

let _sheet: CSSStyleSheet | null = null;
function sheet(): CSSStyleSheet {
  if (!_sheet) {
    _sheet = new CSSStyleSheet();
    _sheet.replaceSync(FAB_CSS);
  }
  return _sheet;
}

type Side = "left" | "right";

export function createFab(opts: {
  onToggle: () => void;
  onRetry?: () => void;
  panel?: PanelHooks;
  /** The footer's per-site kill switch was used. The rule is written here either way;
   *  this is how the PAGE learns to stop, which the stored rule cannot always tell it:
   *  a site whose rule already says "off" — the page is being analyzed once from the
   *  context menu — takes the same value again, and storage fires no change event. */
  onSiteOff?: () => void;
}): Fab {
  let host: HTMLElement | null = null;
  let stackEl: HTMLElement | null = null;
  let fabEl: HTMLButtonElement | null = null;
  let actionEl: HTMLButtonElement | null = null;
  let countEl: HTMLButtonElement | null = null;
  let panelEl: HTMLElement | null = null;
  let active = true;
  let actionLabel: string | null = null;
  let actionCb: (() => void) | undefined;
  let actionAttention = false;
  let panelFilter: "all" | "ai" | "heavy" = "all";
  let backendDown = false;
  let side: Side = "right";
  let tuckTimer: ReturnType<typeof setTimeout> | null = null;
  let liveEl: HTMLElement | null = null;
  let liveTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last count actually said out loud, so a re-render never repeats itself. */
  let announcedCount = -1;

  /** Say something once, politely. Empty first so an identical message is still new. */
  function announce(text: string): void {
    if (!liveEl) return;
    liveEl.textContent = "";
    const el = liveEl;
    setTimeout(() => {
      if (el.isConnected) el.textContent = text;
    }, 60);
  }

  /**
   * A page settles on its flagged count over several seconds, one batch at a time. Saying
   * each increment would be a stream of interruptions, so the announcement waits until the
   * number has stopped moving, and only then, and only if it moved somewhere worth
   * mentioning. A zero, and the daemon-down "!", stay silent: nothing was found.
   */
  function announceCount(flagged: number): void {
    if (liveTimer !== null) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      liveTimer = null;
      if (backendDown || flagged <= 0 || flagged === announcedCount) return;
      announcedCount = flagged;
      announce(tn("panelAnnounceCount", flagged));
    }, COUNT_ANNOUNCE_MS);
  }

  function applyState(): void {
    if (!fabEl) return;
    fabEl.classList.toggle("off", !active);
    fabEl.parentElement?.classList.toggle("off", !active);
    fabEl.title = active ? t("fabHide") : t("fabShow");
    // The ball's own content is a one-letter mark: without a label it announces as "A".
    fabEl.setAttribute("aria-label", active ? t("fabHideAria") : t("fabShowAria"));
    if (actionEl) {
      actionEl.classList.toggle("show", actionLabel !== null);
      actionEl.classList.toggle("attn", actionLabel !== null && actionAttention);
      actionEl.textContent = actionLabel ?? "";
    }
    // The action chip is the page's primary control where present (Docs) — never
    // tuck it away.
    if (actionLabel !== null) cancelTuck();
    else scheduleTuck();
  }

  // ---- idle tuck ------------------------------------------------------------------

  function scheduleTuck(): void {
    cancelTuckTimer();
    if (actionLabel !== null) return;
    tuckTimer = setTimeout(() => {
      if (panelEl?.classList.contains("open")) return; // panel in use — stay out
      stackEl?.classList.add("tucked");
    }, TUCK_AFTER_MS);
  }

  function cancelTuckTimer(): void {
    if (tuckTimer !== null) {
      clearTimeout(tuckTimer);
      tuckTimer = null;
    }
  }

  /** Untuck immediately (interaction) and re-arm the idle timer. */
  function cancelTuck(rearm = false): void {
    cancelTuckTimer();
    stackEl?.classList.remove("tucked");
    if (rearm) scheduleTuck();
  }

  // ---- positioning ----------------------------------------------------------------

  function clampB(b: number): number {
    const vh = window.innerHeight || 800;
    return Math.min(Math.max(6, b), Math.max(6, vh - BALL - 12));
  }

  /** Park the stack against `s` at bottom-offset `b` and remember the side. */
  function applySide(stack: HTMLElement, s: Side, b: number): void {
    side = s;
    stack.style.bottom = `${clampB(b)}px`;
    if (s === "left") {
      stack.style.left = "12px";
      stack.style.right = "auto";
    } else {
      stack.style.right = "12px";
      stack.style.left = "auto";
    }
    stack.classList.toggle("anchor-left", s === "left");
    stack.classList.toggle("side-left", s === "left");
    stack.classList.toggle("side-right", s === "right");
  }

  /** Free position during a drag (no snapping until release). */
  function applyFreePos(stack: HTMLElement, r: number, b: number): void {
    const vw = window.innerWidth || 1280;
    stack.style.bottom = `${clampB(b)}px`;
    const leftEdge = vw - r - BALL;
    if (leftEdge < vw / 2) {
      stack.style.left = `${Math.max(6, leftEdge)}px`;
      stack.style.right = "auto";
      stack.classList.add("anchor-left");
    } else {
      stack.style.right = `${Math.max(6, r)}px`;
      stack.style.left = "auto";
      stack.classList.remove("anchor-left");
    }
  }

  /** Restore a persisted position; legacy {r,b} entries derive their side from r. */
  function restorePos(stack: HTMLElement, pos: { r: number; b: number; side?: Side }): void {
    const vw = window.innerWidth || 1280;
    const s: Side = pos.side ?? (vw - pos.r - BALL < vw / 2 ? "left" : "right");
    applySide(stack, s, pos.b);
  }

  /** Snap to the nearest edge after a drag and persist {side, b}. */
  function snapAndPersist(stack: HTMLElement): void {
    const rect = stack.getBoundingClientRect();
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    const ballCenterX = rect.left + (stack.classList.contains("anchor-left") ? BALL / 2 : rect.width - BALL / 2);
    const s: Side = ballCenterX < vw / 2 ? "left" : "right";
    const b = clampB(vh - rect.bottom);
    stack.classList.add("snapping");
    applySide(stack, s, b);
    setTimeout(() => stack.classList.remove("snapping"), 240);
    void settings.fabPos
      .getValue()
      .then((all) =>
        settings.fabPos.setValue({ ...all, [location.hostname]: { r: 12, b, side: s } }),
      )
      .catch(() => undefined); // storage gone (context invalidated) — position just won't stick
  }

  /** Grab-to-move with a small threshold so plain clicks still toggle. */
  function makeDraggable(stack: HTMLElement, ball: HTMLButtonElement): void {
    let startX = 0;
    let startY = 0;
    let startR = 18;
    let startB = 18;
    let dragging = false;

    ball.addEventListener("pointerdown", (e) => {
      if (e.button !== 0 && e.pointerType === "mouse") return;
      cancelTuck();
      startX = e.clientX;
      startY = e.clientY;
      const rect = stack.getBoundingClientRect();
      const vw = window.innerWidth || 1280;
      const vh = window.innerHeight || 800;
      startR = vw - rect.right;
      startB = vh - rect.bottom;
      dragging = false;
      ball.setPointerCapture(e.pointerId);
    });
    ball.addEventListener("pointermove", (e) => {
      if (!ball.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < 5) return;
      dragging = true;
      applyFreePos(stack, startR - dx, startB - dy);
    });
    ball.addEventListener("pointerup", (e) => {
      if (!ball.hasPointerCapture(e.pointerId)) return;
      ball.releasePointerCapture(e.pointerId);
      scheduleTuck();
      if (!dragging) return;
      dragging = false;
      suppressNextClick = true;
      snapAndPersist(stack);
    });
  }

  let suppressNextClick = false;
  let lastFlagged = 0;

  function onFullscreenChange(): void {
    stackEl?.classList.toggle("fs-hidden", !!document.fullscreenElement);
  }

  function mount(): void {
    // Re-mount if the page wiped our host (SPA body replacement) — a stale
    // non-null reference would otherwise hide the toggle forever.
    if (host?.isConnected) return;
    host?.remove();
    host = document.createElement("div");
    host.setAttribute(MARK_ATTR, "host");
    host.id = "anagram-fab";
    // Same signal the chips and the selection card use — one theme probe, not two.
    host.classList.toggle("pg-dark", isDarkPage());
    const shadow = host.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = [sheet()];

    const stack = document.createElement("div");
    stack.className = "stack side-right";
    // Our chrome is in the UI's language whatever the page around it is in — said on the
    // element so screen readers and the CJK font fallback both get it right.
    stack.lang = messageLocale();
    stackEl = stack;

    actionEl = document.createElement("button");
    actionEl.className = "chip action";
    actionEl.type = "button";
    actionEl.id = "anagram-action";
    actionEl.addEventListener("click", () => actionCb?.());

    fabEl = document.createElement("button");
    fabEl.className = "chip fab";
    fabEl.type = "button";

    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = "A";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "Anagram";

    // A real button: the per-paragraph chips are deliberately not focusable, so this
    // bubble is the ONLY way to the results without a pointer.
    countEl = document.createElement("button");
    countEl.className = "count zero";
    countEl.type = "button";
    countEl.textContent = "0";
    countEl.title = t("countTitle");
    countEl.setAttribute("aria-expanded", "false");
    countEl.setAttribute("aria-controls", PANEL_ID);
    countEl.addEventListener("click", (e) => {
      e.stopPropagation();
      // detail 0 = no pointer behind this click (Enter/Space on the button). That is
      // the one activation that hands the panel the focus.
      togglePanel(e.detail === 0);
    });
    countEl.addEventListener("pointerdown", (e) => e.stopPropagation()); // no drag from bubble
    // A button pulls focus off the page when clicked; a span never did. Keep it that way.
    countEl.addEventListener("mousedown", (e) => e.preventDefault());

    liveEl = document.createElement("span");
    liveEl.className = "live";
    liveEl.setAttribute("role", "status");
    liveEl.setAttribute("aria-live", "polite");

    panelEl = document.createElement("div");
    panelEl.className = "panel";
    panelEl.id = PANEL_ID;
    panelEl.setAttribute("role", "dialog"); // non-modal: the page behind stays usable
    panelEl.setAttribute("aria-labelledby", PANEL_TITLE_ID);

    fabEl.append(mark, label);
    fabEl.addEventListener("click", () => {
      if (suppressNextClick) {
        suppressNextClick = false; // that click ended a drag, not a toggle
        return;
      }
      opts.onToggle();
    });
    makeDraggable(stack, fabEl);
    // Any pointer entering the stack untucks and re-arms the idle timer; keyboard focus
    // does the same, so a tucked ball never hides the control the reader is standing on.
    stack.addEventListener("pointerenter", () => cancelTuck());
    stack.addEventListener("pointerleave", () => scheduleTuck());
    stack.addEventListener("focusin", () => cancelTuck());
    stack.addEventListener("focusout", () => scheduleTuck());
    // Restore the saved per-host position (clamped to the current viewport).
    void settings.fabPos
      .getValue()
      .then((all) => {
        const pos = all[location.hostname];
        if (pos && host) restorePos(stack, pos);
      })
      .catch(() => undefined);

    const wrap = document.createElement("div");
    wrap.className = "fabwrap";
    wrap.append(fabEl, countEl); // count is a corner bubble over the ball

    // The panel is absolutely positioned, so its place among the stack's children costs
    // no layout — and last is where Tab wants it: ball, counter, then what the counter
    // opened.
    stack.append(actionEl, wrap, panelEl, liveEl);
    // Tapping anywhere outside the FAB closes the panel; Escape too.
    document.addEventListener("pointerdown", onOutsidePointer, true);
    document.addEventListener("keydown", onKeydown, true);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    shadow.appendChild(stack);
    (document.body ?? document.documentElement).appendChild(host);

    // Top-layer promotion: a manual popover renders above every page z-index AND
    // above later modal dialogs/popovers the page opens. The UA popover styles
    // (fixed inset margins, border, background) are neutralized inline so the
    // shadow stack keeps doing the actual positioning.
    try {
      if ("showPopover" in host) {
        host.setAttribute("popover", "manual");
        host.style.cssText =
          "position:fixed;inset:auto;margin:0;border:none;padding:0;background:transparent;" +
          "width:auto;height:auto;overflow:visible;color-scheme:light";
        (host as HTMLElement & { showPopover(): void }).showPopover();
      }
    } catch {
      host.removeAttribute("popover"); // stay a normal fixed element
    }

    applyState();
    setCount(lastFlagged); // restore the counter across re-mounts
    onFullscreenChange();
    scheduleTuck();
  }

  function onOutsidePointer(e: Event): void {
    if (host && !e.composedPath().includes(host)) closePanel();
  }

  function onKeydown(e: KeyboardEvent): void {
    // Escape belongs to the panel wherever focus sits — including inside the page,
    // which is where a pointer-opened panel leaves it.
    if (e.key === "Escape") closePanel(true);
  }

  function setActive(a: boolean): void {
    active = a;
    applyState();
  }

  function setCount(flagged: number): void {
    lastFlagged = flagged;
    if (!countEl) return;
    countEl.classList.toggle("down", backendDown);
    if (backendDown) {
      countEl.textContent = "!";
      countEl.title = t("countDownTitle");
      countEl.setAttribute("aria-label", t("countDownAria"));
      return;
    }
    countEl.textContent = String(flagged);
    announceCount(flagged);
    countEl.title = t("countTitle");
    countEl.setAttribute("aria-label", tn("countAria", flagged));
    countEl.classList.toggle("zero", flagged === 0);
  }

  function setBackendDown(down: boolean): void {
    if (down === backendDown) return;
    backendDown = down;
    setCount(lastFlagged);
    if (panelEl?.classList.contains("open")) renderPanel();
  }

  function togglePanel(focus = false): void {
    if (panelEl?.classList.contains("open")) closePanel(focus);
    else openPanel(focus);
  }

  function openPanel(focus = false): void {
    if (!panelEl || !host?.isConnected) return;
    // Re-read the page's theme: a site's own dark-mode switch can have been thrown since
    // the ball mounted, and the panel is the part that would be wrong about it.
    host.classList.toggle("pg-dark", isDarkPage());
    cancelTuck();
    renderPanel();
    panelEl.classList.add("open");
    countEl?.setAttribute("aria-expanded", "true");
    placePanel();
    // Focus goes to the first result, or to the heading when there is none to give —
    // never to the page scroller, hence preventScroll.
    if (focus) {
      const target =
        panelEl.querySelector<HTMLElement>(".pitem") ??
        panelEl.querySelector<HTMLElement>(".phead h2");
      target?.focus({ preventScroll: true });
    }
  }

  /** `restoreFocus` hands focus back to the counter — but only if it is ours to hand
   *  back: a panel opened by pointer never took it off the page in the first place. */
  function closePanel(restoreFocus = false): void {
    if (!panelEl?.classList.contains("open")) return;
    panelEl.classList.remove("open");
    countEl?.setAttribute("aria-expanded", "false");
    if (restoreFocus && host?.shadowRoot?.activeElement) countEl?.focus({ preventScroll: true });
    scheduleTuck();
  }

  /** Floating UI: above the ball (aligned to the snapped side), flipped below or
   *  shifted when the ball has been dragged near a viewport edge. In a short window the
   *  panel takes the height there is (its list scrolls) instead of running off the top. */
  function placePanel(): void {
    const panel = panelEl;
    const anchor = fabEl?.parentElement; // .fabwrap — the ball plus its counter bubble
    if (!panel || !anchor) return;
    void computePosition(anchor, panel, {
      placement: side === "left" ? "top-start" : "top-end",
      strategy: "absolute",
      middleware: [
        // 12, not 8: the counter bubble overhangs the ball by 6 px and carries a 24x24
        // hit area of its own, so an 8 px gap left the panel lying over the top of the
        // one control that opens it.
        offset(12),
        flip({ padding: 8 }),
        shift({ padding: 8 }),
        size({
          padding: 8,
          apply({ availableHeight }) {
            panel.style.maxHeight = `${Math.max(PANEL_MIN_HEIGHT, Math.min(PANEL_MAX_HEIGHT, Math.floor(availableHeight)))}px`;
          },
        }),
      ],
    }).then(({ x, y, placement }) => {
      panel.style.left = `${x}px`;
      panel.style.top = `${y}px`;
      panel.classList.toggle("below", placement.startsWith("bottom"));
    });
  }

  function renderPanel(): void {
    if (!panelEl) return;
    panelEl.textContent = "";
    const all = opts.panel?.entries() ?? [];
    const counts = {
      ai: all.filter((e) => e.band === "ai").length,
      heavy: all.filter((e) => e.band === "heavy").length,
    };
    // The filter chips are only drawn when both bands are present (below). Without them a
    // filter picked earlier could never be undone, so the list goes back to everything.
    if (!(counts.ai > 0 && counts.heavy > 0)) panelFilter = "all";
    const entries = panelFilter === "all" ? all : all.filter((e) => e.band === panelFilter);

    if (backendDown) {
      const notice = document.createElement("div");
      notice.className = "pnotice";
      const text = document.createElement("span");
      text.textContent = t("panelDaemonDown");
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "fchip";
      retry.textContent = t("panelRetry");
      retry.addEventListener("click", (e) => {
        e.stopPropagation();
        opts.onRetry?.();
      });
      notice.append(text, retry);
      panelEl.appendChild(notice);
    }

    const head = document.createElement("div");
    head.className = "phead";
    const title = document.createElement("h2");
    title.id = PANEL_TITLE_ID; // the dialog's accessible name
    title.tabIndex = -1; // where keyboard focus lands when there is no result to land on
    title.textContent = all.length ? t("panelTitleCount", all.length) : t("panelTitle");
    head.appendChild(title);
    if (opts.panel && all.length > 0) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "pcopy";
      copy.textContent = t("panelCopyReport");
      copy.addEventListener("click", async (e) => {
        e.stopPropagation();
        copy.disabled = true;
        let report: string;
        try { report = await opts.panel!.buildReport(); }
        catch { copy.disabled = false; announce(t("reportCopyFailed")); return; }
        const done = () => {
          copy.textContent = t("copied");
          copy.classList.add("done");
          announce(t("panelAnnounceCopied"));
          setTimeout(() => {
            copy.textContent = t("panelCopyReport");
            copy.classList.remove("done");
          }, 1600);
        };
        navigator.clipboard.writeText(report).then(done, () => {
          // Clipboard API can be blocked — textarea/execCommand fallback.
          const ta = document.createElement("textarea");
          ta.value = report;
          ta.style.cssText = "position:fixed;opacity:0";
          document.body.appendChild(ta);
          ta.select();
          try {
            if (document.execCommand("copy")) done();
            else announce(t("reportCopyFailed"));
          } finally {
            ta.remove();
          }
        }).finally(() => { copy.disabled = false; });
      });
      head.appendChild(copy);
    }
    panelEl.appendChild(head);

    // The coverage line. It is drawn, never announced: the live region below belongs to
    // the flagged count and to the Copy button, and a reader who asked for one number
    // does not want five of them read out again every time a batch lands.
    const coverage = opts.panel?.counts();
    if (coverage) {
      const parts = [
        t("panelCovRead", coverage.read),
        ...(coverage.short > 0 ? [t("panelCovShort", coverage.short)] : []),
        ...(coverage.notEnglish > 0 ? [t("panelCovNotEnglish", coverage.notEnglish)] : []),
        ...(coverage.pending > 0 ? [t("panelCovPending", coverage.pending)] : []),
        ...(coverage.unavailable > 0 ? [t("panelCovUnavailable", coverage.unavailable)] : []),
      ];
      const cov = document.createElement("div");
      cov.className = "pcov";
      cov.textContent = parts.join(" · ");
      panelEl.appendChild(cov);
    }

    const scopeNote = opts.panel?.scopeNote?.();
    if (scopeNote) {
      const scope = document.createElement("div");
      scope.className = "pcov pscope";
      scope.textContent = scopeNote;
      panelEl.appendChild(scope);
    }

    // Verdict filters — only when both bands are present (a one-band page needs
    // no chrome for it).
    if (counts.ai > 0 && counts.heavy > 0) {
      const filters = document.createElement("div");
      filters.className = "pfilters";
      const mk = (key: typeof panelFilter, text: string): HTMLButtonElement => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "fchip";
        b.textContent = text;
        b.setAttribute("aria-pressed", String(panelFilter === key));
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          panelFilter = key;
          renderPanel();
        });
        return b;
      };
      filters.append(
        mk("all", t("panelFilterAll", all.length)),
        mk("ai", t("panelFilterAi", counts.ai)),
        mk("heavy", t("panelFilterHeavy", counts.heavy)),
      );
      panelEl.appendChild(filters);
    }

    const list = document.createElement("div");
    list.className = "plist";
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pempty";
      empty.textContent = t("panelEmpty");
      list.appendChild(empty);
    }
    for (const entry of entries) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `pitem band-${entry.band}`;
      item.style.setProperty("--s", entry.score.toFixed(3));
      const dot = document.createElement("span");
      dot.className = "pdot";
      const score = document.createElement("span");
      score.className = "pscore";
      score.textContent = formatScore(entry.score);
      const text = document.createElement("span");
      text.className = "ptext";
      text.textContent = entry.snippet;
      // Read out as a verdict, not as a loose number next to a sentence fragment: the
      // dot and the colour that carry the band visually say nothing out loud.
      // ".93" is read out badly — an aria-label says the number with its leading zero.
      item.setAttribute("aria-label", t("panelItemAria", bandLabel(entry.band), spokenScore(entry.score), entry.snippet));
      item.append(dot, score, text);
      item.addEventListener("click", () => {
        closePanel();
        opts.panel?.onJump(entry.id);
      });
      list.appendChild(item);
    }
    panelEl.appendChild(list);

    // Footer: per-site kill switch (writes the same rule the popup manages). On our own
    // extension pages — the PDF reader — the "site" is an extension id nobody recognises,
    // so the row names the page instead of printing it.
    const ownPage = location.protocol === "chrome-extension:" || location.protocol === "moz-extension:";
    const foot = document.createElement("div");
    foot.className = "pfoot";
    const off = document.createElement("button");
    off.type = "button";
    off.className = "psiteoff";
    off.textContent = ownPage ? t("panelTurnOffHere") : t("panelTurnOffOn", location.hostname);
    off.title = t("panelTurnOffTitle");
    off.addEventListener("click", (e) => {
      e.stopPropagation();
      closePanel();
      void setSiteOverride(location.hostname, "off").catch(() => undefined);
      opts.onSiteOff?.();
    });
    foot.appendChild(off);
    panelEl.appendChild(foot);
  }

  function setAction(
    label: string | null,
    onAction?: () => void,
    actionOpts?: { attention?: boolean },
  ): void {
    actionLabel = label;
    actionCb = onAction;
    actionAttention = actionOpts?.attention ?? false;
    applyState();
  }

  function unmount(): void {
    cancelTuckTimer();
    if (liveTimer !== null) {
      clearTimeout(liveTimer);
      liveTimer = null;
    }
    document.removeEventListener("pointerdown", onOutsidePointer, true);
    document.removeEventListener("keydown", onKeydown, true);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
    try {
      (host as (HTMLElement & { hidePopover(): void }) | null)?.hidePopover?.();
    } catch {
      /* already hidden or not a popover */
    }
    host?.remove();
    host = null;
    stackEl = null;
    fabEl = null;
    actionEl = null;
    countEl = null;
    panelEl = null;
    liveEl = null;
  }

  return { mount, setActive, setBackendDown, setCount, setAction, openPanel, unmount };
}
