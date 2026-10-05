// lib/stats/chunk.ts — entry point of the reading log's recorder chunk.
//
// scripts/vendor.mjs bundles this into public/vendor/stats.min.mjs, which the content script
// and the PDF reader import by URL only while statistics are on (lib/stats/meter.ts). Like the
// diagnostics and surfaces chunks, it imports no extension API.
export { createRecorder } from "./recorder";
