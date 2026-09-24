import { beforeEach, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { applyCacheMode, invalidateAndNotify } from "../../lib/access/cacheControls";
import { createCacheModeController } from "../../lib/backend/cacheMode";
import { createRouter } from "../../lib/backend/router";
import { createSwCache } from "../../lib/backend/swCache";
import type { ScoreCacheMode } from "../../lib/cachePolicy";
import { CONTRACT_VERSION, type ScoreClient } from "../../lib/contract";
import { ACTIONS } from "../../lib/messaging/protocol";
import { deferred, fakeScoreStore } from "./scoreStore";

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

it("a waking worker applies its saved mode without clearing a cache or a tab's batch in flight", async () => {
  const model = {id:"model",ver:"1",calibration:"none"}, answer = deferred<void>();
  const client: ScoreClient = {model: () => model, async scoreBatch(blocks) {
    await answer.promise; return {model, results: blocks.map(({id}) => ({id,bucket:3,probs:[0,0,0,1],score:1}))};
  }};
  const store = fakeScoreStore(), clear = vi.spyOn(store, "clear"), router = createRouter(client, createSwCache(store));
  let saved: ScoreCacheMode = "session";
  const storage = {getValue: async () => saved, setValue: async (mode: ScoreCacheMode) => { saved = mode; }};
  const modes = createCacheModeController((mode, restored) => applyCacheMode(router, mode, restored), storage);
  vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue([{ id: 1 }] as never);
  const send = vi.spyOn(fakeBrowser.tabs, "sendMessage").mockResolvedValue(undefined);
  const work = router.handle({v:CONTRACT_VERSION,session:"s",priority:"viewport",blocks:[{id:"b0",text:"a paragraph in flight"}]});
  await modes.restore(); answer.resolve();
  expect((await work).results[0].degraded).toBeUndefined();
  await new Promise((r) => setTimeout(r, 10));
  expect(send).not.toHaveBeenCalled(); expect(clear).not.toHaveBeenCalled();
  await modes.change("persistent");
  expect(clear).toHaveBeenCalledOnce();
  expect(send).toHaveBeenCalledWith(1, { action: ACTIONS.CACHE_CLEARED });
});
