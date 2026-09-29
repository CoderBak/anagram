// lib/ui/progressBar.ts — the download's bar, for both engines' panels.
//
// A rounded track with a fill in the theme's primary colour, and a diagonal stripe that
// moves while bytes are arriving. Paused, failed or under reduced motion the stripe stands
// still or is gone (./progressBar.css). `fraction` null is a job with no count, the model
// starting: the whole bar, striped.
import "./progressBar.css";

export interface ProgressBar {
  /** The bar, a role="progressbar" element. */
  el: HTMLElement;
  set(fraction: number | null, state: "running" | "paused" | "failed", label: string): void;
}

export function progressBar(): ProgressBar {
  const el = document.createElement("div");
  el.className = "pbar";
  el.setAttribute("role", "progressbar");
  el.setAttribute("aria-valuemin", "0");
  el.setAttribute("aria-valuemax", "100");
  const fill = document.createElement("i");
  el.append(fill);
  return {
    el,
    set(fraction, state, label) {
      el.dataset.state = state;
      el.setAttribute("aria-label", label);
      if (fraction === null) {
        el.removeAttribute("aria-valuenow");
        el.dataset.indeterminate = "";
        fill.style.width = "100%";
      } else {
        const percent = Math.round(Math.min(Math.max(fraction, 0), 1) * 100);
        el.setAttribute("aria-valuenow", String(percent));
        delete el.dataset.indeterminate;
        fill.style.width = `${(Math.min(Math.max(fraction, 0), 1) * 100).toFixed(1)}%`;
      }
    },
  };
}
