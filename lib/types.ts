// lib/types.ts — internal shared types.

/**
 * Marker attribute carried ONLY by our own injected UI (badge hosts, the FAB, the
 * highlight <style>). v2 never writes attributes or inline styles onto page
 * elements — the page DOM is untouched apart from inserting badge hosts.
 */
export const MARK_ATTR = "data-pangram"; // values: "host" | "style"
export type Lane = "viewport" | "near" | "background";
export type ScanEpoch = number;
export { type Unit, type UnitPart } from "./dom/text";
