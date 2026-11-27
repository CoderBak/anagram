import { prependActionIcon } from "../../lib/ui/actionIcon";
import { t } from "../../lib/i18n";
import { MODEL_MIN_WORDS } from "../../lib/dom/text";
import { commentHost } from "../../lib/access/commentFrames";
import { bandLabel, BUCKET_BANDS, type Band } from "../../lib/render/band";
import { formatScore, spokenScore } from "../../lib/render/score";
import { REPORT_PAGE_SIZE, type PageReport } from "../../lib/capture/pageReport";

/** What the page's paragraphs read as: one bar, its slices the four words' shares, and the
 *  four counts under it — what a reader going through a lot of text takes in at a glance. */
function mixOf(bands: readonly number[]): HTMLElement[] {
  const total = bands.reduce((a, n) => a + n, 0);
  const bar = document.createElement("div");
  bar.className = "mix";
  bar.setAttribute("aria-hidden", "true");
  bands.forEach((n, i) => {
    if (!n) return;
    const slice = document.createElement("span");
    slice.className = `b${i===4 ? 1 : i}`;
    slice.style.flexGrow = String(n);
    slice.style.background = "var(--c)";
    bar.append(slice);
  });
  const legend = document.createElement("ul");
  legend.className = "legend";
  const labels: readonly Band[] = [...BUCKET_BANDS,"assisted"];
  const slots = bands.length>4 ? (bands[1] || bands[2] ? [0,1,2,4,3] : [0,4,3]) : [0,1,2,3];
  slots.forEach(i => {
    const b=labels[i]!;
    const item = document.createElement("li");
    const n = bands[i] ?? 0;
    item.className = `b${i===4 ? 1 : i}${n ? "" : " zero"}`;
    const dot = document.createElement("span");
    dot.className = "dot";
    const label = document.createElement("span");
    label.className = "lbl";
    label.textContent = bandLabel(b);
    const count = document.createElement("span");
    count.className = "n";
    count.textContent = String(n);
    item.append(dot, label, count);
    legend.append(item);
  });
  return total ? [bar, legend] : [legend];
}

/** Paragraphs read before a page still being read shows its mix. */
const MIN_MIX = 3;

