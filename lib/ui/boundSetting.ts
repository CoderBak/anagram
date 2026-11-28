// lib/ui/boundSetting.ts — a Settings switch or select bound straight to one stored setting.
//
// The control shows what storage holds and writes whatever the user picks. A write that
// storage refuses puts the control back to what storage still holds, so the page never
// claims a setting that did not take. These rows have no error line of their own, so the
// failure goes to the console; the report-privacy switches, which must never look saved
// when they are not, say so on the page instead (lib/ui/confirmedToggle.ts).
import { createLogger } from "../log";

const log = createLogger("options");

type Stored<T> = { getValue(): Promise<T>; setValue(value: T): Promise<void> };
type Control = { addEventListener(type: "change", listener: () => void): void };

function bind<T>(el: Control, item: Stored<T>, read: () => T, show: (value: T) => void): () => Promise<void> {
  let revision = 0;
  const restore = async (): Promise<void> => {
    const requested = ++revision;
    try {
      const value = await item.getValue();
      if (requested === revision) show(value);
    } catch (error) {
      log.error("could not read a setting", error);
    }
  };
  void restore();
  el.addEventListener("change", () => {
    ++revision;
    void item.setValue(read()).catch((error) => {
      log.error("could not save a setting", error);
      return restore();
    });
  });
  return restore;
}

export function bindToggle(el: Control & { checked: boolean }, item: Stored<boolean>): void {
  bind(el, item, () => el.checked, (v) => { el.checked = v; });
}

export function bindSelect<T extends string>(el: Control & { value: string }, item: Stored<T>): () => Promise<void> {
  return bind(el, item, () => el.value as T, (v) => { el.value = v; });
}
