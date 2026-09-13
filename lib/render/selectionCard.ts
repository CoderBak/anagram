// lib/render/selectionCard.ts — "Analyze selection" result card.
//
// Invoked from the context menu: scores EXACTLY the selected text — including
// places passive capture deliberately skips (editors, textareas, fragments under
// the evidence floor) — and shows the calibrated readout in a small fixed card
// near the selection. Below the floor it says so honestly instead of scoring.
import { MARK_ATTR } from "../types";
import type { ScoreBatchRequest } from "../contract";
import { CONTRACT_VERSION } from "../contract";
import { requestScores } from "../messaging/client";
import { band, BAND_LABEL, scorePct, type Band } from "./band";
import { DIST_CSS, distributionHtml } from "./dist";
import { countWords, truncateForScoring, MIN_UNIT_WORDS } from "../dom/text";
import { isDarkPage } from "./theme";

const CARD_CSS = `
:host { all: initial; }
.card {
  position: fixed;
  box-sizing: border-box;
  width: 264px;
  padding: 11px 13px 10px;
  border-radius: 12px;
  border: 1px solid rgba(0, 0, 0, 0.10);
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05), 0 12px 36px rgba(0, 0, 0, 0.14);
  font: 400 11px/1.5 ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  color: #252525;
  z-index: 2147483647;
}
.head { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; margin-bottom: 5px; }
.verdict { font-weight: 700; font-size: 12px; }
.verdict.band-human   { color: #116a37; }
.verdict.band-light   { color: #7a5b00; }
.verdict.band-heavy   { color: #a13d00; }
.verdict.band-ai      { color: #b42318; }
.verdict.band-unknown { color: #57606a; }
.big { font-weight: 700; font-size: 12px; font-variant-numeric: tabular-nums; }
.row { display: flex; justify-content: space-between; gap: 12px; }
.row .k { color: #737373; }
.row .v { font-variant-numeric: tabular-nums; }
.foot { margin-top: 6px; padding-top: 6px; border-top: 1px solid #f0f0f0; color: #8a8a8a; font-size: 10px; }
.close {
  position: absolute; top: 6px; right: 8px;
  border: none; background: none; font: 700 12px/1 system-ui; color: #8a8a8a; cursor: pointer; padding: 2px;
}
.close:hover { color: #252525; }
.spin { color: #737373; }

:host(.pg-dark) .card {
  border-color: rgba(255, 255, 255, 0.10);
  background: #262626;
  color: #fafafa;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.4), 0 12px 36px rgba(0, 0, 0, 0.6);
}
:host(.pg-dark) .row .k { color: #a3a3a3; }
:host(.pg-dark) .foot { border-top-color: rgba(255, 255, 255, 0.08); color: #8a8a8a; }
:host(.pg-dark) .verdict.band-human { color: #4ecb71; }
:host(.pg-dark) .verdict.band-light { color: #e6c84c; }
:host(.pg-dark) .verdict.band-heavy { color: #ff9a57; }
:host(.pg-dark) .verdict.band-ai    { color: #ff7b81; }
` + DIST_CSS;

let _sheet: CSSStyleSheet | null = null;
function sheet(): CSSStyleSheet {
  if (!_sheet) {
    _sheet = new CSSStyleSheet();
    _sheet.replaceSync(CARD_CSS);
  }
  return _sheet;
}

let _host: HTMLElement | null = null;

function dismiss(): void {
  _host?.remove();
  _host = null;
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
}

function onOutside(e: Event): void {
  if (_host && !e.composedPath().includes(_host)) dismiss();
}
function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") dismiss();
}

function row(k: string, v: string): string {
  return `<div class="row"><span class="k">${k}</span><span class="v">${v}</span></div>`;
}

/** The focused element, descended through open shadow roots. */
function deepActiveElement(): Element | null {
  let el: Element | null = document.activeElement;
  while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
  return el;
}

/**
 * The current selection: page selection normally, but Chrome exposes NOTHING via
 * window.getSelection() for <textarea>/<input> — read selectionStart/End there,
 * anchored to the field's box. This is what makes "analyze what I just wrote in
 * this comment box" actually work.
 */
