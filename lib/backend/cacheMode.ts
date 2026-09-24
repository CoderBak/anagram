import type { ScoreCacheMode } from "../cachePolicy";

interface ModeStorage {
  getValue(): Promise<ScoreCacheMode>;
  setValue(mode: ScoreCacheMode): Promise<void>;
}

/** Serialize runtime and preference changes; an uncommitted change never enables disk writes. */
export function createCacheModeController(
  applyMode: (mode: ScoreCacheMode, restored: boolean) => Promise<void>,
  storage: ModeStorage,
) {
  let actual: ScoreCacheMode | undefined;
  let confirmed = false;
  let persistenceBlocked = false;
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = (task: () => Promise<ScoreCacheMode>): Promise<ScoreCacheMode> => {
    const result = tail.then(task, task);
    tail = result.catch(() => undefined);
    return result;
  };
  async function apply(mode: ScoreCacheMode): Promise<void> {
    if (actual === mode && confirmed) return;
    // A worker's first mode is the one it had before it slept, not a change: nothing it
    // or a tab holds was made under another mode, so nothing is cleared.
    const restored = actual === undefined;
    // The cache switches its disk gate synchronously, before deletion can fail.
    actual = mode;
    confirmed = false;
    await applyMode(mode, restored);
    confirmed = true;
  }
  async function rollback(save: boolean): Promise<void> {
    persistenceBlocked = true;
    try { await apply("session"); } catch { /* disk deletion may still fail; writes stay disabled */ }
    if (save) {
      try { await storage.setValue("session"); } catch { /* report the failure with the actual mode */ }
    }
  }
  return {
    mode: (): ScoreCacheMode => actual ?? "session",
    /** Re-read when this job runs: a queued storage event may precede a rollback. */
    restore(): Promise<ScoreCacheMode> {
      return serialize(async () => {
        let wanted: ScoreCacheMode;
        try {
          wanted = await storage.getValue();
          if (wanted !== "session" && wanted !== "persistent") throw new Error("Invalid cache mode");
        } catch (error) { await rollback(false); throw error; }
        // A failed rollback save may leave an old persistent value in storage.
        // Only a new explicit change may enable it again during this worker lifetime.
        const target = persistenceBlocked && wanted === "persistent" ? "session" : wanted;
        try { await apply(target); }
        catch (error) {
          // Do not repeatedly write an unchanged session value from storage watches.
          await rollback(wanted !== "session");
          throw error;
        }
        return target;
      });
    },
    change(wanted: ScoreCacheMode): Promise<ScoreCacheMode> {
      return serialize(async () => {
        try {
          // Saving permission to persist must succeed before opening the disk gate.
          if (wanted === "persistent") await storage.setValue(wanted);
          await apply(wanted);
          if (wanted === "session") await storage.setValue(wanted);
          persistenceBlocked = false;
          return wanted;
        } catch (error) {
          await rollback(true);
          throw error;
        }
      });
    },
  };
}
