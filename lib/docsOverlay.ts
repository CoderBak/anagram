// lib/docsOverlay.ts — Google Docs IN-TAB analysis overlay ("reading mode").
//
// The Docs editor renders text to <canvas>; no extension can score it in place.
// v2 answered with a NAVIGATION to the static /mobilebasic view. v3 does what
// Immersive Translate's button does: stays in the tab. We fetch the mobilebasic
// HTML same-origin (the content script shares docs.google.com's origin and
// cookies), sanitize it, and render it as a full-screen reader overlay INSIDE
// the editor tab. Closing the overlay is instant — the editor never unloaded,
// no state was lost, no navigation happened.
//
// Scoring comes free: the overlay content is ordinary DOM inside a shadow root
// WITHOUT our data-anagram marker, so the page's MutationObserver sees the host
// arrive, the walker descends the composed tree, and the normal pipeline badges
// every paragraph — same chips, same underlines (the shadow root adopts the
// ::highlight rules), same FAB counter and triage panel. Only the overlay's own
// chrome (the top bar) carries MARK_ATTR so it is never scored.
//
// The overlay is a SNAPSHOT of the document, so the bar carries a "Refresh" that
// reads it again and swaps the paper's content: the old nodes leave, their chips and
// marks with them, the new ones arrive and are analyzed like any other text — the
// ordinary purge-and-rescan the observer already does for every page that rewrites
// itself. Nothing else about the overlay is rebuilt.
//
// The old navigation flow (lib/docs.ts) remains the fallback when the fetch
// fails, and the "Open as page" button in the bar for users who want a real tab.
import type { DOMPurify as Purifier } from "dompurify";
import { loadPurify } from "./lazy";
import { MARK_ATTR } from "./types";
import { adoptHighlightStyles } from "./render/highlight";

export const DOCS_OVERLAY_ID = "anagram-docs-overlay";

/** How the static view is fetched. Injected by tests, which have no Google Doc. */
export type DocsFetch = (url: string) => Promise<Response>;

export interface DocsOverlayOptions {
  /** Document id (the /d/<id>/ path segment). */
  id: string;
  /** The editor's ?tab= param — multi-tab docs fetch the matching tab. */
  tab: string | null;
  /** Called after the overlay is dismissed (restore the FAB action). */
  onClose?: () => void;
  /** "Open as page" pressed — caller runs the classic navigation flow. */
  onOpenAsPage?: () => void;
  /** Replaces the same-origin fetch of the static view (tests). */
  fetch?: DocsFetch;
}

export interface DocsOverlay {
  /** Fetch + mount. False → fetch failed; caller should fall back to navigating. */
  open(): Promise<boolean>;
  /** Re-fetch the document and swap the paper's content. False → the old content stays. */
  refresh(): Promise<boolean>;
  close(): void;
  isOpen(): boolean;
}

/** One reading of the static view: the document, its own styles and its title. */
export interface DocsContent {
  title: string;
  /** The document's own <style> rules, for the shadow root. */
  css: string;
  /** A detached element whose children are the sanitized document. */
  content: Element;
}

const OVERLAY_CSS = `
.ovl {
  position: fixed;
  inset: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  background: rgba(241, 243, 244, 0.99);
  font: 15px/1.6 Arial, "Helvetica Neue", sans-serif;
  color: #1f2328;
  animation: anagram-ovl-in 180ms ease-out both;
}
@keyframes anagram-ovl-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) { .ovl { animation: none; } }

.bar {
  position: sticky;
  top: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 18px;
  background: #ffffff;
  border-bottom: 1px solid #e5e5e5;
}
.bar .mark {
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  background: #171717;
  color: #fafafa;
  font: 700 13px/1 ui-sans-serif, system-ui, sans-serif;
}
.bar .titles { flex: 1 1 auto; min-width: 0; }
.bar .t {
  font: 600 14px/1.3 ui-sans-serif, system-ui, sans-serif;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar .s { font: 400 11px/1.3 ui-sans-serif, system-ui, sans-serif; color: #656d76; }
.bar button {
  flex: 0 0 auto;
  font: 600 12px/1 ui-sans-serif, system-ui, sans-serif;
  border-radius: 8px;
  padding: 7px 13px;
  cursor: pointer;
  border: 1px solid #e5e5e5;
  background: #fff;
  color: #252525;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
.bar button:hover { background: #f5f5f5; }
.bar button.primary {
  background: #171717;
  border-color: transparent;
  color: #fafafa;
}
.bar button.primary:hover { background: #333333; }

.paperwrap { padding: 26px 16px 120px; }
.paper {
  max-width: 760px;
  margin: 0 auto;
  background: #fff;
  border-radius: 8px;
  border: 1px solid #e5e5e5;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
  padding: 52px 58px 64px;
  box-sizing: border-box;
  overflow-wrap: break-word;
}
@media (max-width: 800px) {
  .paperwrap { padding: 12px 8px 90px; }
  .paper { padding: 26px 20px 40px; border-radius: 8px; }
}
.paper img { max-width: 100%; height: auto; }
.paper table { max-width: 100%; }

.notice {
  max-width: 760px;
  margin: 0 auto 14px;
  font: 400 12px/1.5 ui-sans-serif, system-ui, sans-serif;
  color: #656d76;
  text-align: center;
}
`;

