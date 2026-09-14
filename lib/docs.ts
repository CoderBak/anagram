// lib/docs.ts — Google Docs support via the mobile-basic reading view.
//
// The Docs EDITOR renders text to <canvas> — there is no DOM text to walk, and no
// extension can fix that without the gated Annotated Canvas API. Immersive
// Translate's answer (adopted here): every document also ships a static-HTML
// "mobilebasic" view. On editor pages the FAB offers "Reading view", which swaps
// the tab to /mobilebasic where the normal pipeline just works; there, the FAB
// offers the way back.
//
// Round-trip details verified against a real doc:
// - Docs now have TABS (/edit?tab=t.0). The tab param is forwarded to mobilebasic
//   and the EXACT editor URL is remembered (sessionStorage) so "Back to editor"
//   returns to the same tab instead of a bare /edit.
// - Navigations we initiate carry a #anagram-reading fragment; only then do we
//   apply the reading-mode typography below, so organic mobilebasic visits stay
//   untouched (fragments are client-side only — Google never sees it).

export type DocsKind = "editor" | "reading";

export interface DocsPage {
  kind: DocsKind;
  /** The document id (the /d/<id>/ path segment). */
  id: string;
}

const DOC_PATH_RE = /^\/document\/(?:u\/\d+\/)?d\/([\w-]+)\/(edit|view|preview|mobilebasic)\b/;

/** sessionStorage key holding the editor URL to return to (same-origin, same tab). */
export const DOCS_RETURN_KEY = "anagram-docs-return";

/** Fragment marking a mobilebasic navigation initiated by our button. */
export const READING_MARKER = "anagram-reading";

/** Detect whether `loc` is a Google Docs document page we can act on. */
export function detectDocsPage(loc: Location | URL): DocsPage | null {
  if (loc.hostname !== "docs.google.com") return null;
  const m = loc.pathname.match(DOC_PATH_RE);
  if (!m) return null;
  const [, id, view] = m;
  return { kind: view === "mobilebasic" ? "reading" : "editor", id };
}

/**
 * The static-HTML reading view of a document. Forwards the editor's `tab` param
 * (multi-tab docs) and carries the reading-mode marker fragment.
 */
export function readingViewUrl(id: string, tab?: string | null): string {
  const q = tab ? `?tab=${encodeURIComponent(tab)}` : "";
  return `https://docs.google.com/document/d/${id}/mobilebasic${q}#${READING_MARKER}`;
}

/** The canvas editor view of a document (fallback when no saved return URL). */
export function editorUrl(id: string): string {
  return `https://docs.google.com/document/d/${id}/edit`;
}

/** The `tab` param of the current URL, if any (Docs tabbed documents). */
export function currentTabParam(loc: Location | URL): string | null {
  try {
    return new URL(loc.href).searchParams.get("tab");
  } catch {
    return null;
  }
}

/** True if this mobilebasic visit was initiated by our reading-view button. */
export function isReadingMarked(loc: Location | URL): boolean {
  return loc.hash.includes(READING_MARKER);
}

// ---- reading-mode typography ---------------------------------------------------------
//
// mobilebasic carries ~hundreds of INLINE font-size styles (the doc's own pt
// formatting), so overriding sizes per-rule would flatten the heading hierarchy.
// `zoom` scales the whole content proportionally instead — the doc's typography
// survives, just comfortably larger — plus a centered measure and a paper card.

const DOCS_READING_CSS = `
/* anagram reading mode (only on navigations we initiated) */
body {
  background: #f3f4f6 !important;
}
.doc .doc-content {
  zoom: 1.16;
  max-width: 700px !important;
  margin: 26px auto 110px !important;
  padding: 44px 52px !important;
  box-sizing: border-box;
  background: #fff;
  border-radius: 8px;
  border: 1px solid #e5e5e5;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
@media (max-width: 760px) {
  .doc .doc-content { zoom: 1; padding: 20px 18px !important; margin: 10px auto 90px !important; }
}
`;

let _readingStyleEl: HTMLStyleElement | null = null;

/** Inject the reading-mode stylesheet once (idempotent). */
export function applyDocsReadingStyle(): void {
  if (_readingStyleEl?.isConnected) return;
  const style = document.createElement("style");
  style.setAttribute("data-anagram", "style");
  style.textContent = DOCS_READING_CSS;
  (document.head ?? document.documentElement).appendChild(style);
  _readingStyleEl = style;
}
