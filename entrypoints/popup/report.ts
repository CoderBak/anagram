import { t } from "../../lib/i18n";
import { MODEL_MIN_WORDS } from "../../lib/dom/text";
import { commentHost } from "../../lib/access/commentFrames";
import { bandLabel } from "../../lib/render/band";
import { formatScore, spokenScore } from "../../lib/render/score";
import { REPORT_PAGE_SIZE, type PageReport } from "../../lib/capture/pageReport";

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
    title.textContent = t("panelTitleCount", report.total, report.counts.read);
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
    host.replaceChildren(title, coverage, scope);
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
      const score = document.createElement("span");
      score.className = "report-score"; score.textContent = formatScore(entry.score);
      const text = document.createElement("span");
      text.textContent = entry.snippet;
      button.append(score, text);
      button.addEventListener("click", () => hooks.jump(report.documentId, entry.id));
      row.append(button); list.append(row);
    }
    if (report.total === 0) {
      const empty = document.createElement("p");
      empty.className = "report-coverage"; empty.textContent = t("panelEmpty"); host.append(empty);
    } else host.append(list);
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