let _sheet: CSSStyleSheet | null = null;
function overlaySheet(): CSSStyleSheet {
  if (!_sheet) {
    _sheet = new CSSStyleSheet();
    _sheet.replaceSync(OVERLAY_CSS);
  }
  return _sheet;
}

/** The mobilebasic URL for a doc (+tab); fetched same-origin with cookies. */
function mobilebasicUrl(id: string, tab: string | null): string {
  const q = tab ? `?tab=${encodeURIComponent(tab)}` : "";
  return `https://docs.google.com/document/d/${id}/mobilebasic${q}`;
}

/**
 * DOMPurify, in place. Its defaults already drop scripts, event handlers, javascript:
 * URLs, iframes/objects/embeds and the other active vectors; on top of that we forbid
 * document-level and form machinery. The document's own <style> rules are collected
 * separately and injected into the shadow root, so they are stripped here too.
 */
function sanitize(DOMPurify: Purifier, root: Element): void {
  DOMPurify.sanitize(root, {
    IN_PLACE: true,
    FORBID_TAGS: ["style", "link", "meta", "base", "form"],
    ALLOW_DATA_ATTR: false,
  });
}

/** The editor's own fetch of the static view: same origin, editor cookies along. */
const sameOriginFetch: DocsFetch = (url) => fetch(url, { credentials: "same-origin" });

/**
 * Read the static view of a document once: fetch it, parse it, keep its own styles and
 * sanitize its body. Null whenever the document cannot be read — a login or consent
 * redirect, an error status, a body without text — and the caller keeps whatever it has
 * (the navigation fallback on open, the previous snapshot on refresh).
 *
 * Both openings go through here, so a refreshed document is sanitized exactly as the
 * first one was, and a test can drive the whole step with a fetcher of its own.
 */
export async function loadDocsContent(
  id: string,
  tab: string | null,
  doFetch: DocsFetch = sameOriginFetch,
): Promise<DocsContent | null> {
  let html: string;
  try {
    const resp = await doFetch(mobilebasicUrl(id, tab));
    // A login/consent redirect means we cannot read the static view here.
    if (!resp.ok || new URL(resp.url).hostname !== "docs.google.com") return null;
    html = await resp.text();
  } catch {
    return null;
  }

  // mobilebasic wraps the document in .doc-content; the fetched <style> rules are
  // collected so headings/lists keep their look (they style class names that exist only
  // inside our shadow root). DOMPurify is an on-demand vendor chunk — fetched alongside
  // the document.
  try {
    const { default: DOMPurify } = await loadPurify();
    const parsed = new DOMParser().parseFromString(html, "text/html");
    let css = "";
    for (const st of parsed.querySelectorAll("style")) css += st.textContent ?? "";
    const content = parsed.querySelector(".doc-content") ?? parsed.body;
    if (!content || !(content.textContent ?? "").trim()) return null;
    sanitize(DOMPurify, content);
    return { title: parsed.title.replace(/ - Google Docs$/, "").trim(), css, content };
  } catch {
    return null;
  }
}

