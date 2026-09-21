type Toggle = {
  checked: boolean;
  disabled: boolean;
  addEventListener(type: "change", listener: () => void): void;
};
type Preference = { getValue(): Promise<boolean>; setValue(value: boolean): Promise<void> };

/** Keep privacy controls tied to acknowledged storage, including failed writes. */
export function bindConfirmedToggle(el: Toggle, item: Preference, showError: (failed: boolean) => void): void {
  let saved = false;
  el.disabled = true;
  void item.getValue().then((value) => {
    saved = el.checked = value;
    el.disabled = false;
  }, () => showError(true));
  el.addEventListener("change", () => {
    if (el.disabled) return;
    const requested = el.checked;
    el.disabled = true;
    showError(false);
    void item.setValue(requested).then(() => {
      saved = requested;
    }, () => {
      el.checked = saved;
      showError(true);
    }).finally(() => { el.disabled = false; });
  });
}
