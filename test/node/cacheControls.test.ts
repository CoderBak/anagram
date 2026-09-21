import { beforeEach, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { invalidateAndNotify } from "../../lib/access/cacheControls";
import { ACTIONS } from "../../lib/messaging/protocol";

beforeEach(() => fakeBrowser.reset());

it("invalidates page caches before a pending disk operation settles, including failed clears", async () => {
  let fail!: (reason: Error) => void;
  const pending = new Promise<void>((_, reject) => { fail = reject; });
  vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue([{ id: 1 }, { id: 2 }, {}] as never);
  const send = vi.spyOn(fakeBrowser.tabs, "sendMessage").mockResolvedValue(undefined);
  const cleared = invalidateAndNotify(() => pending);
  await Promise.resolve();
  expect(send).toHaveBeenCalledWith(1, { action: ACTIONS.CACHE_CLEARED });
  expect(send).toHaveBeenCalledWith(2, { action: ACTIONS.CACHE_CLEARED });
  expect(send).toHaveBeenCalledTimes(2);
  const rejected = expect(cleared).rejects.toThrow("disk unavailable");
  fail(new Error("disk unavailable")); await rejected;
});

it("does not misreport disk success because a tab closed before receiving the notification", async () => {
  vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue([{ id: 1 }] as never);
  vi.spyOn(fakeBrowser.tabs, "sendMessage").mockRejectedValue(new Error("tab closed"));
  await expect(invalidateAndNotify(() => Promise.resolve())).resolves.toBeUndefined();
  await Promise.resolve();
});

it("also notifies pages when invalidation throws synchronously", async () => {
  const query = vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue([]);
  expect(() => invalidateAndNotify(() => { throw new Error("clear failed"); })).toThrow("clear failed");
  expect(query).toHaveBeenCalledOnce();
  await Promise.resolve();
});