function currentSelection(): { text: string; rect: DOMRect | null } {
  const active = deepActiveElement();
  if (
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement && active.type === "text")
  ) {
    const { selectionStart, selectionEnd } = active;
    if (
      selectionStart !== null &&
      selectionEnd !== null &&
      selectionEnd > selectionStart
    ) {
      return {
        text: active.value.slice(selectionStart, selectionEnd).trim(),
        rect: active.getBoundingClientRect(),
      };
    }
  }
  const sel = window.getSelection();
  return {
    text: sel?.toString().trim() ?? "",
    rect: sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect() : null,
  };
}

/** Score the current selection and show the result card next to it. */
export async function analyzeSelection(): Promise<void> {
  const { text, rect } = currentSelection();
  if (!text) return;

  dismiss();
  const host = document.createElement("div");
  host.setAttribute(MARK_ATTR, "host");
  _host = host;
  host.classList.toggle("pg-dark", isDarkPage());
  const shadow = host.attachShadow({ mode: "open" });
  shadow.adoptedStyleSheets = [sheet()];
  const card = document.createElement("div");
  card.className = "card";
  shadow.appendChild(card);
  (document.body ?? document.documentElement).appendChild(host);
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);

  // Place below the selection; flip above when near the viewport bottom.
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const top = rect ? (rect.bottom + 190 < vh ? rect.bottom + 8 : Math.max(8, rect.top - 190)) : 80;
  const left = rect ? Math.min(Math.max(8, rect.left), vw - 280) : vw / 2 - 132;
  card.style.top = `${Math.round(top)}px`;
  card.style.left = `${Math.round(left)}px`;

  const words = countWords(text);
  const closeBtn = `<button class="close" title="Close">✕</button>`;

  if (words < MIN_UNIT_WORDS) {
    card.innerHTML =
      closeBtn +
      `<div class="head"><span class="verdict band-unknown">Too short to judge</span><span class="big">—</span></div>` +
      row("Words selected", String(words)) +
      row("Needed for a reliable read", `${MIN_UNIT_WORDS}+`) +
      `<div class="foot">Detection is unreliable below the evidence floor — select a longer passage.</div>`;
  } else {
    card.innerHTML =
      closeBtn +
      `<div class="head"><span class="verdict band-unknown spin">Analyzing…</span><span class="big"></span></div>` +
      row("Words selected", String(words));
    const req: ScoreBatchRequest = {
      v: CONTRACT_VERSION,
      session: "sel_" + Math.random().toString(36).slice(2, 10),
      surface: "chrome-ext",
      priority: "viewport",
      lang: document.documentElement.getAttribute("lang") || "und",
      domain: location.hostname || "und",
      blocks: [{ id: "sel_0", text: truncateForScoring(text), order: 0 }],
    };
    const [r] = await requestScores(req);
    if (!_host || _host !== host) return; // dismissed while in flight
    if (!r) {
      card.innerHTML =
        closeBtn +
        `<div class="head"><span class="verdict band-unknown">Unavailable</span><span class="big">—</span></div>` +
        `<div class="foot">The scoring backend did not respond — try again.</div>`;
    } else {
      const b: Band = band(r);
      const pct = scorePct(r);
      card.innerHTML =
        closeBtn +
        `<div class="head"><span class="verdict band-${b}">${BAND_LABEL[b]}</span>` +
        `<span class="big">${b === "unknown" ? "—" : pct + "% AI"}</span></div>` +
        (b === "unknown" ? "" : distributionHtml(r, b)) +
        row("Words analyzed", String(words)) +
        (r.truncated ? row("Model window", `first ${r.tokens ?? 512} tokens`) : "") +
        `<div class="foot">${b === "unknown" ? "The scoring backend did not answer — try again." : "EditLens estimate of AI editing, not proof."}</div>`;
    }
  }
  shadow.querySelector(".close")?.addEventListener("click", dismiss);
}
