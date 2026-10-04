// lib/render/logo.ts — the icon as an <img>, for the parts of a page Anagram draws itself
// (the Google Docs overlay's bar). Inlined as a data: URL, not loaded from the extension: an
// extension URL in the page's DOM names the extension to the page, and in Firefox, whose
// moz-extension address is drawn once per install, names this very installation — an
// identifier the site could keep across private windows and accounts.
import lightTile from "../../public/icons/icon-light-96.png?inline";

/** The light tile (96 px: sharp at 2x). */
export function logoImage(_tile: "light", className: string): HTMLImageElement {
  const img = document.createElement("img");
  img.className = className;
  img.alt = "";
  img.draggable = false;
  img.src = lightTile;
  return img;
}
