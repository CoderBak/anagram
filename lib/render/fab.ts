// lib/render/fab.ts — floating overlay toggle (bottom-right), Shadow DOM.
//
// An always-present control (like Immersive Translate's floating ball) that
// shows/hides the detection overlay WITHOUT re-running detection, plus an
// optional secondary ACTION chip stacked above it (e.g. "Reading view" on Google
// Docs). DRAGGABLE: grab the ball to move it out of the way of site UI (chat
// widgets); the position persists per host. Its host carries MARK_ATTR="host"
// so the walker skips it, and id="pangram-fab" so tests can find/click it.
import { MARK_ATTR } from "../types";
import { settings } from "../settings/settings";

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

.chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  box-sizing: border-box;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.92);
  -webkit-backdrop-filter: saturate(1.4) blur(12px);
  backdrop-filter: saturate(1.4) blur(12px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16), 0 1px 3px rgba(0, 0, 0, 0.08);
  font: 600 12px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #1f2328;
  cursor: pointer;
  user-select: none;
  transition: box-shadow 140ms ease, transform 140ms ease, opacity 140ms ease;
}
.chip:hover { transform: translateY(-1px); box-shadow: 0 10px 28px rgba(0, 0, 0, 0.20), 0 2px 4px rgba(0, 0, 0, 0.10); }
.chip:active { transform: translateY(0); }

/* Compact by default (a 40px ball, like Immersive Translate); the label slides
   out on hover. The count sits as a corner bubble so it reads at a glance. */
.fabwrap { position: relative; }

.fab {
  height: 40px;
  min-width: 40px;
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
@keyframes pangram-attn {
  0%, 100% { transform: scale(1); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16), 0 1px 3px rgba(0, 0, 0, 0.08); }
  50% { transform: scale(1.06); box-shadow: 0 8px 26px rgba(109, 94, 252, 0.45), 0 2px 5px rgba(0, 0, 0, 0.10); }
}
.action.attn { animation: pangram-attn 1.3s ease-in-out 3; }
@media (prefers-reduced-motion: reduce) { .action.attn { animation: none; } }

