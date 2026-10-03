// lib/ui/siteAccess.ts — the site-access row the setup page and Settings share: what is
// granted, "Allow all sites" and "Remove access". Anagram installs able to read no site at all;
// withdrawing leaves the per-site rules alone, they are settings, not access.
import { browser } from "#imports";
import { t, tn } from "../i18n";
import { ALL_SITES } from "../access/patterns";
import { accessSummary, requestAccess, withdrawAccess } from "../access/grant";
import "./rows.css";

/** Append the row to `host` (a `.rows` container). `hint` is the setup page's: with nothing
 *  granted the row is the button and how else to switch Anagram on, not "No sites". */
export function mountSiteAccess(host: HTMLElement, { hint = false }: { hint?: boolean } = {}): void {
  const row = document.createElement("div"); row.className = "row"; row.id = "site-access";
  const state = document.createElement("span"); state.className = "row-label"; state.id = "accessState";
  const body = document.createElement("div"); body.className = "row-body";
  const hintText = document.createElement("span"); hintText.className = "hint"; hintText.textContent = t("accessHint");
  const allow = document.createElement("button"); allow.type = "button"; allow.id = "accessAll";
  allow.className = "btn"; allow.dataset.size = "sm"; allow.textContent = t("accessAllowAll");
  const withdraw = document.createElement("button"); withdraw.type = "button"; withdraw.id = "accessWithdraw";
  withdraw.className = "btn"; withdraw.dataset.variant = "outline"; withdraw.dataset.size = "sm"; withdraw.textContent = t("accessWithdraw");
  if (!hint) allow.dataset.variant = "outline";
  body.append(allow, ...(hint ? [hintText] : []), withdraw);
  row.append(state, body);
  host.append(row);

  async function render(): Promise<void> {
    const { all, sites } = await accessSummary();
    const none = !all && sites.length === 0;
    state.textContent = all ? t("accessAllowed") : sites.length > 0 ? tn("accessSites", sites.length) : t("accessNone");
    state.hidden = hint && none;
    row.classList.toggle("lead", hint && none);
    hintText.hidden = !hint || all;
    allow.hidden = all;
    withdraw.hidden = none;
  }
  // The request has to be the first thing the click does: the browsers honour it only as
  // part of the user's gesture. Taking access back needs no gesture.
  allow.addEventListener("click", () => { void requestAccess(ALL_SITES).then(render); });
  withdraw.addEventListener("click", () => { void withdrawAccess().then(render); });
  browser.permissions.onAdded.addListener(() => void render());
  browser.permissions.onRemoved.addListener(() => void render());
  void render();
}