export function mountReport(host: HTMLElement, hooks: {
  jump(documentId: string, id: string): void;
  page(offset: number): void;
  allow(origin: string): void;
}): (report: PageReport | null, engineAway?: boolean) => void {
  const heading = host.querySelector<HTMLElement>(".report-heading")!;
  const title = heading.querySelector("h2")!;
  const body = host.querySelector<HTMLElement>(".report-body")!;
  let previous = "";
  let previousPage = "";
  let documentId: string | undefined;
  const breakdown = document.createElement("details");
  breakdown.className = "breakdown";
  const summary = document.createElement("summary");
  const breakdownLabel = document.createElement("span");
  breakdownLabel.textContent = t("scoreBreakdown");
  summary.append(breakdownLabel);
  summary.dataset.focus = "breakdown";
  return (report, engineAway = false) => {
    if (!report) { host.hidden = true; previous = ""; heading.hidden = true; body.replaceChildren(); return; }
    const key = JSON.stringify([report, engineAway]);
    if (key === previous) return;
    previous = key;
    const focused = host.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focus : undefined;
    if (documentId !== report.documentId) {
      documentId = report.documentId;
      breakdown.open = false;
    }
    const page = `${report.documentId}:${report.offset}`;
    const scroll = page === previousPage ? host.querySelector(".report-list")?.scrollTop ?? 0 : 0;
    previousPage = page;
    // While paragraphs are still being read, nothing flagged is only nothing flagged yet.
    const reading = report.counts.pending > 0 || !!report.scopeNote;
    title.textContent = report.total === 0 ? t(reading ? "panelEmptySoFar" : "panelEmpty") : t("panelTitleCount", report.total, report.counts.read);
    const coverage = document.createElement("p");
    coverage.className = "report-coverage";
    const c = report.counts;
    const read = c.read > 0;
    const foreignPage = !read && c.notEnglish > 0 && !c.pending;
    coverage.textContent = [
      ...(c.short ? [t("panelCovShort", c.short)] : []),
      ...(c.lessReliable ? [t("panelCovLessReliable", c.lessReliable, MODEL_MIN_WORDS)] : []),
      ...(c.notEnglish && !foreignPage ? [t("panelCovNotEnglish", c.notEnglish)] : []),
      ...(c.pending && !engineAway ? [t("panelCovPending", c.pending)] : []),
      ...(c.unavailable && !engineAway ? [t("panelCovUnavailable", c.unavailable)] : []),
    ].join(t("listSeparator"));
    coverage.hidden = !coverage.textContent;
    const scope = document.createElement("p");
    scope.className = "report-coverage";
    scope.textContent = report.scopeNote;
    scope.hidden = !report.scopeNote;
    // A page whose every paragraph is in another language: say why there is nothing, once.
    const foreign = document.createElement("p");
    foreign.className = "report-lead";
    foreign.textContent = foreignPage ? t("panelNotEnglishPage") : "";
    foreign.hidden = !foreign.textContent;
    // One paragraph read of a document still being read is no mix: a bar drawn whole in its
    // colour said the page was that colour.
    const mix = read && (c.read >= MIN_MIX || !reading);
    // Progress and failures explain an incomplete result. Other coverage belongs with the verdict counts.
    const coverageInBreakdown = mix && (engineAway || (!c.pending && !c.unavailable));
    heading.hidden = !read;
    if (read) host.setAttribute("aria-labelledby", title.id);
    else host.removeAttribute("aria-labelledby");
    body.replaceChildren(foreign, scope);
    if (!coverageInBreakdown && !coverage.hidden) body.append(coverage);
    for (const origin of report.commentOrigins) {
      const line = document.createElement("p");
      line.className = "report-comment";
      const text = document.createElement("span");
      text.textContent = t("panelCommentsElsewhere", commentHost(origin));
      const allow = document.createElement("button");
      allow.type = "button"; allow.className = "btn"; allow.dataset.size = "sm"; allow.dataset.variant = "outline";
      allow.textContent = t("panelCommentsAllow");
      allow.setAttribute("aria-label", t("panelCommentsAllowAria", commentHost(origin)));
      allow.dataset.focus = `allow:${origin}`;
      allow.addEventListener("click", () => hooks.allow(origin));
      line.append(text, allow); body.append(line);
    }
    const list = document.createElement("ul");
    list.className = "report-list";
    list.setAttribute("aria-labelledby", title.id);
    for (const entry of report.entries) {
      const row = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button"; button.className = "report-result";
      button.dataset.focus = entry.id;
      button.setAttribute("aria-label", t("panelItemAria", bandLabel(entry.band), spokenScore(entry.score), entry.snippet));
      // The row's score is the paragraph's chip, as it stands on the page.
      const score = document.createElement("span");
      score.className = `report-score chip b${entry.band==="assisted" ? 1 : BUCKET_BANDS.indexOf(entry.band)}`;
      const dot = document.createElement("span");
      dot.className = "dot";
      score.append(dot, formatScore(entry.score));
      const text = document.createElement("span");
      text.textContent = entry.snippet;
      button.append(score, text);
      button.addEventListener("click", () => hooks.jump(report.documentId, entry.id));
      row.append(button); list.append(row);
    }
    if (read && report.total > 0) body.append(list);
    host.hidden = !read && foreign.hidden && coverage.hidden && scope.hidden && report.commentOrigins.length === 0;
    if (report.total > REPORT_PAGE_SIZE) {
      const nav = document.createElement("nav");
      nav.className = "report-pages"; nav.setAttribute("aria-label", t("panelTitle"));
      const label = document.createElement("span");
      label.textContent = t("popupReportRange", report.offset + 1, report.offset + report.entries.length, report.total);
      const buttons = ([-1, 1] as const).map((dir) => {
        const button = document.createElement("button");
        button.type = "button"; button.className = "btn icon-action"; button.dataset.variant = "ghost";
        button.dataset.focus = `page:${dir}`;
        button.title = t(dir === -1 ? "popupResultsPrevious" : "popupResultsNext");
        button.setAttribute("aria-label", button.title);
        prependActionIcon(button, dir === -1 ? "previous" : "next");
        button.disabled = dir === -1 ? report.offset === 0 : report.offset + report.entries.length >= report.total;
        button.addEventListener("click", () => hooks.page(report.offset + dir * REPORT_PAGE_SIZE));
        return button;
      });
      nav.append(buttons[0]!, label, buttons[1]!); body.append(nav);
    }
    if (mix) {
      breakdown.replaceChildren(summary, ...mixOf(c.bands));
      if (coverageInBreakdown && !coverage.hidden) breakdown.append(coverage);
      body.append(breakdown);
    }
    list.scrollTop = scroll;
    if (focused) ([...host.querySelectorAll<HTMLElement>("[data-focus]")]
      .find((element) => element.dataset.focus === focused && !(element as HTMLButtonElement).disabled) ?? title).focus({ preventScroll: true });
  };
}
