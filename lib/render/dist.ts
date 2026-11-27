// lib/render/dist.ts — the verdict readout shared by the hover card and the selection
// card: where the score sits on the human → AI-generated scale, drawn as the four words'
// slices, and the four probabilities, each by its word's colour. How sure the word is is a
// line of its own (unsureNote), not a shading on the scale.
import type { ScoreResult } from "../contract";
import type { UnitVerdict } from "../capture/windows";
import { t } from "../i18n";
import { DETECTOR_BANDS, resultBands, resultLevel, bandLabel, BUCKET_BANDS } from "./band";
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
  if (verdict.result.probs.length === 3) return "";
  return verdictConfidence(verdict) < UNSURE_BELOW ? t("cardUnsure", bandLabel(BUCKET_BANDS[nearestOtherLevel(verdict.result.score)]!)) : "";
}

/** Contiguous sentences with the same decoder label share one numbered range in the card. */
export function sentenceReadout(labels:readonly number[]): string {
  const runs:string[]=[];
  for(let start=0; start<labels.length;) {
    let end=start+1;
    while(end<labels.length && labels[end]===labels[start]) end++;
    const range=end===start+1 ? String(end) : `${start+1}–${end}`;
    runs.push(range+" "+bandLabel(DETECTOR_BANDS[labels[start]!]!));
    start=end;
  }
  return runs.join(", ");
}

export function sentenceDetailsHtml(verdict:UnitVerdict):string {
  const lines=verdict.windows.flatMap((w,i)=>{
    const labels=w.result.sentenceLabels;
    if(!labels?.length) return [];
    const prefix=verdict.windows.length>1 ? `<strong>${t("detectorPass",i+1)}</strong> ` : "";
    return [`<p>${prefix}${sentenceReadout(labels)}</p>`];
  });
  return lines.length ? `<details class="sentence-labels"><summary><span>${t("detectorSentences")}</span></summary><div>${lines.join("")}</div></details>` : "";
}

/** A dot in the word's colour. */
export function swatchHtml(r: ScoreResult): string {
  return `<span class="sw b${resultLevel(r)}"></span>`;
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
        `<div class="drow"><span class="ddot b${r.probs.length===3 && i===2 ? 3 : i}"></span>` +
        `<span class="dk">${bandLabel(resultBands(r)[i]!)}</span><span class="dv">${percent(p)}%</span></div>`
      );
    })
    .join("");
  return `<div class="dist">${r.probs.length===3 ? "" : scale}<div class="drows">${rows}</div></div>`;
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
  vertical-align: middle;
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
  row-gap: 2px;
  margin-top: 6px;
  font-size: 11px;
  line-height: 1.45;
  color: #52525b;
}
.dist .drow { display: contents; }
.sentence-labels { margin: 6px 0 2px; }
.sentence-labels summary {
  display: flex;
  align-items: center;
  gap: 6px;
  list-style: none;
  cursor: pointer;
  color: #52525b;
  font-weight: 500;
}
.sentence-labels summary::-webkit-details-marker { display: none; }
.sentence-labels summary::before {
  content: "";
  flex: none;
  width: .65em;
  border-block-start: .4em solid currentColor;
  clip-path: polygon(0 20%, 12% 0, 50% 62%, 88% 0, 100% 20%, 50% 100%);
}
.sentence-labels:not([open]) summary::before { rotate: -90deg; }
.sentence-labels summary > span { text-box: trim-both cap alphabetic; }
.sentence-labels summary:hover { color: #18181b; }
.sentence-labels > div { max-height: 9em; overflow: auto; }
.sentence-labels p { margin: 4px 0; color: #52525b; }
.dist .ddot { width: 6.5px; height: 6.5px; border-radius: 50%; align-self: center; background: var(--c); }
.dist .dv { font-variant-numeric: tabular-nums; text-align: right; color: #18181b; font-weight: 500; }
:host(.pg-dark) .dist .track { background: ${scaleGradient(true)}; }
:host(.pg-dark) .dist .marker { background: #f1f2f4; box-shadow: 0 0 0 1.5px #191a1d; }
:host(.pg-dark) .dist .ends { color: #9a9da6; }
:host(.pg-dark) .dist .drows { color: #a1a4ad; }
:host(.pg-dark) .dist .dv { color: #f1f2f4; }
:host(.pg-dark) .sentence-labels summary, :host(.pg-dark) .sentence-labels p { color: #a1a4ad; }
:host(.pg-dark) .sentence-labels summary:hover { color: #f1f2f4; }
@media (forced-colors: active) {
  .sw, .dist .ddot, .dist .track, .dist .marker { forced-color-adjust: none; }
}
`;
