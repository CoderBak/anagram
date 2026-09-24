// lib/render/dist.ts — the verdict readout shared by the hover card and the selection
// card: where the score sits on the human → AI-generated scale (with the range the
// model's own probabilities spread over, and the three places the word changes), a line
// when the verdict is uncertain, and the four probabilities, each by its colour on the
// same scale.
import type { ScoreResult } from "../contract";
import { t } from "../i18n";
import { bandLabel, BUCKET_BANDS } from "./band";
import { isUncertain, scaleColorCss, scaleGradient, scoreRange, SCORE_CUTS, topTwo } from "./scale";

const at = (x: number): string => `${(Math.min(Math.max(x, 0), 1) * 100).toFixed(1)}%`;
const percent = (p: number): number => Math.round(Math.max(p, 0) * 100);

/** A dot in the score's colour — hollow when the verdict is uncertain. */
export function swatchHtml(r: ScoreResult): string {
  return `<span class="sw${isUncertain(r) ? " unsure" : ""}" style="--s:${r.score.toFixed(3)}"></span>`;
}

export function distributionHtml(r: ScoreResult): string {
  const range = scoreRange(r);
  const ticks = SCORE_CUTS.map((cut) => `<span class="tick" style="left:${at(cut)}"></span>`).join("");
  // The scale repeats what the number and the rows below it say, so it is not read out.
  const scale =
    `<div class="scale" aria-hidden="true"><span class="track"></span>` +
    `<span class="range" style="left:${at(range.from)};width:${at(range.to - range.from)}"></span>` +
    `${ticks}<span class="marker" style="left:${at(r.score)}"></span></div>` +
    `<div class="ends" aria-hidden="true"><span>${bandLabel("human")}</span><span>${bandLabel("ai")}</span></div>`;
  const [first, second] = topTwo(r.probs);
  const doubt = isUncertain(r)
    ? `<div class="doubt">${t(
        "cardUncertain",
        bandLabel(BUCKET_BANDS[first]),
        percent(r.probs[first]),
        bandLabel(BUCKET_BANDS[second]),
        percent(r.probs[second]),
      )}</div>`
    : "";
  const rows = r.probs
    .map((p, i) => {
      const centre = (i / (BUCKET_BANDS.length - 1)).toFixed(3);
      return (
        `<div class="drow"><span class="ddot" style="--s:${centre}"></span>` +
        `<span class="dk">${bandLabel(BUCKET_BANDS[i])}</span><span class="dv">${percent(p)}%</span></div>`
      );
    })
    .join("");
  return `<div class="dist">${scale}${doubt}<div class="drows">${rows}</div></div>`;
}

/** Shared styles (light + dark) for the readout. Hosts using it set .pg-dark on themselves. */
export const DIST_CSS = `
.sw, .dist .ddot { --c: ${scaleColorCss(false)}; }
:host(.pg-dark) .sw, :host(.pg-dark) .dist .ddot { --c: ${scaleColorCss(true)}; }
.sw {
  display: inline-block;
  width: 0.62em;
  height: 0.62em;
  margin-inline-end: 0.42em;
  border-radius: 50%;
  vertical-align: 0.02em;
  background: var(--c);
}
.sw.unsure { background: transparent; box-shadow: inset 0 0 0 0.16em var(--c); }
.dist { margin: 2px 0 7px; }
.dist .scale { position: relative; height: 10px; margin: 6px 0 2px; }
.dist .track {
  position: absolute;
  inset: 2px 0;
  border-radius: 3px;
  background: ${scaleGradient(false)};
}
.dist .range {
  position: absolute;
  top: 0;
  bottom: 0;
  box-sizing: border-box;
  border-radius: 4px;
  border: 1px solid rgba(15, 23, 42, 0.38);
  background: rgba(255, 255, 255, 0.28);
}
.dist .tick {
  position: absolute;
  top: 2px;
  bottom: 2px;
  width: 1px;
  margin-left: -0.5px;
  background: rgba(255, 255, 255, 0.85);
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
.dist .doubt { margin-top: 5px; font-size: 10.5px; line-height: 1.4; color: #404040; }
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
:host(.pg-dark) .dist .range { border-color: rgba(255, 255, 255, 0.5); background: rgba(0, 0, 0, 0.22); }
:host(.pg-dark) .dist .tick { background: rgba(0, 0, 0, 0.55); }
:host(.pg-dark) .dist .marker { background: #fafafa; box-shadow: 0 0 0 1.5px #171717; }
:host(.pg-dark) .dist .ends { color: #8a8a8a; }
:host(.pg-dark) .dist .doubt { color: #d4d4d4; }
:host(.pg-dark) .dist .drows { color: #9aa3ad; }
@media (forced-colors: active) {
  .sw, .dist .ddot, .dist .track, .dist .marker { forced-color-adjust: none; }
}
`;
