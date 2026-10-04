// lib/types.ts — internal shared types.

/**
 * Marker attribute carried ONLY by our own injected UI (chip hosts, the selection card, a
 * surface's layers, the Google Docs reading style). v2 never writes attributes or inline
 * styles onto page elements — the page DOM is untouched apart from inserting chip hosts.
 */
export const MARK_ATTR = "data-anagram"; // values: "host" | "style" (lib/docs.ts) | "marks" (lib/surfaces/)
export type Lane = "viewport" | "near" | "background";
export { type Unit, type UnitPart } from "./dom/text";
