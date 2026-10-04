// lib/render/dist.ts — the verdict readout shared by the hover card and the selection
// card: where the score sits on the human → AI-generated scale, drawn as the four words'
// slices, and the four probabilities, each by its word's colour. How sure the word is is a
// line of its own (unsureNote), not a shading on the scale.
import type { ScoreResult } from "../contract";
import type { UnitVerdict } from "../capture/windows";
import { t } from "../i18n";
import { bandLabel, BUCKET_BANDS } from "./band";
import { verdictConfidence } from "./confidence";
import { bandColorRules, levelOf, nearestOtherLevel, scaleGradient } from "./scale";

const at = (x: number): string => `${(Math.min(Math.max(x, 0), 1) * 100).toFixed(1)}%`;
const percent = (p: number): number => Math.round(Math.max(p, 0) * 100);

/** Below this chance that its word is right (lib/render/confidence.ts) a card says what else
 *  the verdict could have been. */
const UNSURE_BELOW = 0.5;

/** The card's line for a verdict whose word is likely wrong — the word it could as well have
 *  been — or "" when the word is likely right. */
export function unsureNote(verdict: UnitVerdict): string {
  return verdictConfidence(verdict) < UNSURE_BELOW ? t("cardUnsure", bandLabel(BUCKET_BANDS[nearestOtherLevel(verdict.result.score)]!)) : "";
}

/** A dot in the word's colour. */
export function swatchHtml(r: ScoreResult): string {
  return `<span class="sw b${levelOf(r.score)}"></span>`;
}

/** The readout's markup; placeMarkers puts the score's marker on its scale once it is in. */
export function distributionHtml(r: ScoreResult): string {
  // The scale repeats what the number and the rows below it say, so it is not read out.
  const scale =
    `<div class="scale" aria-hidden="true"><span class="track"></span>` +
    `<span class="marker" data-at="${at(r.score)}"></span></div>` +
    `<div class="ends" aria-hidden="true"><span>${bandLabel("human")}</span><span>${bandLabel("ai")}</span></div>`;
  const rows = r.probs
    .map((p, i) => {
      return (
        `<div class="drow"><span class="ddot b${i}"></span>` +
        `<span class="dk">${bandLabel(BUCKET_BANDS[i]!)}</span><span class="dv">${percent(p)}%</span></div>`
      );
    })
    .join("");
  return `<div class="dist">${scale}<div class="drows">${rows}</div></div>`;
}

/**
 * Each scale's marker at its score, set through the element's style rather than written as a
 * style attribute in the markup: Firefox holds an attribute that a content script writes into
 * a page to the page's Content-Security-Policy, and a policy without 'unsafe-inline' refused
 * it and told the page so at every card.
 */
export function placeMarkers(root: ParentNode): void {
  for (const marker of root.querySelectorAll<HTMLElement>(".dist .marker[data-at]")) marker.style.left = marker.dataset.at!;
}

/** Shared styles (light + dark) for the readout. Hosts using it set .pg-dark on themselves. */
export const DIST_CSS = `
${bandColorRules(".sw", ":host(.pg-dark)")}
${bandColorRules(".dist .ddot", ":host(.pg-dark)")}
.sw {
  display: inline-block;
  width: 0.62em;
  height: 0.62em;
  margin-inline-end: 0.42em;
  border-radius: 50%;
  vertical-align: 0.02em;
  background: var(--c);
}
.dist { margin: 2px 0 7px; }
.dist .scale { position: relative; height: 10px; margin: 6px 0 2px; }
.dist .track {
  position: absolute;
  inset: 2px 0;
  border-radius: 3px;
  background: ${scaleGradient(false)};
}
.dist .marker {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 3px;
  margin-left: -1.5px;
  border-radius: 2px;
  background: #1f2328;
  box-shadow: 0 0 0 1.5px #ffffff;
}
.dist .ends {
  display: flex;
  justify-content: space-between;
  font-size: 9.5px;
  line-height: 1.3;
  color: #737373;
}
.dist .drows {
  display: grid;
  grid-template-columns: auto 1fr auto;
  column-gap: 7px;
  row-gap: 1px;
  margin-top: 6px;
  font-size: 10px;
  line-height: 1.45;
  color: #656d76;
}
.dist .drow { display: contents; }
.dist .ddot { width: 7px; height: 7px; border-radius: 50%; align-self: center; background: var(--c); }
.dist .dv { font-variant-numeric: tabular-nums; text-align: right; }
:host(.pg-dark) .dist .track { background: ${scaleGradient(true)}; }
:host(.pg-dark) .dist .marker { background: #fafafa; box-shadow: 0 0 0 1.5px #171717; }
:host(.pg-dark) .dist .ends { color: #8a8a8a; }
:host(.pg-dark) .dist .drows { color: #9aa3ad; }
@media (forced-colors: active) {
  .sw, .dist .ddot, .dist .track, .dist .marker { forced-color-adjust: none; }
}
`;
