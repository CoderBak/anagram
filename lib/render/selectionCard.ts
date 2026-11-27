// lib/render/selectionCard.ts — "Analyze selection" result card.
//
// Invoked from the context menu: scores EXACTLY the selected text — including
// places passive capture deliberately skips (editors, textareas, fragments under
// the evidence floor) — and shows the calibrated readout in a small fixed card
// near the selection. Below the floor it says so honestly instead of scoring. A long
// selection is read completely, in the same passes a long paragraph is (one aggregate,
// each pass's own number in the card), so "Words analyzed" is the selection again.
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { MARK_ATTR } from "../types";
import { chipShadowMode } from "./shadowMode";
import type { ModelInfo, ScoreBatchRequest, ScoreResult } from "../contract";
import { CONTRACT_VERSION, modelDim } from "../contract";
import { readParagraphs } from "../capture/readParagraphs";
import { isScoredWindow, requestSlices, unitVerdict } from "../capture/windows";
import { requestScores, requestTokenCounts, type ScoreReply } from "../messaging/client";
import { messageLocale, t } from "../i18n";
import { band, bandLabel, isNoVerdict, languageName, type Band } from "./band";
import { formatScore } from "./score";
import { coverageNote, shortTextNote, windowScores, windowReadout } from "./coverage";
import { DIST_CSS, sentenceDetailsHtml, distributionHtml, placeMarkers, swatchHtml, unsureNote } from "./dist";
import { countWords, MIN_WORDS } from "../dom/text";
import { isDarkPage } from "./theme";

