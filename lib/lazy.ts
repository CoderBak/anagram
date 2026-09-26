// lib/lazy.ts — on-demand vendor chunks.
//
// Content scripts are bundled as one IIFE that runs on every page, so libraries a
// feature needs only sometimes (Readability for the main-content scope, DOMPurify for
// the Google Docs reading mode, pdf.js for the PDF reader) are kept out of it.
// scripts/vendor.mjs prebuilds them as minified ESM files under public/vendor/
// (web-accessible resources) and this helper imports one by its extension URL the first
// time it is needed, once per frame.
import { browser } from "#imports";
import type { PublicPath } from "wxt/browser";

const _loaded = new Map<string, Promise<unknown>>();

export function lazyVendor<T>(file: string): Promise<T> {
  let p = _loaded.get(file);
  if (!p) {
    const url = browser.runtime.getURL(`/vendor/${file}` as PublicPath);
    p = import(/* @vite-ignore */ url);
    _loaded.set(file, p);
  }
  return p as Promise<T>;
}

export interface ReadabilityModule {
  Readability: typeof import("@mozilla/readability").Readability;
  isProbablyReaderable: typeof import("@mozilla/readability").isProbablyReaderable;
}

export const loadReadability = (): Promise<ReadabilityModule> =>
  lazyVendor<ReadabilityModule>("readability.min.mjs");

export const loadPurify = (): Promise<{ default: import("dompurify").DOMPurify }> =>
  lazyVendor("purify.min.mjs");

/**
 * The page diagnostics (the "Copy page diagnostics" menu entry). Unlike the vendored
 * chunks this one is OUR code — the segmentation modules plus the report builder — kept
 * out of the content script for the same reason: it is twenty kilobytes that almost every
 * page would carry and never run. It is rebuilt from source before every build and on install,
 * so its copy of the walk can never explain a page by yesterday's rules.
 */
export interface DiagnosticsModule {
  buildDiagnostics: (env: import("./diagnostics/report").DiagnosticsEnv) => Promise<string>;
}

export const loadDiagnostics = (): Promise<DiagnosticsModule> =>
  lazyVendor<DiagnosticsModule>("diagnostics.min.mjs");

/**
 * The reading of the few sites that show a document the walk cannot read (lib/surfaces/).
 * Our own code too, and out of the content script for the same reason as the diagnostics:
 * it carries the PDF reader's paragraph rebuilder, which only those sites need.
 */
export interface SurfacesModule {
  createSurface: typeof import("./surfaces/chunk").createSurface;
}

export const loadSurfaces = (): Promise<SurfacesModule> => lazyVendor<SurfacesModule>("surfaces.min.mjs");

/** Engine API used alongside the separately packaged full upstream viewer. */
export type PdfJsModule = Pick<
  typeof import("pdfjs-dist"),
  "getDocument" | "GlobalWorkerOptions" | "Util"
>;

export const loadPdfjs = (): Promise<PdfJsModule> => lazyVendor<PdfJsModule>("pdfjs.min.mjs");
