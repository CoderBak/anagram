// lib/render/fab.ts — floating overlay toggle (edge-snapped ball), Shadow DOM.
//
// An always-present control (like Immersive Translate's floating ball) that
// shows/hides the detection overlay WITHOUT re-running detection, plus an
// optional secondary ACTION chip stacked above it (e.g. "Analyze document" on
// Google Docs). DRAGGABLE: grab the ball to move it; on release it SNAPS to the
// nearest screen edge and the position persists per host. After a few idle
// seconds the ball TUCKS half-off the edge (hover restores it) so it never
// competes with page content. Hidden entirely while the page is fullscreen
// (video). Where the Popover API exists, the host is promoted to the top layer
// so cookie walls and modal overlays cannot bury it. Its host carries
// MARK_ATTR="host" so the walker skips it, and id="anagram-fab" so tests can
// find/click it.
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { MARK_ATTR } from "../types";
import { settings, setSiteOverride } from "../settings/settings";
import type { Band } from "./band";

export interface PanelEntry {
  id: string;
  pct: number;
  band: Band;
  snippet: string;
  order: number;
}

export interface PanelHooks {
  /** Current flagged units, document order. Called each time the panel opens. */
  entries(): PanelEntry[];
  /** Scroll to a unit and flash its chip. */
  onJump(id: string): void;
  /** Markdown report of the page's verdicts (for the Copy report button). */
  buildReport(): string;
}

export interface Fab {
  mount(): void;
  /** Reflect whether the overlay is currently shown. */
  setActive(active: boolean): void;
  /** The scoring daemon stopped answering (counter shows "!", panel explains + Retry). */
  setBackendDown(down: boolean): void;
  /** Update the flagged-paragraph counter. */
  setCount(flagged: number, total: number): void;
  /** Show (label + callback) or hide (null) the secondary action chip. */
  setAction(label: string | null, onAction?: () => void, opts?: { attention?: boolean }): void;
  unmount(): void;
}

const BALL = 42; // ball diameter (px) — layout math + clamping use this
const TUCK_AFTER_MS = 3500;

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
.stack.tucked .fabwrap:hover { transform: none; opacity: 1; }
/* An open panel always presents a fully visible ball, whatever the tuck state. */
.stack:has(.panel.open) .fabwrap { transform: none; opacity: 1; }

