/** These controls supply their own translated name. The icon is decorative. */
export function prependActionIcon(control: HTMLElement, name: "copy" | "refresh" | "previous" | "next"): void {
  const ns = "http://www.w3.org/2000/svg";
  const icon = document.createElementNS(ns, "svg");
  icon.setAttribute("class", "action-icon");
  icon.setAttribute("aria-hidden", "true");
  icon.setAttribute("focusable", "false");
  const use = document.createElementNS(ns, "use");
  use.setAttribute("href", "/icons/actions.svg#" + name);
  icon.append(use);
  control.prepend(icon);
}
