import { browser } from "#imports";
import { t } from "../i18n";

/** Browser updates apply to the extension regardless of which engine is installed. */
export function mountExtensionUpdate(host: HTMLElement): void {
  const status = document.createElement("span");
  status.setAttribute("role", "status");
  const apply = document.createElement("button");
  apply.type = "button";
  apply.className = "btn";
  apply.dataset.size = "sm";
  apply.textContent = t("componentReloadExtension");
  apply.addEventListener("click", () => browser.runtime.reload());
  host.append(status, apply);

  const paint = (version: unknown): void => {
    const available = typeof version === "string" && version.length > 0 && version.length <= 100 && version !== browser.runtime.getManifest().version;
    status.textContent = available ? t("componentExtensionUpdate", version) : "";
    host.hidden = !available;
  };
  // The background stores updates announced while neither page is open.
  let changed = false;
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && "extensionUpdatePending" in changes) {
      changed = true;
      paint(changes.extensionUpdatePending.newValue);
    }
  });
  void browser.storage.local.get("extensionUpdatePending").then((saved) => {
    if (!changed) paint(saved.extensionUpdatePending);
  }).catch(() => undefined);
}
