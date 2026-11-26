import { afterEach, expect, it, vi } from "vitest";
import { toolbarBadge } from "../../lib/ui/toolbarBadge";

afterEach(() => vi.useRealTimers());
it("retains the latest scan count behind repeated copy feedback and cancels restoration on tab close", async () => {
  vi.useFakeTimers();
  const api = {getBadgeText: vi.fn().mockResolvedValue("2"), setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn()};
  const badge = toolbarBadge(api);
  badge.count(1, 2);
  badge.feedback(1, true);
  badge.count(1, 9);
  expect(api.setBadgeText).toHaveBeenLastCalledWith({tabId: 1, text: "✓"});
  await vi.advanceTimersByTimeAsync(1000);
  badge.feedback(1, false);
  await vi.advanceTimersByTimeAsync(500);
  expect(api.setBadgeText).toHaveBeenLastCalledWith({tabId: 1, text: "!"});
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.setBadgeText).toHaveBeenLastCalledWith({tabId: 1, text: "9"});
  badge.feedback(1, true);
  badge.forget(1);
  badge.count(2, 0);
  await vi.advanceTimersByTimeAsync(2000);
  expect(api.setBadgeText).toHaveBeenLastCalledWith({tabId: 2, text: ""});
});

it("a newly started worker restores the browser's existing count after a copy", async () => {
  vi.useFakeTimers();
  const api = {getBadgeText: vi.fn().mockResolvedValue("7"), setBadgeText: vi.fn(), setBadgeBackgroundColor: vi.fn()};
  const badge = toolbarBadge(api);
  badge.feedback(1, true);
  badge.feedback(1, false);
  expect(api.getBadgeText).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1500);
  expect(api.setBadgeText).toHaveBeenLastCalledWith({tabId: 1, text: "7"});
});
