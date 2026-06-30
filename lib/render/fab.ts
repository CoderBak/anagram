// lib/render/fab.ts — floating overlay toggle button (bottom-right), Shadow DOM.
//
// An always-present control (like Immersive Translate's floating ball) that shows/hides the
// detection overlay WITHOUT re-running detection. Reflects the active state and the count of
// flagged paragraphs. Its host carries MARK_ATTR="host" so the walker's self-mutation guard
// ignores it, and id="pangram-fab" so it can be found/clicked.
import { MARK_ATTR } from "../types";

export interface Fab {
  mount(): void;
  /** Reflect whether the overlay is currently shown. */
  setActive(active: boolean): void;
  /** Update the flagged-paragraph counter. */
  setCount(flagged: number, total: number): void;
  unmount(): void;
}

const FAB_CSS = `
:host { all: initial; }

.fab {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 2147483647;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 13px 0 11px;
  box-sizing: border-box;
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 9999px;
  background: rgba(255, 255, 255, 0.9);
  -webkit-backdrop-filter: saturate(1.4) blur(12px);
  backdrop-filter: saturate(1.4) blur(12px);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.16), 0 1px 3px rgba(0, 0, 0, 0.08);
  font: 600 12px/1 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #1f2328;
  cursor: pointer;
  user-select: none;
  transition: box-shadow 140ms ease, transform 140ms ease, opacity 140ms ease;
}

.fab:hover { transform: translateY(-1px); box-shadow: 0 10px 28px rgba(0, 0, 0, 0.20), 0 2px 4px rgba(0, 0, 0, 0.10); }
.fab:active { transform: translateY(0); }

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

.label { white-space: nowrap; }

.count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  box-sizing: border-box;
  border-radius: 9999px;
  background: rgba(229, 72, 77, 0.14);
  color: #b42318;
  font-size: 11px;
  font-weight: 700;
}
.count.zero { background: rgba(26, 127, 55, 0.14); color: #116a37; }

/* inactive (overlay hidden) → muted */
.fab.off { opacity: 0.62; }
.fab.off .mark { filter: grayscale(0.5); }
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
  let countEl: HTMLElement | null = null;
  let active = true;

  function applyState(): void {
    if (!fabEl) return;
    fabEl.classList.toggle("off", !active);
    fabEl.title = active ? "Hide AI detection" : "Show AI detection";
  }

  function mount(): void {
    if (host) return;
    host = document.createElement("div");
    host.setAttribute(MARK_ATTR, "host"); // walker self-mutation guard skips it
    host.id = "pangram-fab";
    const shadow = host.attachShadow({ mode: "open" });
    shadow.adoptedStyleSheets = [sheet()];

    fabEl = document.createElement("button");
    fabEl.className = "fab";
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

    fabEl.append(mark, label, countEl);
    fabEl.addEventListener("click", () => opts.onToggle());
    shadow.appendChild(fabEl);
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

  function unmount(): void {
    host?.remove();
    host = null;
    fabEl = null;
    countEl = null;
  }

  return { mount, setActive, setCount, unmount };
}
