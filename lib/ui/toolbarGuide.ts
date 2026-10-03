import { t, type MessageKey } from "../i18n";
import "./toolbarGuide.css";

/** Pinning is a browser setting, so this guide teaches the browser's own controls. */
export function mountToolbarGuide(host: HTMLElement): void {
  const target = import.meta.env.BROWSER;
  const steps: MessageKey[] = target === "safari"
    ? ["toolbarSafariEnable", "toolbarSafariCustomize", "toolbarSafariDrag"]
    : target === "firefox"
      ? ["toolbarExtensionsMenu", "toolbarFirefoxPin"]
      : ["toolbarExtensionsMenu", "toolbarChromePin"];
  host.classList.add("toolbar-guide");
  const intro = document.createElement("p");
  intro.textContent = t("toolbarPinIntro");
  const list = document.createElement("ol");
  for (const key of steps) {
    const item = document.createElement("li");
    item.textContent = t(key);
    list.append(item);
  }
  host.replaceChildren(intro, list);
}
