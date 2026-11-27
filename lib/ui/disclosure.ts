import { t } from "../i18n";

/** The button stays in its row, while the disclosed controls use the width of the panel. */
export function bindDisclosure(button: HTMLButtonElement, panel: HTMLElement): void {
  button.setAttribute("aria-controls", panel.id);
  button.setAttribute("aria-expanded", String(!panel.hidden));
  button.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
  });
}

export function engineManagement(row: HTMLElement, controls: HTMLElement, inSettings: boolean): HTMLElement {
  if (!inSettings) return controls;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "disclosure-action engine-manage";
  const label = document.createElement("span");
  label.textContent = t("engineManage");
  button.append(label);
  button.id = "engine-manage";
  row.append(button);
  const panel = document.createElement("div");
  panel.id = "engine-management";
  panel.hidden = true;
  panel.append(controls);
  bindDisclosure(button, panel);
  return panel;
}
