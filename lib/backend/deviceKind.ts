// lib/backend/deviceKind.ts — what an engine's device (BackendStatus.server.device) says of
// where it scores: the PDF reader's first guess at its pace (lib/pdf/readAhead.ts), and how
// much a page puts in one request (lib/capture/orchestrator.ts).

/** "gpu" for a graphics card or the local engine's accelerators, "cpu" for the processor,
 *  null where the device says neither. */
export function deviceKind(device: string | undefined): "gpu" | "cpu" | null {
  if (!device) return null;
  if (/gpu|cuda|mps|metal|rocm|directml|dml/iu.test(device)) return "gpu";
  if (/cpu|wasm/iu.test(device)) return "cpu";
  return null;
}
