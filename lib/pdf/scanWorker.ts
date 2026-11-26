import { prepareBatch, type ReflowBatch } from "./reflowScan";
import type { PdfPageText, ReflowTypography } from "./reflow";

let worker: Worker | null = null;
let cancel: (() => void) | null = null;

export function stopScanWorker(): void {
  worker?.terminate();
  worker = null;
  cancel?.();
  cancel = null;
}

/** One batch at a time, on a worker reused until this document is closed or fully
 *  prepared. Older browsers can still read the same batch on the reader thread. */
export async function readScanBatch(pages: PdfPageText[], compoundHeads: readonly string[], typography: ReflowTypography): Promise<ReflowBatch> {
  try {
    worker ??= new Worker(new URL("./scan.worker.ts", import.meta.url), {type: "module", name: "anagram-pdf-reflow"});
    const w = worker;
    return await new Promise<ReflowBatch>((resolve, reject) => {
      cancel = () => reject(new DOMException("Document closed", "AbortError"));
      w.onerror = w.onmessageerror = () => reject(new Error("PDF worker failed"));
      w.onmessage = (event: MessageEvent<ReflowBatch>) => resolve(event.data);
      w.postMessage({pages, compoundHeads, typography});
    }).finally(() => {
      if (worker === w) cancel = null;
      w.onmessage = w.onerror = w.onmessageerror = null;
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    stopScanWorker();
    return prepareBatch(pages, compoundHeads, typography);
  }
}
