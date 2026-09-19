// lib/diagnostics/chunk.ts — entry point of the on-demand diagnostics chunk.
//
// scripts/vendor.mjs bundles this into public/vendor/diagnostics.min.mjs, a web-accessible
// ESM file the content script imports by URL the first time somebody uses "Copy page
// diagnostics" (lib/lazy.ts). It carries its own copy of the segmentation code, which is
// the point: the report has to be able to re-run the walk, and the content script must not
// grow by twenty kilobytes for a menu entry most pages never see. The chunk is rebuilt
// before every build and on install, so its copy is never older than the source it
// explains.
export { buildDiagnostics } from "./report";
export type { DiagnosticsEnv, DaemonFacts } from "./report";
