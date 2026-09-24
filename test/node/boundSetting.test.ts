import { describe, expect, it, vi } from "vitest";
import { bindSelect, bindToggle } from "../../lib/ui/boundSetting";

class Toggle extends EventTarget { checked = false; }
class Select extends EventTarget { value = ""; }
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("settings controls bound to storage", () => {
  it("puts a switch back to the stored value when the write fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const toggle = new Toggle();
    bindToggle(toggle, { getValue: async () => true, setValue: async () => { throw new Error("quota"); } });
    await settle();
    expect(toggle.checked).toBe(true);
    toggle.checked = false; toggle.dispatchEvent(new Event("change"));
    await settle();
    expect(toggle.checked).toBe(true);
    expect(errors).toHaveBeenCalled();
  });

  it("puts a select back to the stored value when the write fails", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const select = new Select();
    bindSelect(select, { getValue: async () => "main", setValue: async () => { throw new Error("quota"); } });
    await settle();
    expect(select.value).toBe("main");
    select.value = "page"; select.dispatchEvent(new Event("change"));
    await settle();
    expect(select.value).toBe("main");
    expect(errors).toHaveBeenCalled();
  });

  it("keeps what the user picked once it is stored", async () => {
    let stored = "flagged";
    const select = new Select();
    bindSelect(select, { getValue: async () => stored, setValue: async (v) => { stored = v; } });
    await settle();
    select.value = "all"; select.dispatchEvent(new Event("change"));
    await settle();
    expect(stored).toBe("all");
    expect(select.value).toBe("all");
  });

  it("says so when the stored value cannot be read", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const toggle = new Toggle();
    bindToggle(toggle, { getValue: async () => { throw new Error("unreadable"); }, setValue: vi.fn() });
    await settle();
    expect(errors).toHaveBeenCalled();
  });
});
