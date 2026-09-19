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

/** The slice of pdf.js the reader uses: open a document, read a page's text runs. */
export type PdfJsModule = Pick<typeof import("pdfjs-dist"), "getDocument" | "GlobalWorkerOptions" | "Util">;

export const loadPdfjs = (): Promise<PdfJsModule> => lazyVendor<PdfJsModule>("pdfjs.min.mjs");
