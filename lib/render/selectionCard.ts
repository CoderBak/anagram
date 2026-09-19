// lib/render/selectionCard.ts — "Analyze selection" result card.
//
// Invoked from the context menu: scores EXACTLY the selected text — including
// places passive capture deliberately skips (editors, textareas, fragments under
// the evidence floor) — and shows the calibrated readout in a small fixed card
// near the selection. Below the floor it says so honestly instead of scoring. A long
// selection is read completely, in the same windows a long paragraph is (one aggregate,
// each window's own number in the card), so "Words analyzed" is the selection again.
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { MARK_ATTR } from "../types";
import type { ScoreBatchRequest } from "../contract";
import { CONTRACT_VERSION } from "../contract";
import { isScoredWindow, readInWindows, unitVerdict } from "../capture/windows";
import { requestScores, type ScoreReply } from "../messaging/client";
import { SURFACE } from "../surface";
import { band, BAND_LABEL, isNoVerdict, languageName, scorePct, type Band } from "./band";
import { coverageNote, windowPcts, windowReadout } from "./coverage";
import { DIST_CSS, distributionHtml } from "./dist";
import { countWords, MIN_UNIT_WORDS } from "../dom/text";
import { isDarkPage } from "./theme";

const CARD_CSS = `
:host { all: initial; }
.card {
  position: fixed;
  box-sizing: border-box;
  width: 264px;
  padding: 11px 13px 10px;
  border-radius: 8px;
  border: 1px solid #e5e5e5;
  background: #ffffff;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.08);
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
.verdict.band-unsupported { color: #737373; }
.big { font-weight: 700; font-size: 12px; font-variant-numeric: tabular-nums; }
.row { display: flex; justify-content: space-between; gap: 12px; }
.row .k { color: #737373; }
.row .v { font-variant-numeric: tabular-nums; }
.row.wins .k { flex: none; }
.row.wins .v { text-align: right; }
.foot { margin-top: 6px; padding-top: 6px; border-top: 1px solid #f0f0f0; color: #737373; font-size: 10px; }
.close {
  position: absolute; top: 6px; right: 8px;
  border: none; background: none; font: 700 12px/1 system-ui; color: #737373; cursor: pointer; padding: 2px;
}
.close:hover { color: #252525; }
.spin { color: #737373; }

:host(.pg-dark) .card {
  border-color: rgba(255, 255, 255, 0.10);
  background: #171717;
  color: #fafafa;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
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

function row(k: string, v: string, cls = ""): string {
  return `<div class="row${cls}"><span class="k">${k}</span><span class="v">${v}</span></div>`;
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
  // ONE delegated listener, bound before anything is rendered: the ✕ has to close the
  // card in every state — including the whole wait for a stalled daemon, which is where
  // it used to be dead — and it has to survive the innerHTML re-renders below, each of
  // which replaces the button element.
  card.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    if (target?.closest?.(".close")) dismiss();
  });
  shadow.appendChild(card);
  (document.body ?? document.documentElement).appendChild(host);
  document.addEventListener("pointerdown", onOutside, true);
  document.addEventListener("keydown", onKey, true);

  // Floating UI against the selection rectangle (a virtual element): below it,
  // flipped above near the viewport bottom, shifted to stay on screen. Re-run after
  // each content change since the card grows when the verdict lands.
  const anchor = rect ?? new DOMRect(window.innerWidth / 2, 72, 0, 0);
  const place = (): void => {
    void computePosition({ getBoundingClientRect: () => anchor }, card, {
      strategy: "fixed",
      placement: "bottom-start",
      middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      card.style.left = `${x}px`;
      card.style.top = `${y}px`;
    });
  };

  const words = countWords(text);
  const closeBtn = `<button class="close" title="Close">✕</button>`;

  if (words < MIN_UNIT_WORDS) {
    card.innerHTML =
      closeBtn +
      `<div class="head"><span class="verdict band-unknown">Too short to judge</span><span class="big">—</span></div>` +
      row("Words selected", String(words)) +
      row("Needed for a reliable read", `${MIN_UNIT_WORDS}+`) +
      `<div class="foot">Detection is unreliable below the evidence floor — select a longer passage.</div>`;
    place();
  } else {
    card.innerHTML =
      closeBtn +
      `<div class="head"><span class="verdict band-unknown spin">Analyzing…</span><span class="big"></span></div>` +
      row("Words selected", String(words));
    place();
    // The selection's windows travel in ONE request, straight to the worker: no page
    // cache and no local language gate stand between a selection and the daemon.
    let backend = "up" as ScoreReply["backend"];
    const session = "sel_" + Math.random().toString(36).slice(2, 10);
    const read = await readInWindows([{ id: "sel", text, order: 0 }], async (blocks) => {
      const req: ScoreBatchRequest = {
        v: CONTRACT_VERSION,
        session,
        surface: SURFACE,
        priority: "viewport",
        lang: document.documentElement.getAttribute("lang") || "und",
        domain: location.hostname || "und",
        blocks,
      };
      const reply = await requestScores(req);
      backend = reply.backend;
      return new Map(reply.results.map((r) => [r.id, r] as const));
    });
    if (!_host || _host !== host) return; // dismissed while in flight
    const windows = read.get("sel");
    const verdict = windows ? unitVerdict("sel", text.length, windows) : null;
    if (!verdict || verdict.result.degraded) {
      card.innerHTML =
        closeBtn +
        `<div class="head"><span class="verdict band-unknown">Unavailable</span><span class="big">—</span></div>` +
        `<div class="foot">${
          backend === "down"
            ? "The scoring daemon is not running — run <code>anagram start</code> and try again."
            : "The scoring backend did not respond — try again."
        }</div>`;
    } else {
      const r = verdict.result;
      const b: Band = band(r);
      const pct = scorePct(r);
      const readout = isNoVerdict(b) ? null : windowReadout(verdict);
      // Everything selected, unless the selection outgrew the window cap or the language
      // gate refused part of it — then it is the words of the windows that were scored.
      const partial = verdict.unreadChars > 0 || (readout !== null && readout.skipped > 0);
      const analyzed = partial
        ? verdict.windows.filter(isScoredWindow).reduce((n, w) => n + countWords(text.slice(w.start, w.end)), 0)
        : words;
      card.innerHTML =
        closeBtn +
        `<div class="head"><span class="verdict band-${b}">${BAND_LABEL[b]}</span>` +
        `<span class="big" title="Extent of AI editing (EditLens scale)">${isNoVerdict(b) ? "—" : pct + "%"}</span></div>` +
        (isNoVerdict(b) ? "" : distributionHtml(r, b)) +
        (b === "unsupported" ? row("Detected language", `${languageName(r.lang)} · ${Math.round((r.lang_prob ?? 0) * 100)}%`) : "") +
        row("Words selected", String(words)) +
        (readout ? row("Words analyzed", verdict.unreadChars > 0 ? `first ${analyzed}` : String(analyzed)) : "") +
        (readout ? row(`Scored in ${readout.count} windows`, windowPcts(readout), " wins") : "") +
        (readout && readout.cutShort > 0 ? row("Windows cut short", `${readout.cutShort} of ${readout.count}`) : "") +
        (readout && readout.skipped > 0 ? row("Windows not in English", `${readout.skipped} of ${readout.count}`) : "") +
        `<div class="foot">${
          b === "unknown"
            ? "The scoring daemon did not answer — try again."
            : b === "unsupported"
              ? "EditLens is trained on English text only, so this selection was not scored."
              : coverageNote(verdict, "selection") +
                "The number is EditLens's estimate of how far this text sits from untouched human writing toward fully AI-generated — not a share of words, not proof."
        }</div>`;
    }
    place();
  }
}
