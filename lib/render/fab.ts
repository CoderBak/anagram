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
import { MARK_ATTR } from "../types";
import { settings, setSiteOverride } from "../settings/settings";

export interface PanelEntry {
  id: string;
  pct: number;
  band: "human" | "mixed" | "ai" | "unknown";
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

.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.94);
  -webkit-backdrop-filter: saturate(1.4) blur(12px);
  backdrop-filter: saturate(1.4) blur(12px);
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.16), 0 1px 3px rgba(15, 23, 42, 0.08);
  font: 600 12px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #1f2328;
  cursor: pointer;
  user-select: none;
  transition: box-shadow 140ms ease, transform 140ms ease, opacity 140ms ease;
}
.chip:hover { transform: translateY(-1px); box-shadow: 0 10px 28px rgba(15, 23, 42, 0.20), 0 2px 4px rgba(15, 23, 42, 0.10); }
.chip:active { transform: translateY(0); }

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
  color: #3730a3;
  display: none;
}
.action.show { display: inline-flex; }

/* Brief attention pulse (Docs editor: the action chip is the useful control). */
@keyframes anagram-attn {
  0%, 100% { transform: scale(1); box-shadow: 0 6px 20px rgba(15, 23, 42, 0.16), 0 1px 3px rgba(15, 23, 42, 0.08); }
  50% { transform: scale(1.06); box-shadow: 0 8px 26px rgba(109, 94, 252, 0.45), 0 2px 5px rgba(15, 23, 42, 0.10); }
}
.action.attn { animation: anagram-attn 1.3s ease-in-out 3; }

.mark {
  width: 19px;
  height: 19px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: linear-gradient(135deg, #6d5efc, #b15efc);
  color: #fff;
  font-size: 11px;
  font-weight: 700;
}

.count {
  position: absolute;
  top: -5px;
  right: -5px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  box-sizing: border-box;
  border-radius: 9999px;
  background: #e5484d;
  color: #fff;
  font-size: 10px;
  font-weight: 700;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.25);
  cursor: pointer; /* opens the flagged-paragraphs panel */
}
.count:hover { filter: brightness(1.1); }
.count.zero { background: #1a7f37; }
.stack.anchor-left .count { right: auto; left: -5px; }

/* ---- flagged-paragraphs triage panel ----
   Absolutely positioned against the stack so it never shifts the ball, and
   edge-aware: opens ABOVE by default, flips below/right when the ball has been
   dragged near the top/left viewport edges. */
.panel {
  display: flex;
  visibility: hidden;
  opacity: 0;
  transform: translateY(5px);
  pointer-events: none;
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  flex-direction: column;
  width: 336px;
  max-height: 360px;
  box-sizing: border-box;
  padding: 6px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  border-radius: 13px;
  background: rgba(255, 255, 255, 0.98);
  -webkit-backdrop-filter: saturate(1.3) blur(14px);
  backdrop-filter: saturate(1.3) blur(14px);
  box-shadow: 0 12px 32px rgba(15, 23, 42, 0.18), 0 2px 6px rgba(15, 23, 42, 0.08);
  font: 400 12px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #1f2328;
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
.panel.below { bottom: auto; top: calc(100% + 8px); transform: translateY(-5px); }
.panel.below.open { transform: none; }
.panel.leftalign { right: auto; left: 0; }

.panel .phead {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  font-size: 11px;
  font-weight: 700;
  color: #656d76;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 7px 8px 5px;
}
.panel .pcopy {
  font: 600 10px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  text-transform: none;
  letter-spacing: 0;
  color: #3730a3;
  border: 1px solid rgba(109, 94, 252, 0.35);
  background: rgba(109, 94, 252, 0.07);
  border-radius: 999px;
  padding: 4px 9px;
  cursor: pointer;
}
.panel .pcopy:hover { background: rgba(109, 94, 252, 0.14); }
.panel .pcopy.done { color: #116a37; border-color: rgba(26, 127, 55, 0.4); background: rgba(26, 127, 55, 0.08); }

/* Verdict filter chips. */
.panel .pfilters { display: flex; gap: 5px; padding: 0 8px 6px; }
.panel .fchip {
  font: 600 10px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #57606a;
  border: 1px solid rgba(15, 23, 42, 0.12);
  background: none;
  border-radius: 999px;
  padding: 4px 9px;
  cursor: pointer;
}
.panel .fchip:hover { background: rgba(15, 23, 42, 0.04); }
.panel .fchip[aria-pressed="true"] { color: #3730a3; border-color: rgba(109, 94, 252, 0.5); background: rgba(109, 94, 252, 0.09); }

.panel .plist { overflow-y: auto; overscroll-behavior: contain; }
.panel .pitem {
  display: flex;
  align-items: baseline;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  cursor: pointer;
  text-align: left;
  border: none;
  background: none;
  font: inherit;
  color: inherit;
  width: 100%;
}
.panel .pitem:hover { background: rgba(109, 94, 252, 0.08); }
.panel .pdot { flex: 0 0 auto; width: 7px; height: 7px; border-radius: 50%; align-self: center; }
.panel .pitem.band-ai .pdot { background: #e5484d; }
.panel .pitem.band-mixed .pdot { background: #d99e00; }
.panel .ppct {
  flex: 0 0 auto;
  min-width: 38px;
  text-align: right;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  font-size: 11px;
}
.panel .pitem.band-ai .ppct { color: #b42318; }
.panel .pitem.band-mixed .ppct { color: #8a5a00; }
.panel .ptext {
  flex: 1 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #424a53;
}
.panel .pempty { padding: 10px 8px; color: #8b949e; }
.panel .pfoot {
  display: flex;
  justify-content: flex-end;
  padding: 5px 8px 3px;
  border-top: 1px solid rgba(15, 23, 42, 0.06);
  margin-top: 4px;
}
.panel .psiteoff {
  font: 500 10px/1.2 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #8b949e;
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

export function createFab(opts: { onToggle: () => void; panel?: PanelHooks }): Fab {
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
  let panelFilter: "all" | "ai" | "mixed" = "all";
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
    countEl.textContent = String(flagged);
    countEl.classList.toggle("zero", flagged === 0);
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
    const stackRect = panelEl.parentElement?.getBoundingClientRect();
    panelEl.classList.toggle("below", !!stackRect && stackRect.top < 420);
    panelEl.classList.toggle(
      "leftalign",
      !!stackRect && stackRect.right < 360 /* panel width + margin */,
    );
    panelEl.classList.add("open");
  }

  function renderPanel(): void {
    if (!panelEl) return;
    panelEl.textContent = "";
    const all = opts.panel?.entries() ?? [];
    const counts = {
      ai: all.filter((e) => e.band === "ai").length,
      mixed: all.filter((e) => e.band === "mixed").length,
    };
    const entries = panelFilter === "all" ? all : all.filter((e) => e.band === panelFilter);

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
    if (counts.ai > 0 && counts.mixed > 0) {
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
        mk("mixed", `Assisted ${counts.mixed}`),
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

  return { mount, setActive, setCount, setAction, unmount };
}
