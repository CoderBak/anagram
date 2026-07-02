// lib/render/fab.ts — floating overlay toggle (bottom-right), Shadow DOM.
//
// An always-present control (like Immersive Translate's floating ball) that
// shows/hides the detection overlay WITHOUT re-running detection, plus an
// optional secondary ACTION chip stacked above it (e.g. "Reading view" on Google
// Docs). Its host carries MARK_ATTR="host" so the walker skips it, and
// id="pangram-fab" so tests can find/click it.
import { MARK_ATTR } from "../types";

export interface Fab {
  mount(): void;
  /** Reflect whether the overlay is currently shown. */
  setActive(active: boolean): void;
  /** Update the flagged-paragraph counter. */
  setCount(flagged: number, total: number): void;
  /** Show (label + callback) or hide (null) the secondary action chip. */
  setAction(label: string | null, onAction?: () => void): void;
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
  pointer-events: none;
}
.count.zero { background: #1a7f37; }

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

export function createFab(opts: { onToggle: () => void }): Fab {
  let host: HTMLElement | null = null;
  let fabEl: HTMLButtonElement | null = null;
  let actionEl: HTMLButtonElement | null = null;
  let countEl: HTMLElement | null = null;
  let active = true;
  let actionLabel: string | null = null;
  let actionCb: (() => void) | undefined;

  function applyState(): void {
    if (!fabEl) return;
    fabEl.classList.toggle("off", !active);
    fabEl.parentElement?.classList.toggle("off", !active);
    fabEl.title = active ? "Hide AI detection" : "Show AI detection";
    if (actionEl) {
      actionEl.classList.toggle("show", actionLabel !== null);
      actionEl.textContent = actionLabel ?? "";
    }
  }

  function mount(): void {
    if (host) return;
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

    fabEl.append(mark, label);
    fabEl.addEventListener("click", () => opts.onToggle());

    const wrap = document.createElement("div");
    wrap.className = "fabwrap";
    wrap.append(fabEl, countEl); // count is a corner bubble over the ball

    stack.append(actionEl, wrap);
    shadow.appendChild(stack);
    (document.body ?? document.documentElement).appendChild(host);
    applyState();
  }

  function setActive(a: boolean): void {
    active = a;
    applyState();
  }

  function setCount(flagged: number, _total: number): void {
    if (!countEl) return;
    countEl.textContent = String(flagged);
    countEl.classList.toggle("zero", flagged === 0);
  }

  function setAction(label: string | null, onAction?: () => void): void {
    actionLabel = label;
    actionCb = onAction;
    applyState();
  }

  function unmount(): void {
    host?.remove();
    host = null;
    fabEl = null;
    actionEl = null;
    countEl = null;
  }

  return { mount, setActive, setCount, setAction, unmount };
}
