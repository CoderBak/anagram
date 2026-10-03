import { t } from "../../lib/i18n";
import { MODEL_MIN_WORDS } from "../../lib/dom/text";
import { commentHost } from "../../lib/access/commentFrames";
import { bandLabel, BUCKET_BANDS } from "../../lib/render/band";
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
    slice.className = `b${i}`;
    slice.style.flexGrow = String(n);
    slice.style.background = "var(--c)";
    bar.append(slice);
  });
  const legend = document.createElement("ul");
  legend.className = "legend";
  BUCKET_BANDS.forEach((b, i) => {
    const item = document.createElement("li");
    const n = bands[i] ?? 0;
    item.className = `b${i}${n ? "" : " zero"}`;
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

export function mountReport(host: HTMLElement, hooks: {
  jump(documentId: string, id: string): void;
  page(offset: number): void;
  allow(origin: string): void;
}): (report: PageReport | null) => void {
  let previous = "";
  let previousPage = "";
  return (report) => {
    host.hidden = !report;
    if (!report) { previous = ""; host.replaceChildren(); return; }
    const key = JSON.stringify(report);
    if (key === previous) return;
    previous = key;
    const focused = host.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focus : undefined;
    const page = `${report.documentId}:${report.offset}`;
    const scroll = page === previousPage ? host.querySelector(".report-list")?.scrollTop ?? 0 : 0;
    previousPage = page;
    const title = document.createElement("h2");
    title.id = "reportTitle";
    title.tabIndex = -1;
    title.textContent = report.total === 0 ? t("panelEmpty") : t("panelTitleCount", report.total, report.counts.read);
    const coverage = document.createElement("p");
    coverage.className = "report-coverage";
    const c = report.counts;
    coverage.textContent = [
      ...(c.short ? [t("panelCovShort", c.short)] : []),
      ...(c.lessReliable ? [t("panelCovLessReliable", c.lessReliable, MODEL_MIN_WORDS)] : []),
      ...(c.notEnglish ? [t("panelCovNotEnglish", c.notEnglish)] : []),
      ...(c.pending ? [t("panelCovPending", c.pending)] : []),
      ...(c.unavailable ? [t("panelCovUnavailable", c.unavailable)] : []),
    ].join(t("listSeparator"));
    coverage.hidden = !coverage.textContent;
    const scope = document.createElement("p");
    scope.className = "report-coverage";
    scope.textContent = report.scopeNote;
    scope.hidden = !report.scopeNote;
    // Nothing read yet (a PDF tab before the reader, a page still loading): no mix to show.
    const read = report.counts.read > 0;
    host.replaceChildren(...(read ? mixOf(report.counts.bands) : []), coverage, scope, ...(read ? [title] : []));
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
      line.append(text, allow); host.append(line);
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
      score.className = `report-score chip b${BUCKET_BANDS.indexOf(entry.band)}`;
      score.textContent = formatScore(entry.score);
      const text = document.createElement("span");
      text.textContent = entry.snippet;
      button.append(score, text);
      button.addEventListener("click", () => hooks.jump(report.documentId, entry.id));
      row.append(button); list.append(row);
    }
    if (read && report.total > 0) host.append(list);
    host.hidden = !read && coverage.hidden && scope.hidden && report.commentOrigins.length === 0;
    if (report.total > REPORT_PAGE_SIZE) {
      const nav = document.createElement("nav");
      nav.className = "report-pages"; nav.setAttribute("aria-label", t("panelTitle"));
      const label = document.createElement("span");
      label.textContent = t("popupReportRange", report.offset + 1, report.offset + report.entries.length, report.total);
      const buttons = ([-1, 1] as const).map((dir) => {
        const button = document.createElement("button");
        button.type = "button"; button.className = "btn"; button.dataset.size = "sm"; button.dataset.variant = "outline";
        button.dataset.focus = `page:${dir}`;
        button.textContent = t(dir === -1 ? "popupResultsPrevious" : "popupResultsNext");
        button.disabled = dir === -1 ? report.offset === 0 : report.offset + report.entries.length >= report.total;
        button.addEventListener("click", () => hooks.page(report.offset + dir * REPORT_PAGE_SIZE));
        return button;
      });
      nav.append(buttons[0]!, label, buttons[1]!); host.append(nav);
    }
    list.scrollTop = scroll;
    if (focused) ([...host.querySelectorAll<HTMLElement>("[data-focus]")]
      .find((element) => element.dataset.focus === focused && !(element as HTMLButtonElement).disabled) ?? title).focus({ preventScroll: true });
  };
}
