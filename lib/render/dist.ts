// lib/render/dist.ts — the 4-bucket probability readout shared by the hover card and
// the selection card: a stacked bar (one segment per bucket, width = probability)
// plus a row per bucket, the predicted one emphasised.
import type { ScoreResult } from "../contract";
import { bandLabel, BUCKET_BANDS, type Band } from "./band";

export function distributionHtml(r: ScoreResult, predicted: Band): string {
  const segs = r.probs
    .map((p, i) => `<span class="seg band-${BUCKET_BANDS[i]}" style="width:${(Math.max(p, 0) * 100).toFixed(1)}%"></span>`)
    .join("");
  const rows = r.probs
    .map((p, i) => {
      const b = BUCKET_BANDS[i];
      return (
        `<div class="drow${b === predicted ? " top" : ""}"><span class="ddot band-${b}"></span>` +
        `<span class="dk">${bandLabel(b)}</span><span class="dv">${Math.round(p * 100)}%</span></div>`
      );
    })
    .join("");
  return `<div class="dist"><div class="dbar">${segs}</div><div class="drows">${rows}</div></div>`;
}

/** Shared styles (light + dark) for the readout. Hosts using it set .pg-dark on themselves. */
export const DIST_CSS = `
.dist { margin: 3px 0 7px; }
.dist .dbar {
  display: flex;
  height: 6px;
  border-radius: 3px;
  overflow: hidden;
  background: rgba(15, 23, 42, 0.08);
}
.dist .seg { display: block; height: 100%; background: var(--bc, #9aa3ad); }
.dist .seg + .seg { margin-left: 1px; }
.dist .band-human { --bc: #1a7f37; }
.dist .band-light { --bc: #d4a017; }
.dist .band-heavy { --bc: #e8590c; }
.dist .band-ai    { --bc: #dc2626; }
.dist .drows {
  display: grid;
  grid-template-columns: auto 1fr auto;
  column-gap: 7px;
  row-gap: 1px;
  margin-top: 5px;
  font-size: 10px;
  line-height: 1.45;
  color: #656d76;
}
.dist .drow { display: contents; }
.dist .drow.top .dk, .dist .drow.top .dv { color: #1f2328; font-weight: 650; }
.dist .ddot { width: 7px; height: 7px; border-radius: 50%; align-self: center; background: var(--bc, #9aa3ad); }
.dist .dv { font-variant-numeric: tabular-nums; text-align: right; }
:host(.pg-dark) .dist .dbar { background: rgba(255, 255, 255, 0.12); }
:host(.pg-dark) .dist .drows { color: #9aa3ad; }
:host(.pg-dark) .dist .drow.top .dk, :host(.pg-dark) .dist .drow.top .dv { color: #e6edf3; }
@media (forced-colors: active) { .dist .seg, .dist .ddot { forced-color-adjust: none; } }
`;
