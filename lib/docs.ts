// lib/docs.ts — Google Docs support via the mobile-basic reading view.
//
// The Docs EDITOR renders text to <canvas> — there is no DOM text to walk, and no
// extension can fix that without the gated Annotated Canvas API. Immersive
// Translate's answer (adopted here): every document also ships a static-HTML
// "mobilebasic" view. On editor pages the FAB offers "Reading view", which swaps
// the tab to /mobilebasic where the normal pipeline just works; there, the FAB
// offers the way back to the editor.

export type DocsKind = "editor" | "reading";

export interface DocsPage {
  kind: DocsKind;
  /** The document id (the /d/<id>/ path segment). */
  id: string;
}

const DOC_PATH_RE = /^\/document\/(?:u\/\d+\/)?d\/([\w-]+)\/(edit|view|preview|mobilebasic)\b/;

/** Detect whether `loc` is a Google Docs document page we can act on. */
export function detectDocsPage(loc: Location | URL): DocsPage | null {
  if (loc.hostname !== "docs.google.com") return null;
  const m = loc.pathname.match(DOC_PATH_RE);
  if (!m) return null;
  const [, id, view] = m;
  return { kind: view === "mobilebasic" ? "reading" : "editor", id };
}

/** The static-HTML reading view of a document. */
export function readingViewUrl(id: string): string {
  return `https://docs.google.com/document/d/${id}/mobilebasic`;
}

/** The canvas editor view of a document. */
export function editorUrl(id: string): string {
  return `https://docs.google.com/document/d/${id}/edit`;
}
