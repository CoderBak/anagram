import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCacheModeController } from "../../lib/backend/cacheMode";
import { createSwCache } from "../../lib/backend/swCache";
import type { ScoreCacheMode } from "../../lib/cachePolicy";
import { deferred, fakeScoreStore } from "./scoreStore";

const verdict = {id:"one",bucket:3,probs:[0,0,0,1],score:1};
const dim = '["model","1","none"]';
beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
function setup(initial: ScoreCacheMode = "session") {
  const store = fakeScoreStore(), cache = createSwCache(store);
  let saved = initial;
  const storage = {
    getValue: vi.fn(async () => saved),
    setValue: vi.fn(async (mode: ScoreCacheMode) => { saved = mode; }),
  };
  const apply = vi.fn((mode: ScoreCacheMode) => cache.setMode(mode));
  const modes = createCacheModeController(apply, storage);
  return {store,cache,storage,apply,modes,saved:()=>saved};
}
async function assertNoDiskWrites(env: ReturnType<typeof setup>) {
  const put = vi.spyOn(env.store,"put");
  env.cache.set("must remain in this session",verdict,dim);
  await vi.advanceTimersByTimeAsync(300);
  expect(put).not.toHaveBeenCalled();
  expect(env.store.rows.size).toBe(0);
}

describe("cache-mode preference and runtime coordination", () => {
  it("stays session-only after failed persistent activation and a later successful ordinary clear", async () => {
    const env = setup(); await env.modes.restore();
    const clear = env.store.clear;
    env.store.clear = async () => { throw new Error("IDB deletion blocked"); };
    await expect(env.modes.change("persistent")).rejects.toThrow("IDB deletion blocked");
    expect(env.modes.mode()).toBe("session");
    expect(env.saved()).toBe("session");
    env.store.clear = clear;
    await env.cache.clear(); // A retry must not reopen the failed transition's disk gate.
    await assertNoDiskWrites(env);
  });

  it("does not enable persistence if saving the preference fails", async () => {
    const env = setup(); await env.modes.restore();
    env.apply.mockClear();
    env.storage.setValue.mockRejectedValueOnce(new Error("settings quota"));
    await expect(env.modes.change("persistent")).rejects.toThrow("settings quota");
    expect(env.apply).not.toHaveBeenCalledWith("persistent");
    expect(env.saved()).toBe("session");
    expect(env.modes.mode()).toBe("session");
    await assertNoDiskWrites(env);
  });

  it("reports actual session mode when the safer preference cannot be saved", async () => {
    const env = setup("persistent"); await env.modes.restore();
    env.storage.setValue.mockRejectedValue(new Error("settings unavailable"));
    await expect(env.modes.change("session")).rejects.toThrow("settings unavailable");
    expect(env.saved()).toBe("persistent");
    expect(env.modes.mode()).toBe("session");
    await env.cache.clear();
    await assertNoDiskWrites(env);
  });

  it("re-reads queued storage notifications after rollback instead of replaying stale persistence", async () => {
    const env = setup(); await env.modes.restore();
    const written = deferred<void>(), release = deferred<void>();
    const save = env.storage.setValue.getMockImplementation()!;
    env.storage.setValue.mockImplementationOnce(async (mode) => { await save(mode); written.resolve(); await release.promise; });
    const clear = vi.spyOn(env.store,"clear").mockRejectedValueOnce(new Error("blocked"));
    const changed = env.modes.change("persistent");
    const failed = expect(changed).rejects.toThrow("blocked");
    await written.promise;
    const watched = env.modes.restore(); // event for the attempted persistent write
    release.resolve(); await failed; await watched;
    expect(clear).toHaveBeenCalledTimes(2); // failed persistent clear plus session rollback
    expect(env.apply.mock.calls.filter(([mode]) => mode === "persistent")).toHaveLength(1);
    expect(env.modes.mode()).toBe("session");
    expect(env.saved()).toBe("session");
    await assertNoDiskWrites(env);
  });

  it("does not let a storage watch revive persistence when saving the rollback also fails", async () => {
    const env = setup(); await env.modes.restore();
    const save = env.storage.setValue.getMockImplementation()!;
    env.storage.setValue.mockImplementationOnce(save).mockRejectedValueOnce(new Error("rollback save failed"));
    vi.spyOn(env.store,"clear").mockRejectedValueOnce(new Error("activation failed"));
    await expect(env.modes.change("persistent")).rejects.toThrow("activation failed");
    expect(env.saved()).toBe("persistent");
    await expect(env.modes.restore()).resolves.toBe("session");
    expect(env.modes.mode()).toBe("session");
    await env.cache.clear();
    await assertNoDiskWrites(env);
    // A later explicit retry is allowed to enable persistence after both steps succeed.
    await expect(env.modes.change("persistent")).resolves.toBe("persistent");
    env.cache.set("new explicit persistent choice",verdict,dim);
    await vi.advanceTimersByTimeAsync(300);
    expect(env.store.rows.size).toBe(1);
  });

  it("serializes competing Settings pages including preference writes", async () => {
    const env = setup(); await env.modes.restore();
    const started = deferred<void>(), release = deferred<void>();
    const clear = env.store.clear;
    env.store.clear = async () => { started.resolve(); await release.promise; await clear(); };
    const persistent = env.modes.change("persistent");
    await started.promise;
    const session = env.modes.change("session");
    expect(env.saved()).toBe("persistent");
    release.resolve();
    await expect(persistent).resolves.toBe("persistent");
    await expect(session).resolves.toBe("session");
    expect(env.saved()).toBe("session");
    expect(env.modes.mode()).toBe("session");
    await assertNoDiskWrites(env);
  });

  it("falls back to session-only when restoring the preference fails", async () => {
    const env = setup("persistent");
    env.storage.getValue.mockRejectedValue(new Error("settings unreadable"));
    await expect(env.modes.restore()).rejects.toThrow("settings unreadable");
    expect(env.modes.mode()).toBe("session");
    await assertNoDiskWrites(env);
  });

  it("retries deletion after a failed session transition instead of treating it as confirmed", async () => {
    const env = setup("persistent"); await env.modes.restore();
    const clear = vi.spyOn(env.store,"clear")
      .mockRejectedValueOnce(new Error("blocked"))
      .mockRejectedValueOnce(new Error("still blocked"));
    await expect(env.modes.change("session")).rejects.toThrow("blocked");
    expect(env.modes.mode()).toBe("session");
    await expect(env.modes.change("session")).resolves.toBe("session");
    expect(clear).toHaveBeenCalledTimes(3);
    await assertNoDiskWrites(env);
  });
});
