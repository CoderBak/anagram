import type { Band } from "../render/band";

export interface ReportEntry {
  id: string;
  score: number;
  band: Band;
  snippet: string;
}

export interface ReportCounts {
  read: number;
  short: number;
  notEnglish: number;
  pending: number;
  unavailable: number;
  lessReliable: number;
}

/** Sent directly to the open toolbar popup; never persisted or sent to the engine. */
export interface PageReport {
  documentId: string;
  visible: boolean;
  counts: ReportCounts;
  entries: ReportEntry[];
  total: number;
  offset: number;
  scopeNote: string;
  commentOrigins: readonly string[];
  pageAction: { id: number; label: string; enabled: boolean } | null;
}

export const REPORT_PAGE_SIZE = 50;

export function reportOffset(requested: number, total: number): number {
  const last = Math.max(0, Math.ceil(total / REPORT_PAGE_SIZE) - 1) * REPORT_PAGE_SIZE;
  return Number.isSafeInteger(requested) ? Math.max(0, Math.min(last, Math.floor(requested / REPORT_PAGE_SIZE) * REPORT_PAGE_SIZE)) : 0;
}
