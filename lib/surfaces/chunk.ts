// lib/surfaces/chunk.ts — entry point of the on-demand surfaces chunk.
//
// scripts/vendor.mjs bundles this into public/vendor/surfaces.min.mjs, which the content
// script imports by URL only on a page that has a surface (lib/surfaces/index.ts). The
// paragraph rebuilder it carries is the PDF reader's, twelve kilobytes that no ordinary page
// should parse. Like the diagnostics chunk it imports no extension API.
import type { SurfaceId } from "./index";
import type { Surface } from "./types";
import { createLineLayerSurface } from "./lineLayer";
import { createDriveSource } from "./drive";
import { createPdfjsSource } from "./pdfjs";

export function createSurface(id: SurfaceId, doc: Document): Surface | null {
  switch (id) {
    case "drive":
      return createLineLayerSurface(createDriveSource(doc));
    case "pdfjs":
      return createLineLayerSurface(createPdfjsSource(doc));
    default:
      return null;
  }
}