export function createDocsOverlay(opts: DocsOverlayOptions): DocsOverlay {
  let host: HTMLElement | null = null;
  // The parts a refresh writes into; all of them live inside `host`.
  let scroller: HTMLElement | null = null;
  let paper: HTMLElement | null = null;
  let docStyle: HTMLStyleElement | null = null;
  let titleEl: HTMLElement | null = null;
  let refreshBtn: HTMLButtonElement | null = null;

  function isOpen(): boolean {
    return !!host?.isConnected;
  }

  function close(): void {
    if (!host) return;
    document.removeEventListener("keydown", onKey, true);
    host.remove(); // MutationObserver sees the removal → units purge themselves
    host = null;
    scroller = null;
    paper = null;
    docStyle = null;
    titleEl = null;
    refreshBtn = null;
    opts.onClose?.();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }

  /**
   * Re-read the document and swap the paper's content in place. The page's
   * MutationObserver sees the old nodes leave — their chips and marks with them — and
   * the new ones arrive, so the units purge and re-form by themselves; nothing here
   * touches the overlay's own chrome, so no second bar or host can appear. A failed
   * read leaves the snapshot that is on screen exactly as it was.
   */
  async function refresh(): Promise<boolean> {
    if (!isOpen() || !paper || refreshBtn?.disabled) return false;
    if (refreshBtn) refreshBtn.disabled = true;
    try {
      const fresh = await loadDocsContent(opts.id, opts.tab, opts.fetch);
      // Closed (or reopened) while the fetch was in flight — that document is not ours.
      if (!fresh || !paper?.isConnected) return false;
      const top = scroller?.scrollTop ?? 0;
      const heightBefore = scroller?.scrollHeight ?? 0;
      paper.replaceChildren(...fresh.content.childNodes);
      if (docStyle) docStyle.textContent = fresh.css;
      if (titleEl && fresh.title) titleEl.textContent = fresh.title;
      // Reading back scrollHeight is what makes the swap laid out; a document that lost
      // a page would otherwise be scrolled to a place that no longer exists.
      if (scroller && scroller.scrollHeight >= heightBefore) scroller.scrollTop = top;
      return true;
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  async function open(): Promise<boolean> {
    if (isOpen()) return true;

    const doc = await loadDocsContent(opts.id, opts.tab, opts.fetch);
    if (!doc) return false;

    // Build the overlay. The HOST intentionally has NO data-anagram marker — the
    // walker must descend into it; only the bar (our chrome) is marked.
    host = document.createElement("div");
    host.id = DOCS_OVERLAY_ID;
    const shadow = host.attachShadow({ mode: "open" });
    docStyle = document.createElement("style");
    docStyle.textContent = doc.css;
    shadow.adoptedStyleSheets = [overlaySheet()];
    adoptHighlightStyles(shadow); // underline rules must exist in this tree scope

    const ovl = document.createElement("div");
    ovl.className = "ovl";
    scroller = ovl; // the overlay itself scrolls — a refresh keeps its position

    const bar = document.createElement("header");
    bar.className = "bar";
    bar.setAttribute(MARK_ATTR, "host"); // our chrome — never scored

    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = "A";

    const titles = document.createElement("div");
    titles.className = "titles";
    titleEl = document.createElement("div");
    titleEl.className = "t";
    titleEl.textContent = doc.title || "Google Docs document";
    const s = document.createElement("div");
    s.className = "s";
    s.textContent = "Anagram reading mode — every paragraph analyzed · editor untouched behind";
    titles.append(titleEl, s);

    refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.id = "anagram-ovl-refresh";
    refreshBtn.textContent = "Refresh";
    refreshBtn.title = "Read the document again, with the edits made since it opened";
    refreshBtn.addEventListener("click", () => void refresh());

    const openPage = document.createElement("button");
    openPage.type = "button";
    openPage.textContent = "Open as page";
    openPage.title = "Open the analyzed reading view as its own page";
    openPage.addEventListener("click", () => {
      close();
      opts.onOpenAsPage?.();
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "primary";
    closeBtn.id = "anagram-ovl-close";
    closeBtn.textContent = "Back to editor · Esc";
    closeBtn.addEventListener("click", close);

    bar.append(mark, titles, refreshBtn, openPage, closeBtn);

    const paperwrap = document.createElement("div");
    paperwrap.className = "paperwrap";
    const notice = document.createElement("div");
    notice.className = "notice";
    notice.setAttribute(MARK_ATTR, "host");
    notice.textContent = "Static snapshot of the document — Refresh reads it again.";
    paper = document.createElement("main");
    paper.className = "paper";
    paper.append(...doc.content.childNodes);
    paperwrap.append(notice, paper);

    ovl.append(bar, paperwrap);
    shadow.append(docStyle, ovl);

    // Below the FAB (2147483647) so the ball + panel stay usable above it. The HOST
    // itself stays IN FLOW (it has no size — .ovl inside is the fixed full-screen
    // layer): the walker drops a small out-of-flow box as a decoration, and a shadow
    // host's own textContent is empty however much its shadow tree holds, so a fixed
    // host made the whole document invisible to the scan.
    host.style.cssText = "position:relative;z-index:2147483645;";
    (document.body ?? document.documentElement).appendChild(host);
    document.addEventListener("keydown", onKey, true);
    // Pull keyboard focus OUT of the editor: Docs focuses a cross-origin iframe
    // whose key events can never reach this document — without this, Esc would
    // silently go to the canvas instead of closing the overlay.
    closeBtn.focus({ preventScroll: true });
    return true;
  }

  return { open, refresh, close, isOpen };
}
