// lib/render/logo.ts — the icon as an <img>, for the parts of a page Anagram draws itself
// (the Google Docs overlay's bar). The PNGs under public/icons/ are web
// accessible (wxt.config.ts); the extension's own scheme is not subject to a page's CSP, so
// a strict img-src cannot blank the reading bar's icon.
import { browser } from "#imports";
import type { PublicPath } from "wxt/browser";

/** The light tile for light surfaces, the dark tile for dark ones (96 px: sharp at 2x). */
export function logoImage(tile: "light" | "dark", className: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  img.draggable = false;
  img.src = browser.runtime.getURL(`/icons/${tile === "dark" ? "icon" : "icon-light"}-96.png` as PublicPath);
  return img;
}
