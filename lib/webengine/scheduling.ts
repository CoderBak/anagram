/** Give queued control messages a turn before another synchronous worker operation. */
export function yieldToMessages(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: {
    postTask?(callback: () => void, options: { priority: "background" }): Promise<void>;
  } }).scheduler;
  // A boosted scheduler.yield() continuation can run ahead of queued messages.
  return scheduler?.postTask ? scheduler.postTask(() => {}, { priority: "background" }) :
    new Promise<void>(resolve => setTimeout(resolve, 0));
}
