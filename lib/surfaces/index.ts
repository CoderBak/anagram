// lib/surfaces/index.ts — which pages show a document the walk cannot read, and what the
// page's pipeline is given for them.
//
// Deciding costs a comparison of the address and, where that says nothing, one look for a
// pdf.js viewer, so an ordinary page pays nothing: the surface itself is an on-demand chunk
// (lib/surfaces/chunk.ts, loaded by lib/surfaces/load.ts) only where this answers. What the
// orchestrator gets back is its ordinary hooks — where units come from, where a chip goes,
// how a stretch is found and marked — each of which leaves every unit that is not the
// surface's own to the page's usual handling, and the page is walked as always while the
// document is not on it.
import type { OrchestratorOptions } from "../capture/orchestrator";
import { collectUnits } from "../dom/walker";
import type { MarkPainter, RangeLocator } from "../render/highlight";
import type { Surface } from "./types";

/**
 * "drive": Google Drive's file preview — drive.google.com, and the same viewer on
 * docs.google.com. "pdfjs": a PDF shown by pdf.js inside a page — OneDrive's preview of a PDF,
 * and any page carrying pdf.js's own viewer.
 */
export type SurfaceId = "drive" | "pdfjs";

/** The viewer's addresses on docs.google.com: a file (/file/d/…) and the URL viewer. The
 *  Docs editor (/document/d/…) is lib/docs.ts's. */
const DOCS_VIEWER = /^\/(?:a\/[^/]+\/)?(?:file\/d\/|viewerng\b|viewer\b)/;

/** OneDrive, personal and for work or school (SharePoint), previews a PDF with pdf.js. */
function isOneDrive(host: string): boolean {
  return host === "onedrive.live.com" || host.endsWith(".sharepoint.com");
}

export function surfaceFor(
  loc: { hostname: string; pathname: string },
  doc?: Pick<Document, "querySelector">,
): SurfaceId | null {
  if (loc.hostname === "drive.google.com") return "drive";
  if (loc.hostname === "docs.google.com" && DOCS_VIEWER.test(loc.pathname)) return "drive";
  if (isOneDrive(loc.hostname)) return "pdfjs";
  // pdf.js's viewer page sets its pages in `.pdfViewer` from the start.
  if (doc?.querySelector(".pdfViewer")) return "pdfjs";
  return null;
}

/** A surface, in the orchestrator's and the marks' own terms. */
export interface PageSurface {
  collect: NonNullable<OrchestratorOptions["collect"]>;
  placeBadge: NonNullable<OrchestratorOptions["placeBadge"]>;
  ranges: RangeLocator;
  painter: MarkPainter;
}

export function asPageSurface(surface: Surface): PageSurface {
  return {
    collect: (root, claim, opts) =>
      surface.active() ? surface.collect(claim, opts.mergeShorts ?? true) : collectUnits(root, opts),
    placeBadge: (unit, host) => surface.place(unit, host),
    ranges: (unit, spans) => surface.ranges(unit, spans),
    painter: surface.painter,
  };
}
