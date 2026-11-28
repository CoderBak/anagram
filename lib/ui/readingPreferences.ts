import { storage } from "#imports";
import { t, type MessageKey } from "../i18n";
import { settings } from "../settings/settings";
import { bindSelect } from "./boundSetting";

export function mountReadingPreferences(host: HTMLElement): void {
  function field(id: string, title: MessageKey, choices: [string, MessageKey][]): HTMLSelectElement {
    const label = document.createElement("label");
    label.htmlFor = id;
    label.textContent = t(title);
    const select = document.createElement("select");
    select.id = id;
    select.className = "select";
    for (const [value, key] of choices) select.add(new Option(t(key), value));
    const group = document.createElement("div");
    group.className = "field";
    group.append(label, select);
    host.append(group);
    return select;
  }

  const flagFrom = field("flagFrom", "optFlagFrom", [["light", "optFlagLight"], ["ai", "optFlagAi"]]);
  const displayMode = field("displayMode", "optChips", [["all", "optEveryParagraph"], ["flagged", "popupFlaggedOnly"]]);
  const underline = field("underline", "optUnderline", [
    ["flagged", "optUnderlineFlagged"], ["all", "optEveryParagraph"], ["off", "optUnderlineOff"],
  ]);

  settings.displayMode.watch(bindSelect(displayMode, settings.displayMode));
  settings.flagFrom.watch(bindSelect(flagFrom, {
    getValue: async () => {
      const value = await settings.flagFrom.getValue();
      return value === "heavy" ? "ai" : value;
    },
    setValue: (value: "light" | "ai") => settings.flagFrom.setValue(value),
  }));
  const refreshUnderlines = bindSelect<"flagged" | "all" | "off">(underline, {
    getValue: async () => {
      const [enabled, scope] = await Promise.all([settings.showHighlights.getValue(), settings.underlineScope.getValue()]);
      return enabled ? scope : "off";
    },
    setValue: (value) => value === "off" ? settings.showHighlights.setValue(false) : storage.setItems([
      { item: settings.underlineScope, value },
      { item: settings.showHighlights, value: true },
    ]),
  });
  settings.showHighlights.watch(refreshUnderlines);
  settings.underlineScope.watch(refreshUnderlines);
}
