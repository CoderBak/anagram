import { browser } from "#imports";
import { t } from "../i18n";
import "./safariEnginePage.css";

/** The Safari worker's visible home. Links open separately so they never stop inference. */
export function mountSafariEnginePage(): void {
  document.documentElement.lang = t("localeTag");
  document.title = t("safariEngineTitle");
  const main = document.createElement("main");
  main.className = "safari-engine";
  const icon = document.createElement("img");
  icon.src = browser.runtime.getURL("/icons/icon-96.png"); icon.alt = ""; icon.width = icon.height = 64;
  const title = document.createElement("h1"); title.textContent = t("safariEngineTitle");
  const note = document.createElement("p"); note.textContent = t("safariEngineTabNote");
  const privacy = document.createElement("p"); privacy.textContent = t("safariEnginePrivacy");
  const links = document.createElement("nav");
  const setup = document.createElement("a");
  setup.href = browser.runtime.getURL("/onboarding.html"); setup.target = "_blank"; setup.rel = "noopener"; setup.textContent = t("safariEngineSetup");
  const settings = document.createElement("a");
  settings.href = browser.runtime.getURL("/options.html"); settings.target = "_blank"; settings.rel = "noopener"; settings.textContent = t("safariEngineSettings");
  links.append(setup, settings);
  main.append(icon, title, note, privacy, links);
  document.body.append(main);
}
