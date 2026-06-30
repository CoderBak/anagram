// lib/render/badge.ts — Shadow-DOM per-paragraph badge layer (§4.8).
//
// For each scored Unit we mount ONE Shadow-DOM host element anchored to
// `unit.parentElement`. The host is appended as the last child of the anchor block and
// absolutely positioned into a corner (the anchor gets `position: relative` if it is
// statically positioned) so the badge stays small and avoids major layout shift.
//
// The host carries MARK_ATTR="host" and the anchor block is marked MARK_ATTR="scored" so
// the walker's self-mutation guard skips both on re-walk. Constructable stylesheets are
// adopted into the shadow root — we never fetch a CSS URL.
import type { Unit } from "../types";
import { MARK_ATTR } from "../types";
import type { ScoreResult } from "../contract";
import { band, BAND_LABEL, type Band } from "./band";
import { BADGE_CSS } from "./badge.css";

export interface BadgeLayer {
  render(unit: Unit, result: ScoreResult): void;
  remove(id: string): void;
  /** Show/hide all badges without removing them (instant toggle, keeps results). */
  setVisible(visible: boolean): void;
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

export function createBadgeLayer(): BadgeLayer {
  // Track mounted hosts by unit id for idempotent re-render + teardown.
  const hosts = new Map<string, HTMLElement>();

  function render(unit: Unit, result: ScoreResult): void {
    const anchor = unit.parentElement as HTMLElement | null;
    if (!anchor) return;

    const b: Band = band(result);
    const label = BAND_LABEL[b];

    let host = hosts.get(unit.id);

    if (!host) {
      // First mount: create the host, attach a shadow root, adopt the stylesheet.
      host = document.createElement("span");
      host.setAttribute(MARK_ATTR, "host");
      const shadow = host.attachShadow({ mode: "open" });
      shadow.adoptedStyleSheets = [badgeSheet()];

      const pill = document.createElement("span");
      pill.className = "pill";
      const dot = document.createElement("span");
      dot.className = "dot";
      const labelEl = document.createElement("span");
      labelEl.className = "label";
      pill.append(dot, labelEl);
      shadow.appendChild(pill);

      // Anchor the host: ensure the block is a positioning context so the absolutely
      // positioned host lands in its corner, then append as the last child.
      ensurePositioned(anchor);
      anchor.appendChild(host);

      // Mark the scored block so the walker's self-mutation guard skips it on re-walk.
      anchor.setAttribute(MARK_ATTR, "scored");

      hosts.set(unit.id, host);
    }

    // Anchor the badge just after where the paragraph's TEXT actually ends (its last line),
    // so it sits beside the words — not out in the empty box area next to a floated infobox,
    // figure or sidebar (paragraph boxes are full-width on sites like Wikipedia).
    positionBadge(host, anchor);

    // Idempotent update-in-place: refresh the label text + band class (keep the dot).
    const pill = host.shadowRoot?.querySelector(".pill") as HTMLElement | null;
    const labelEl = host.shadowRoot?.querySelector(".label") as HTMLElement | null;
    if (pill && labelEl) {
      // Minimal chip: coloured dot + the AI-involvement number (0–100). The full label and
      // an "estimate, not proof" caveat live on hover so the chip stays uncluttered.
      const pct = Math.round(result.e_theta * 100);
      labelEl.textContent = b === "unknown" ? "?" : String(pct);
      pill.className = `pill band-${b}`;
      pill.title =
        b === "unknown"
          ? "Insufficient text to judge"
          : `${label} · est. ${pct}% AI involvement (calibrated estimate, not proof)`;
    }
  }

  function remove(id: string): void {
    const host = hosts.get(id);
    if (!host) return;
    const anchor = host.parentElement;
    host.remove();
    hosts.delete(id);
    // If the anchor no longer hosts any of our badges, drop the scored marker so it can
    // be re-walked and re-scored later.
    if (anchor && !anchor.querySelector(`[${MARK_ATTR}="host"]`)) {
      anchor.removeAttribute(MARK_ATTR);
    }
  }

  function setVisible(visible: boolean): void {
    for (const [, host] of hosts) host.classList.toggle("pg-hidden", !visible);
  }

  function teardownAll(): void {
    for (const [, host] of hosts) {
      const anchor = host.parentElement;
      host.remove();
      if (anchor && !anchor.querySelector(`[${MARK_ATTR}="host"]`)) {
        anchor.removeAttribute(MARK_ATTR);
      }
    }
    hosts.clear();
  }

  return { render, remove, setVisible, teardownAll };
}

/** Make `el` a positioning context for the absolutely-positioned host, if it is not one. */
function ensurePositioned(el: HTMLElement): void {
  const pos = getComputedStyle(el).position;
  if (pos === "static") {
    el.style.position = "relative";
  }
}

/**
 * Place the host just after the end of the paragraph's last line of TEXT. Using the text's
 * client rects (not the box's right edge) keeps the badge beside the words even when the box
 * is full-width with a floated figure/infobox/sidebar in the empty area (e.g. Wikipedia).
 */
function positionBadge(host: HTMLElement, anchor: HTMLElement): void {
  let left = anchor.clientWidth;
  let top = 0;
  try {
    const range = document.createRange();
    range.selectNodeContents(anchor);
    // Exclude our own badge (the last child) from the measurement.
    if (host.parentElement === anchor) range.setEndBefore(host);
    const rects = range.getClientRects();
    if (rects.length > 0) {
      const base = anchor.getBoundingClientRect();
      const last = rects[rects.length - 1];
      left = last.right - base.left;
      top = last.top - base.top + last.height / 2 - 10; // center the 20px pill on the line
    }
  } catch {
    /* fall back to the top-right of the box */
  }
  host.style.left = `${Math.max(0, left) + 8}px`;
  host.style.top = `${Math.max(0, top)}px`;
}
