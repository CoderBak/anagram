// lib/quietContext.ts — WXT's content-script context, without its announcement.
//
// WXT builds each isolated-world content script around a ContentScriptContext
// (wxt/utils/content-script-context), whose constructor dispatches a CustomEvent on the
// page's own document named `<extension id>:<entrypoint>:wxt:content-script-started`, so that
// a newer copy of a script can stop an older one. The page hears it: the extension's id, so
// that Anagram is installed; that its site is granted, even with Anagram switched off there;
// and on a site not granted, the moment a one-off action ran. wxt.config.ts points WXT's
// import here instead. Nothing of Anagram's uses the context (ALREADY_RUNNING in
// entrypoints/content.ts keeps a second copy out), so this keeps only what a content script
// could ask of one — an abort signal, invalidation callbacks, timers bound to it — and
// announces nothing.

export class ContentScriptContext {
  readonly id = Math.random().toString(36).slice(2);
  readonly abortController = new AbortController();

  constructor(readonly contentScriptName: string, readonly options?: unknown) {}

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get isInvalid(): boolean {
    return this.signal.aborted;
  }

  get isValid(): boolean {
    return !this.isInvalid;
  }

  abort(reason?: unknown): void {
    this.abortController.abort(reason);
  }

  notifyInvalidated(): void {
    this.abort("Content script context invalidated");
  }

  onInvalidated(callback: () => void): () => void {
    this.signal.addEventListener("abort", callback, { once: true });
    return () => this.signal.removeEventListener("abort", callback);
  }

  block<T>(): Promise<T> {
    return new Promise(() => {});
  }

  setTimeout(handler: () => void, timeout?: number): number {
    const id = setTimeout(() => { if (this.isValid) handler(); }, timeout) as unknown as number;
    this.onInvalidated(() => clearTimeout(id));
    return id;
  }

  setInterval(handler: () => void, timeout?: number): number {
    const id = setInterval(() => { if (this.isValid) handler(); }, timeout) as unknown as number;
    this.onInvalidated(() => clearInterval(id));
    return id;
  }

  requestAnimationFrame(callback: FrameRequestCallback): number {
    const id = requestAnimationFrame((...args) => { if (this.isValid) callback(...args); });
    this.onInvalidated(() => cancelAnimationFrame(id));
    return id;
  }

  addEventListener(target: EventTarget, type: string, handler: EventListenerOrEventListenerObject, options?: AddEventListenerOptions): void {
    target.addEventListener(type, handler, { ...options, signal: this.signal });
  }
}