const CARD_CSS = `
:host { all: initial; }
.card {
  position: fixed;
  box-sizing: border-box;
  width: min(248px, calc(100vw - 16px));
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid rgb(0 0 0 / 0.09);
  background: #ffffff;
  box-shadow: 0 8px 24px rgb(0 0 0 / 0.10), 0 1px 3px rgb(0 0 0 / 0.05);
  font: 400 11.5px/1.5 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
  color: #18181b;
  z-index: 2147483647;
}
.head { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: center; gap: 8px; margin-bottom: 4px; }
.verdict { font-weight: 600; font-size: 12.5px; letter-spacing: -0.01em; }
.verdict.band-unknown { color: #52525b; }
.verdict.band-unsupported { color: #63636c; }
.big { font-weight: 600; font-size: 12.5px; font-variant-numeric: tabular-nums; }
.row { display: flex; justify-content: space-between; gap: 12px; }
.row .k { color: #63636c; }
.row .v { font-variant-numeric: tabular-nums; }
.row.wins .k { flex: none; }
.row.wins .v { text-align: right; }
.short, .unsure { color: #63636c; font-style: italic; margin-bottom: 4px; }
.foot { margin-top: 6px; padding-top: 5px; border-top: 1px solid #f0f0f2; color: #63636c; font-size: 10.5px; }
.close {
  display: grid; place-items: center; width: 28px; height: 28px;
  border: 0; border-radius: 5px; padding: 0; background: transparent; color: #63636c; cursor: pointer;
}
.close svg { width: 12px; height: 12px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.close:hover { background: #efeff1; color: #18181b; }
.spin { color: #63636c; }

:host(.pg-dark) .card {
  border-color: rgb(255 255 255 / 0.11);
  background: #191a1d;
  color: #f1f2f4;
  box-shadow: 0 10px 28px rgb(0 0 0 / 0.55), 0 1px 3px rgb(0 0 0 / 0.3);
}
:host(.pg-dark) .row .k, :host(.pg-dark) .short, :host(.pg-dark) .unsure { color: #a1a4ad; }
:host(.pg-dark) .foot { border-top-color: rgb(255 255 255 / 0.08); color: #9a9da6; }
:host(.pg-dark) .verdict.band-unknown { color: #b9c0c8; }
:host(.pg-dark) .close { color: #a1a4ad; }
:host(.pg-dark) .close:hover { background: rgb(255 255 255 / 0.1); color: #f1f2f4; }
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
  _host?.closest("dialog")?.removeEventListener("close", dismiss);
  _host?.remove();
  _host = null;
  document.removeEventListener("pointerdown", onOutside, true);
  document.removeEventListener("keydown", onKey, true);
}

function onOutside(e: Event): void {
  if (_host && !e.composedPath().includes(_host)) dismiss();
}
function onKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    if (_host?.closest("dialog:modal")) e.preventDefault();
    dismiss();
  }
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
  // Closed in a web page (chipShadowMode): the card says what the reader asked about their
  // own selection — a draft in a form, say — which is none of the page's business.
  const shadow = host.attachShadow({ mode: chipShadowMode() });
  shadow.adoptedStyleSheets = [sheet()];
  const card = document.createElement("div");
  card.className = "card";
  // Our chrome, in the UI's language — not the page's. Said on the element so screen
  // readers and the CJK font fallback both get it right.
  card.lang = messageLocale();
  // The card appears without taking focus and without a sound: a reader who asked for
  // this from the context menu would never learn the verdict had landed. role="status"
  // is the polite version — the card is announced when its contents change, and it is
  // appended empty so the first render counts as a change.
  card.setAttribute("role", "status");
  // ONE delegated listener, bound before anything is rendered: the ✕ has to close the
  // card in every state — including the whole wait for a stalled daemon, which is where
  // it used to be dead — and it has to survive the innerHTML re-renders below, each of
  // which replaces the button element.
  card.addEventListener("click", (e) => {
    const target = e.target as Element | null;
    if (target?.closest?.(".close")) dismiss();
  });
  shadow.appendChild(card);
  // Controls outside a modal are inert. Follow focus through its shadow hosts.
  let focused = deepActiveElement();
  let modal = focused?.closest("dialog:modal");
  while (focused && !modal) {
    const root = focused.getRootNode();
    focused = root instanceof ShadowRoot ? root.host : null;
    modal = focused?.closest("dialog:modal");
  }
  (modal ?? document.body ?? document.documentElement).appendChild(host);
  modal?.addEventListener("close", dismiss);
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
  const closeBtn = `<button class="close" type="button" aria-label="${t("selClose")}" title="${t("selClose")}"><svg viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="m3 3 10 10m0-10L3 13"/></svg></button>`;

  // The minimum length is the selection's floor as it is a paragraph's.
  const floor = MIN_WORDS;
  if (words < floor) {
    card.innerHTML =
      `<div class="head"><span class="verdict band-unknown">${t("selTooShort")}</span><span class="big">—</span>${closeBtn}</div>` +
      row(t("selWordsSelected"), String(words)) +
      row(t("selNeeded"), `${floor}+`) +
      `<div class="foot">${t("selFootTooShort")}</div>`;
    place();
  } else {
    card.innerHTML =
      `<div class="head"><span class="verdict band-unknown spin">${t("selAnalyzing")}</span><span class="big"></span>${closeBtn}</div>` +
      row(t("selWordsSelected"), String(words));
    place();
    // The selection's windows go straight to the worker: no page cache and no local
    // language gate stand between a selection and the engine. A whole page selected can
    // outgrow what one request may carry, so they travel in the same bounded slices the
    // page's own batches do (requestSlices), one after another.
    let backend = "up" as ScoreReply["backend"];
    let producing: ModelInfo | null = null;
    let incompatible = false;
    const session = "sel_" + Math.random().toString(36).slice(2, 10);
    const read = await readParagraphs([{ id: "sel", text, order: 0 }], async (blocks) => {
      const answers = new Map<string, ScoreResult>();
      for (const slice of requestSlices(blocks, (b) => b.text.length)) {
        const req: ScoreBatchRequest = {
          v: CONTRACT_VERSION,
          session,
          priority: "viewport",
          blocks: slice,
        };
        const reply = await requestScores(req);
        backend = reply.backend;
        if (!reply.model || (producing && modelDim(producing) !== modelDim(reply.model))) {
          incompatible = true;
          return new Map();
        }
        producing = reply.model;
        for (const r of reply.results) answers.set(r.id, r);
      }
      return answers;
    }, async (texts) => {
      const reply = await requestTokenCounts(texts);
      backend = reply.backend;
      return reply.counts;
    });
    if (!_host || _host !== host) return; // dismissed while in flight
    const windows = incompatible ? undefined : read.get("sel");
    const verdict = windows ? unitVerdict("sel", text.length, windows, text) : null;
    if (!verdict || verdict.result.degraded) {
      card.innerHTML =
        `<div class="head"><span class="verdict band-unknown">${bandLabel("unknown")}</span><span class="big">—</span>${closeBtn}</div>` +
        `<div class="foot">${
          backend === "down"
            ? t("selFootDaemonDown")
            : t("selFootNoAnswer")
        }</div>`;
    } else {
      const r = verdict.result;
      const b: Band = band(r);
      const score = formatScore(r.score);
      const readout = isNoVerdict(b) ? null : windowReadout(verdict);
      // Everything selected, unless the selection outgrew the window cap or the language
      // gate refused part of it — then it is the words of the windows that were scored.
      const partial = verdict.unreadChars > 0 || (readout !== null && readout.skipped > 0);
      const analyzed = partial
        ? verdict.windows.filter(isScoredWindow).reduce((n, w) => n + countWords(text.slice(w.start, w.end)), 0)
        : words;
      const short = isNoVerdict(b) || r.probs.length===3 ? "" : shortTextNote(words);
      const foot = b === "unknown" ? t("selFootUnavailable") : b === "unsupported" ? t("selFootUnsupported") : coverageNote(verdict, "selection", text).trim();
      card.innerHTML =
        `<div class="head"><span class="verdict band-${b}">${isNoVerdict(b) ? "" : swatchHtml(r)}${bandLabel(b)}</span>` +
        `<span class="big" title="${t("cardScaleTitle")}">${isNoVerdict(b) ? "—" : score}</span>${closeBtn}</div>` +
        (!isNoVerdict(b) && unsureNote(verdict) ? `<div class="unsure">${unsureNote(verdict)}</div>` : "") +
        (short ? `<div class="short">${short}</div>` : "") +
        (isNoVerdict(b) ? "" : distributionHtml(r)+sentenceDetailsHtml(verdict)) +
        (b === "unsupported" ? row(t("cardDetectedLang"), `${languageName(r.lang)}, ${Math.round((r.lang_prob ?? 0) * 100)}%`) : "") +
        row(t("selWordsSelected"), String(words)) +
        (!isNoVerdict(b) && partial ? row(t("selWordsAnalyzed"), verdict.unreadChars > 0 ? t("selFirst", analyzed) : String(analyzed)) : "") +
        (readout ? row(t("cardWindows", readout.count), windowScores(readout), " wins") : "") +
        (readout && readout.cutShort > 0 ? row(t("cardWindowsCut"), t("cardOfCount", readout.cutShort, readout.count)) : "") +
        (readout && readout.skipped > 0 ? row(t("cardWindowsSkipped"), t("cardOfCount", readout.skipped, readout.count)) : "") +
        (foot ? `<div class="foot">${foot}</div>` : "");
      placeMarkers(card);
    }
    place();
  }
}
