import type { ScanPriority } from "../contract";

/** Give queued control messages a turn before another synchronous worker operation. */
export function yieldToMessages(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: {
    postTask?(callback: () => void, options: { priority: "background" }): Promise<void>;
  } }).scheduler;
  // A boosted scheduler.yield() continuation can run ahead of queued messages.
  return scheduler?.postTask ? scheduler.postTask(() => {}, { priority: "background" }) :
    new Promise<void>(resolve => setTimeout(resolve, 0));
}

const rank = { viewport: 2, near: 1, background: 0 };

/** One inference at a time. Every fifth turn serves the oldest waiting pass so a paused
 * document continues to advance under continuous viewport requests. */
export class InferencePassQueue {
  private turn = 0;
  private busy = false;
  private waiting: { rank: number; yieldBefore: boolean; start(): void }[] = [];

  run<T>(priority: ScanPriority, work: () => Promise<T>, yieldBefore = true): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.waiting.push({ rank: rank[priority], yieldBefore, start: () => {
        void Promise.resolve().then(work).then(resolve, reject).finally(() => {
          this.busy = false;
          this.next();
        });
      } });
      this.next();
    });
  }

  private next(): void {
    if (this.busy || !this.waiting.length) return;
    this.busy = true;
    // Read pending request and cancellation messages before choosing the next model pass.
    if (this.waiting[0]!.yieldBefore) void yieldToMessages().then(() => this.dispatch());
    else this.dispatch();
  }

  private dispatch(): void {
    let index = 0;
    if (this.turn % 5 !== 0) {
      this.waiting.forEach((pass, i) => { if (pass.rank > this.waiting[index]!.rank) index = i; });
    }
    this.turn++;
    this.waiting.splice(index, 1)[0]!.start();
  }
}
