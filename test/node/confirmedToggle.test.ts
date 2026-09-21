import { describe, expect, it, vi } from "vitest";
import { bindConfirmedToggle } from "../../lib/ui/confirmedToggle";

class Toggle extends EventTarget { checked = false; disabled = false; }
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

describe("confirmed report privacy toggles", () => {
  it("shows the still-enabled preference when disabling could not be saved", async () => {
    const toggle = new Toggle(), errors = vi.fn();
    const preference = { getValue: async () => true, setValue: vi.fn(async () => { throw new Error("storage failed"); }) };
    bindConfirmedToggle(toggle, preference, errors);
    await settle();
    toggle.checked = false; toggle.dispatchEvent(new Event("change"));
    expect(toggle.disabled).toBe(true);
    await settle();
    expect(toggle.checked).toBe(true);
    expect(toggle.disabled).toBe(false);
    expect(errors).toHaveBeenLastCalledWith(true);
  });

  it("never presents an unread preference as a confirmed editable value", async () => {
    const toggle = new Toggle(), errors = vi.fn();
    const preference = { getValue: async () => { throw new Error("unreadable"); }, setValue: vi.fn() };
    bindConfirmedToggle(toggle, preference, errors);
    await settle();
    expect(toggle.disabled).toBe(true);
    expect(errors).toHaveBeenLastCalledWith(true);
    toggle.dispatchEvent(new Event("change"));
    expect(preference.setValue).not.toHaveBeenCalled();
  });

  it("preserves the last acknowledged setting when a later change fails", async () => {
    const toggle = new Toggle();
    const preference = { getValue: async () => true, setValue: vi.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("failed")) };
    bindConfirmedToggle(toggle, preference, () => {});
    await settle();
    toggle.checked = false; toggle.dispatchEvent(new Event("change"));
    await settle();
    toggle.checked = true; toggle.dispatchEvent(new Event("change"));
    await settle();
    expect(toggle.checked).toBe(false);
  });
});