.mark {
  width: 18px;
  height: 18px;
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

/* ---- flagged-paragraphs triage panel ---- */
.panel {
  display: none;
  flex-direction: column;
  width: 320px;
  max-height: 340px;
  overflow-y: auto;
  box-sizing: border-box;
  padding: 6px;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 12px;
  background: rgba(255, 255, 255, 0.97);
  -webkit-backdrop-filter: saturate(1.3) blur(14px);
  backdrop-filter: saturate(1.3) blur(14px);
  box-shadow: 0 10px 32px rgba(0, 0, 0, 0.18), 0 2px 6px rgba(0, 0, 0, 0.08);
  font: 400 12px/1.45 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #1f2328;
  cursor: default;
}
.panel.open { display: flex; }
.panel .phead {
  font-size: 11px;
  font-weight: 700;
  color: #656d76;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 6px 8px 4px;
}
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
.panel .ppct {
  flex: 0 0 auto;
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

/* inactive (overlay hidden) → muted */
.fab.off { opacity: 0.62; }
.fab.off .mark { filter: grayscale(0.5); }
.fab.off + .count, .fabwrap.off .count { opacity: 0.5; }

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

export function createFab(opts: { onToggle: () => void; panel?: PanelHooks }): Fab {
  let host: HTMLElement | null = null;
  let fabEl: HTMLButtonElement | null = null;
  let actionEl: HTMLButtonElement | null = null;
  let countEl: HTMLElement | null = null;
  let panelEl: HTMLElement | null = null;
  let active = true;
  let actionLabel: string | null = null;
  let actionCb: (() => void) | undefined;
  let actionAttention = false;

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
  }

  function clampPos(r: number, b: number): { r: number; b: number } {
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    return {
      r: Math.min(Math.max(6, r), Math.max(6, vw - 52)),
      b: Math.min(Math.max(6, b), Math.max(6, vh - 52)),
    };
  }

  function applyPos(stack: HTMLElement, r: number, b: number): void {
    const c = clampPos(r, b);
    stack.style.right = `${c.r}px`;
    stack.style.bottom = `${c.b}px`;
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
      startX = e.clientX;
      startY = e.clientY;
      const cs = getComputedStyle(stack);
      startR = parseFloat(cs.right) || 18;
      startB = parseFloat(cs.bottom) || 18;
      dragging = false;
      ball.setPointerCapture(e.pointerId);
    });
    ball.addEventListener("pointermove", (e) => {
      if (!ball.hasPointerCapture(e.pointerId)) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!dragging && Math.hypot(dx, dy) < 5) return;
      dragging = true;
      applyPos(stack, startR - dx, startB - dy);
    });
    ball.addEventListener("pointerup", (e) => {
      if (!ball.hasPointerCapture(e.pointerId)) return;
      ball.releasePointerCapture(e.pointerId);
      if (!dragging) return;
      dragging = false;
      suppressNextClick = true;
      const cs = getComputedStyle(stack);
      const pos = clampPos(parseFloat(cs.right) || 18, parseFloat(cs.bottom) || 18);
      void settings.fabPos.getValue().then((all) => {
        void settings.fabPos.setValue({ ...all, [location.hostname]: pos });
      });
    });
  }

  let suppressNextClick = false;
  let lastFlagged = 0;

  function mount(): void {
    // Re-mount if the page wiped our host (SPA body replacement) — a stale
    // non-null reference would otherwise hide the toggle forever.
    if (host?.isConnected) return;
    host?.remove();
    host = null;
    host = document.createElement("div");
    host.setAttribute(MARK_ATTR, "host");
    host.id = "pangram-fab";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = [sheet()];

    const stack = document.createElement("div");
    stack.className = "stack";

    actionEl = document.createElement("button");
    actionEl.className = "chip action";
    actionEl.type = "button";
    actionEl.id = "pangram-action";
    actionEl.addEventListener("click", () => actionCb?.());

    fabEl = document.createElement("button");
    fabEl.className = "chip fab";
    fabEl.type = "button";

    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = "P";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = "Pangram";

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
    // Restore the saved per-host position (clamped to the current viewport).
    void settings.fabPos.getValue().then((all) => {
      const pos = all[location.hostname];
      if (pos && host) applyPos(stack, pos.r, pos.b);
    });

    const wrap = document.createElement("div");
    wrap.className = "fabwrap";
    wrap.append(fabEl, countEl); // count is a corner bubble over the ball

    stack.append(panelEl, actionEl, wrap);
    // Tapping anywhere outside the FAB closes the panel.
    document.addEventListener(
      "pointerdown",
      (e) => {
        if (panelEl?.classList.contains("open") && host && !e.composedPath().includes(host)) {
          panelEl.classList.remove("open");
        }
      },
      true,
    );
    shadow.appendChild(stack);
    (document.body ?? document.documentElement).appendChild(host);
    applyState();
    setCount(lastFlagged, 0); // restore the counter across re-mounts
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
      return;
    }
    renderPanel();
    panelEl.classList.add("open");
  }

  function renderPanel(): void {
    if (!panelEl) return;
    panelEl.textContent = "";
    const head = document.createElement("div");
    head.className = "phead";
    const entries = opts.panel?.entries() ?? [];
    head.textContent = entries.length
      ? `Flagged paragraphs (${entries.length})`
      : "Flagged paragraphs";
    panelEl.appendChild(head);
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pempty";
      empty.textContent = "Nothing flagged on this page.";
      panelEl.appendChild(empty);
      return;
    }
    for (const entry of entries) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = `pitem band-${entry.band}`;
      const pct = document.createElement("span");
      pct.className = "ppct";
      pct.textContent = `${entry.pct}%`;
      const text = document.createElement("span");
      text.className = "ptext";
      text.textContent = entry.snippet;
      item.append(pct, text);
      item.addEventListener("click", () => {
        panelEl?.classList.remove("open");
        opts.panel?.onJump(entry.id);
      });
      panelEl.appendChild(item);
    }
  }

  function setAction(
    label: string | null,
    onAction?: () => void,
    opts?: { attention?: boolean },
  ): void {
    actionLabel = label;
    actionCb = onAction;
    actionAttention = opts?.attention ?? false;
    applyState();
  }

  function unmount(): void {
    host?.remove();
    host = null;
    fabEl = null;
    actionEl = null;
    countEl = null;
    panelEl = null;
  }

  return { mount, setActive, setCount, setAction, unmount };
}
