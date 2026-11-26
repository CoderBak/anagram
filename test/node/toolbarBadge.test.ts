import { afterEach, expect, it, vi } from "vitest";
import { toolbarBadge } from "../../lib/ui/toolbarBadge";

afterEach(() => vi.useRealTimers());
it("retains the latest scan count behind repeated copy feedback and cancels restoration on tab close", () => {
  vi.useFakeTimers();
  const api = {setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn()};
  const badge = toolbarBadge(api);
  badge.count(1, 2);
  badge.feedback(1, true);
  badge.count(1, 9);
  expect(api.setBadgeText).toHaveBeenLastCalledWith({tabId: 1, text: "✓"});
  vi.advanceTimersByTime(1000);
  badge.feedback(1, false);
  vi.advanceTimersByTime(500);
  expect(api.setBadgeText).toHaveBeenLastCalledWith({tabId: 1, text: "!"});
  vi.advanceTimersByTime(1000);
  expect(api.setBadgeText).toHaveBeenLastCalledWith({tabId: 1, text: "9"});
  badge.feedback(1, true);
  badge.forget(1);
  badge.count(2, 0);
  vi.advanceTimersByTime(2000);
  expect(api.setBadgeText).toHaveBeenLastCalledWith({tabId: 2, text: ""});
});
