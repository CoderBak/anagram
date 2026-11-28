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
import { currentTabParam } from "./docs";
import { messageLocale, t } from "./i18n";
import { MARK_ATTR } from "./types";
import { highlightSheets } from "./render/highlight";
import { logoImage } from "./render/logo";

export const DOCS_OVERLAY_ID = "anagram-docs-overlay";

/** How the static view is fetched. Injected by tests, which have no Google Doc. */
export type DocsFetch = (url: string) => Promise<Response>;

export interface DocsOverlayOptions {
  /** Document id (the /d/<id>/ path segment). */
  id: string;
  /** Called after the overlay is dismissed (restore the FAB action). */
  onClose?: () => void;
  /** "Open as page" pressed — caller runs the classic navigation flow. */
  onOpenAsPage?: (tab: string | null) => void;
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
  width: 100%;
  height: 100%;
  max-width: none;
  max-height: none;
  margin: 0;
  padding: 0;
  border: 0;
  box-sizing: border-box;
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
  flex-wrap: wrap;
  gap: 8px 12px;
  padding: 10px 18px;
  background: #ffffff;
  border-bottom: 1px solid #e5e5e5;
}
.bar .mark {
  width: 30px;
  height: 30px;
  margin: -2px;
  flex: 0 0 auto;
  display: block;
}
.bar .t {
  flex: 1 1 auto;
  min-width: 0;
  font: 600 14px/1.3 Arial, "Liberation Sans", Helvetica, sans-serif;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.bar :is(button, select) {
  flex: 0 0 auto;
  font: 600 12px/1 Arial, "Liberation Sans", Helvetica, sans-serif;
  border-radius: 8px;
  padding: 7px 13px;
  cursor: pointer;
  border: 1px solid #e5e5e5;
  background: #fff;
  color: #252525;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.05);
}
.bar select {
  max-width: min(22rem, 100%);
  text-overflow: ellipsis;
}
.bar [role="status"] { flex-basis: 100%; font-size: 13px; }
.bar [role="status"]:empty { display: none; }
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

/** Use the names in the Docs sidebar, including any nested tabs it exposes. */
function editorTabPicker(tab: string | null): HTMLSelectElement | null {
  const picker = document.createElement("select");
  const containerSelector = '[id^="chapter-container-t."]';
  for (const container of document.querySelectorAll(containerSelector)) {
    const item = container.querySelector('[role="treeitem"][aria-label]');
    const name = item?.getAttribute("aria-label")?.trim();
    if (name && item?.closest(containerSelector) === container) {
      picker.add(new Option(name, container.id.slice("chapter-container-".length)));
    }
  }
  if (picker.length < 2) return null;
  if (tab) picker.value = tab;
  if (picker.selectedIndex < 0) return null;
  picker.setAttribute("aria-label", t("docsDocumentTab"));
  return picker;
}

export function createDocsOverlay(opts: DocsOverlayOptions): DocsOverlay {
  let host: HTMLElement | null = null;
  // The parts a refresh writes into; all of them live inside `host`.
  let scroller: HTMLDialogElement | null = null;
  let opening: Promise<boolean> | null = null;
  let paper: HTMLElement | null = null;
  let docStyle: HTMLStyleElement | null = null;
  let titleEl: HTMLElement | null = null;
  let refreshBtn: HTMLButtonElement | null = null;
  let tabPicker: HTMLSelectElement | null = null;
  let notice: HTMLElement | null = null;
  let readerTab: string | null = null;
  let readRequest = 0;

  function isOpen(): boolean {
    return !!host?.isConnected;
  }

  function close(): void {
    if (!host) return;
    if (scroller?.open) scroller.close();
    host.remove(); // MutationObserver sees the removal → units purge themselves
    host = null;
    scroller = null;
    paper = null;
    docStyle = null;
    titleEl = null;
    refreshBtn = null;
    tabPicker = null;
    notice = null;
    opts.onClose?.();
  }

  /** Replacing the paragraphs lets the page observer remove old chips and score the new text. */
  async function readTab(tab: string | null): Promise<boolean> {
    if (!isOpen() || !paper) return false;
    const request = ++readRequest;
    const snapshot = paper;
    const button = refreshBtn;
    if (button) button.disabled = true;
    snapshot.setAttribute("aria-busy", "true");
    if (notice) notice.textContent = tab !== readerTab ? t("actionLoadingDocument") : "";
    try {
      const fresh = await loadDocsContent(opts.id, tab, opts.fetch);
      if (request !== readRequest || snapshot !== paper || !paper.isConnected) return false;
      if (!fresh) {
        if (tabPicker && readerTab) tabPicker.value = readerTab;
        if (notice) notice.textContent = t("docsReadFailed");
        return false;
      }
      const top = scroller?.scrollTop ?? 0;
      const heightBefore = scroller?.scrollHeight ?? 0;
      paper.replaceChildren(...fresh.content.childNodes);
      if (docStyle) docStyle.textContent = fresh.css;
      if (titleEl && fresh.title) titleEl.textContent = fresh.title;
      if (notice) notice.textContent = "";
      // Reading back scrollHeight is what makes the swap laid out; a document that lost
      // a page would otherwise be scrolled to a place that no longer exists.
      if (scroller && tab !== readerTab) scroller.scrollTop = 0;
      else if (scroller && scroller.scrollHeight >= heightBefore) scroller.scrollTop = top;
      readerTab = tab;
      return true;
    } finally {
      if (request === readRequest) {
        snapshot.removeAttribute("aria-busy");
        if (button) button.disabled = false;
      }
    }
  }

  function refresh(): Promise<boolean> {
    return refreshBtn?.disabled ? Promise.resolve(false) : readTab(readerTab);
  }

  function open(): Promise<boolean> {
    if (isOpen()) return Promise.resolve(true);
    opening ??= mount().finally(() => { opening = null; });
    return opening;
  }

  async function mount(): Promise<boolean> {
    let tab: string | null;
    let doc: DocsContent | null;
    // Docs can switch tabs without reloading the editor, even while a request is pending.
    do {
      tab = currentTabParam(location);
      doc = await loadDocsContent(opts.id, tab, opts.fetch);
    } while (tab !== currentTabParam(location));
    if (!doc) return false;

    // Build the overlay. The HOST intentionally has NO data-anagram marker — the
    // walker must descend into it; only the bar (our chrome) is marked.
    host = document.createElement("div");
    host.id = DOCS_OVERLAY_ID;
    const shadow = host.attachShadow({ mode: "open" });
    docStyle = document.createElement("style");
    docStyle.textContent = doc.css;
    // The underline rules must exist in this tree scope too.
    shadow.adoptedStyleSheets = [overlaySheet(), ...highlightSheets()];

    const ovl = document.createElement("dialog");
    ovl.setAttribute("aria-labelledby", "anagram-ovl-title");
    ovl.addEventListener("close", () => { if (scroller === ovl) close(); });
    ovl.className = "ovl";
    // The BAR is ours and speaks the UI's language; the paper below it is the user's
    // document, which keeps whatever language its own markup declares.
    ovl.lang = messageLocale();
    scroller = ovl; // the overlay itself scrolls — a refresh keeps its position

    const bar = document.createElement("header");
    bar.className = "bar";
    bar.setAttribute(MARK_ATTR, "host"); // our chrome — never scored

    // The bar is always white: the light tile.
    const mark = logoImage("light", "mark");

    titleEl = document.createElement("div");
    titleEl.className = "t";
    titleEl.id = "anagram-ovl-title";
    titleEl.textContent = doc.title || t("docsUntitled");
    bar.append(mark, titleEl);
    tabPicker = editorTabPicker(tab);
    readerTab = tabPicker?.value ?? tab;
    if (tabPicker) {
      const picker = tabPicker;
      picker.addEventListener("change", () => void readTab(picker.value));
      bar.append(picker);
    }

    refreshBtn = document.createElement("button");
    refreshBtn.type = "button";
    refreshBtn.id = "anagram-ovl-refresh";
    refreshBtn.textContent = t("docsRefresh");
    refreshBtn.title = t("docsRefreshTitle");
    refreshBtn.addEventListener("click", () => void refresh());

    const openPage = document.createElement("button");
    openPage.type = "button";
    openPage.textContent = t("docsOpenAsPage");
    openPage.title = t("docsOpenAsPageTitle");
    openPage.addEventListener("click", () => {
      const tab = tabPicker?.value ?? readerTab;
      close();
      opts.onOpenAsPage?.(tab);
    });

    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.autofocus = true;
    closeBtn.className = "primary";
    closeBtn.id = "anagram-ovl-close";
    closeBtn.textContent = t("docsBack");
    closeBtn.addEventListener("click", close);

    notice = document.createElement("span");
    notice.setAttribute("role", "status");
    bar.append(refreshBtn, openPage, closeBtn, notice);

    const paperwrap = document.createElement("div");
    paperwrap.className = "paperwrap";
    paper = document.createElement("main");
    paper.className = "paper";
    paper.append(...doc.content.childNodes);
    paperwrap.append(paper);

    ovl.append(bar, paperwrap);
    shadow.append(docStyle, ovl);

    // Leave the shadow host in flow so the document walker can reach the paper.
    (document.body ?? document.documentElement).appendChild(host);
    ovl.showModal();
    return true;
  }

  return { open, refresh, close, isOpen };
}