.fab {
  height: ${BALL}px;
  min-width: ${BALL}px;
  padding: 0 11px;
  justify-content: center;
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
  margin-left: 2px;
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
   count and the daemon-down "!" stay neutral. */
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
  box-sizing: border-box;
  border-radius: 6px;
  border: 1px solid #ffffff;
  background: #dc2626;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
  cursor: pointer; /* opens the flagged-paragraphs panel */
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
/* Basecoat "primary" button: near-black surface, light text. */
.panel .pcopy {
  font: 500 10.5px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  text-transform: none;
  letter-spacing: 0;
  color: #fafafa;
  border: 1px solid transparent;
  background: #171717;
  border-radius: 6px;
  padding: 5px 9px;
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
  padding: 4px 9px;
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
.panel .pdot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; align-self: center; }
.panel .pitem.band-ai .pdot { background: #dc2626; }
.panel .pitem.band-heavy .pdot { background: #e8590c; }
.panel .pitem.band-light .pdot { background: #d4a017; }
.panel .ppct {
  flex: 0 0 auto;
  min-width: 38px;
  text-align: right;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}
.panel .pitem.band-ai .ppct { color: #b42318; }
.panel .pitem.band-heavy .ppct { color: #a13d00; }
.panel .pitem.band-light .ppct { color: #7a5b00; }
.panel .ptext {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #404040;
}
.panel .pempty { padding: 10px 8px; color: #8a8a8a; }
.panel .pfoot {
  display: flex;
  justify-content: flex-end;
  padding: 5px 8px 3px;
  border-top: 1px solid #f0f0f0;
  margin-top: 4px;
}
.panel .psiteoff {
  font: 500 10px/1.2 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #8a8a8a;
  border: none;
  background: none;
  cursor: pointer;
  padding: 3px 4px;
}
.panel .psiteoff:hover { color: #b42318; text-decoration: underline; }

/* inactive (overlay hidden) → muted */
.fab.off { opacity: 0.62; }
.fab.off .mark { filter: grayscale(0.5); }
.fab.off + .count, .fabwrap.off .count { opacity: 0.5; }

@media (prefers-reduced-motion: reduce) {
  .action.attn { animation: none; }
  .fabwrap, .panel, .stack.snapping { transition: none; }
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

export function createFab(opts: { onToggle: () => void; onRetry?: () => void; panel?: PanelHooks }): Fab {
  let host: HTMLElement | null = null;
  let stackEl: HTMLElement | null = null;
  let fabEl: HTMLButtonElement | null = null;
  let actionEl: HTMLButtonElement | null = null;
  let countEl: HTMLElement | null = null;
  let panelEl: HTMLElement | null = null;
  let active = true;
  let actionLabel: string | null = null;
  let actionCb: (() => void) | undefined;
  let actionAttention = false;
  let panelFilter: "all" | "ai" | "heavy" = "all";
  let backendDown = false;
  let side: Side = "right";
  let tuckTimer: ReturnType<typeof setTimeout> | null = null;

  function applyState(): void {
    if (!fabEl) return;
    fabEl.classList.toggle("off", !active);
    fabEl.parentElement?.classList.toggle("off", !active);
    fabEl.title = active ? "Hide AI detection" : "Show AI detection";
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
    host = null;
    host = document.createElement("div");
    host.setAttribute(MARK_ATTR, "host");
    host.id = "anagram-fab";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = [sheet()];

    const stack = document.createElement("div");
    stack.className = "stack side-right";
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

    countEl = document.createElement("span");
    countEl.className = "count zero";
    countEl.textContent = "0";
    countEl.title = "Show flagged paragraphs";
    countEl.addEventListener("click", (e) => {
      e.stopPropagation();
      togglePanel();
    });
    countEl.addEventListener("pointerdown", (e) => e.stopPropagation()); // no drag from bubble

    panelEl = document.createElement("div");
    panelEl.className = "panel";

    fabEl.append(mark, label);
    fabEl.addEventListener("click", () => {
      if (suppressNextClick) {
        suppressNextClick = false; // that click ended a drag, not a toggle
        return;
      }
      opts.onToggle();
    });
    makeDraggable(stack, fabEl);
    // Any pointer entering the stack untucks and re-arms the idle timer.
    stack.addEventListener("pointerenter", () => cancelTuck());
    stack.addEventListener("pointerleave", () => scheduleTuck());
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

    stack.append(panelEl, actionEl, wrap);
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
    setCount(lastFlagged, 0); // restore the counter across re-mounts
    onFullscreenChange();
    scheduleTuck();
  }

  function onOutsidePointer(e: Event): void {
    if (panelEl?.classList.contains("open") && host && !e.composedPath().includes(host)) {
      panelEl.classList.remove("open");
      scheduleTuck();
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Escape" && panelEl?.classList.contains("open")) {
      panelEl.classList.remove("open");
      scheduleTuck();
    }
  }

  function setActive(a: boolean): void {
    active = a;
    applyState();
  }

  function setCount(flagged: number, _total: number): void {
    lastFlagged = flagged;
    if (!countEl) return;
    countEl.classList.toggle("down", backendDown);
    if (backendDown) {
      countEl.textContent = "!";
      countEl.title = "Scoring daemon not running — click for details";
      return;
    }
    countEl.textContent = String(flagged);
    countEl.title = "Show flagged paragraphs";
    countEl.classList.toggle("zero", flagged === 0);
  }

  function setBackendDown(down: boolean): void {
    if (down === backendDown) return;
    backendDown = down;
    setCount(lastFlagged, 0);
    if (panelEl?.classList.contains("open")) renderPanel();
  }

  function togglePanel(): void {
    if (!panelEl) return;
    if (panelEl.classList.contains("open")) {
      panelEl.classList.remove("open");
      scheduleTuck();
      return;
    }
    cancelTuck();
    renderPanel();
    panelEl.classList.add("open");
    placePanel();
  }

  /** Floating UI: above the ball (aligned to the snapped side), flipped below or
   *  shifted when the ball has been dragged near a viewport edge. */
  function placePanel(): void {
    const panel = panelEl;
    const anchor = fabEl?.parentElement; // .fabwrap — the ball plus its counter bubble
    if (!panel || !anchor) return;
    void computePosition(anchor, panel, {
      placement: side === "left" ? "top-start" : "top-end",
      strategy: "absolute",
      middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
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
    const entries = panelFilter === "all" ? all : all.filter((e) => e.band === panelFilter);

    if (backendDown) {
      const notice = document.createElement("div");
      notice.className = "pnotice";
      const text = document.createElement("span");
      text.textContent = "Scoring daemon not running. Start it with npm run serve — new paragraphs wait until it answers.";
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "fchip";
      retry.textContent = "Retry";
      retry.addEventListener("click", (e) => {
        e.stopPropagation();
        opts.onRetry?.();
      });
      notice.append(text, retry);
      panelEl.appendChild(notice);
    }

    const head = document.createElement("div");
    head.className = "phead";
    const title = document.createElement("span");
    title.textContent = all.length ? `Flagged paragraphs (${all.length})` : "Flagged paragraphs";
    head.appendChild(title);
    if (opts.panel && all.length > 0) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "pcopy";
      copy.textContent = "Copy report";
      copy.addEventListener("click", (e) => {
        e.stopPropagation();
        const report = opts.panel!.buildReport();
        const done = () => {
          copy.textContent = "Copied ✓";
          copy.classList.add("done");
          setTimeout(() => {
            copy.textContent = "Copy report";
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
            document.execCommand("copy");
            done();
          } finally {
            ta.remove();
          }
        });
      });
      head.appendChild(copy);
    }
    panelEl.appendChild(head);

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
        mk("all", `All ${all.length}`),
        mk("ai", `AI ${counts.ai}`),
        mk("heavy", `Heavily edited ${counts.heavy}`),
      );
      panelEl.appendChild(filters);
    }

    const list = document.createElement("div");
    list.className = "plist";
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pempty";
      empty.textContent = "Nothing flagged on this page.";
      list.appendChild(empty);
    }
    for (const entry of entries) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `pitem band-${entry.band}`;
      const dot = document.createElement("span");
      dot.className = "pdot";
      const pct = document.createElement("span");
      pct.className = "ppct";
      pct.textContent = `${entry.pct}%`;
      const text = document.createElement("span");
      text.className = "ptext";
      text.textContent = entry.snippet;
      item.append(dot, pct, text);
      item.addEventListener("click", () => {
        panelEl?.classList.remove("open");
        scheduleTuck();
        opts.panel?.onJump(entry.id);
      });
      list.appendChild(item);
    }
    panelEl.appendChild(list);

    // Footer: per-site kill switch (writes the same rule the popup manages).
    const foot = document.createElement("div");
    foot.className = "pfoot";
    const off = document.createElement("button");
    off.type = "button";
    off.className = "psiteoff";
    off.textContent = `Turn off on ${location.hostname}`;
    off.title = "Adds a per-site rule — re-enable any time from the toolbar popup";
    off.addEventListener("click", (e) => {
      e.stopPropagation();
      panelEl?.classList.remove("open");
      void setSiteOverride(location.hostname, "off").catch(() => undefined);
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
  }

  return { mount, setActive, setBackendDown, setCount, setAction, unmount };
}
