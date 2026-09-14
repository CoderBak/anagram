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
// The old navigation flow (lib/docs.ts) remains the fallback when the fetch
// fails, and the "Open as page" button in the bar for users who want a real tab.
import type { DOMPurify as Purifier } from "dompurify";
import { loadPurify } from "./lazy";
import { MARK_ATTR } from "./types";
import { adoptHighlightStyles } from "./render/highlight";

export const DOCS_OVERLAY_ID = "anagram-docs-overlay";

export interface DocsOverlayOptions {
  /** Document id (the /d/<id>/ path segment). */
  id: string;
  /** The editor's ?tab= param — multi-tab docs fetch the matching tab. */
  tab: string | null;
  /** Called after the overlay is dismissed (restore the FAB action). */
  onClose?: () => void;
  /** "Open as page" pressed — caller runs the classic navigation flow. */
  onOpenAsPage?: () => void;
}

export interface DocsOverlay {
  /** Fetch + mount. False → fetch failed; caller should fall back to navigating. */
  open(): Promise<boolean>;
  close(): void;
  isOpen(): boolean;
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
  background: rgba(255, 255, 255, 0.92);
  -webkit-backdrop-filter: saturate(1.3) blur(12px);
  backdrop-filter: saturate(1.3) blur(12px);
  border-bottom: 1px solid rgba(15, 23, 42, 0.08);
  box-shadow: 0 1px 8px rgba(15, 23, 42, 0.05);
}
.bar .mark {
  width: 26px;
  height: 26px;
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: linear-gradient(135deg, #6d5efc, #b15efc);
  color: #fff;
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
  border-radius: 12px;
  border: 1px solid rgba(15, 23, 42, 0.05);
  box-shadow: 0 1px 3px rgba(15, 23, 42, 0.07), 0 12px 40px rgba(15, 23, 42, 0.07);
  padding: 52px 58px 64px;
  box-sizing: border-box;
  overflow-wrap: break-word;
}
@media (max-width: 800px) {
  .paperwrap { padding: 12px 8px 90px; }
  .paper { padding: 26px 20px 40px; border-radius: 10px; }
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

export function createDocsOverlay(opts: DocsOverlayOptions): DocsOverlay {
  let host: HTMLElement | null = null;

  function isOpen(): boolean {
    return !!host?.isConnected;
  }

  function close(): void {
    if (!host) return;
    document.removeEventListener("keydown", onKey, true);
    host.remove(); // MutationObserver sees the removal → units purge themselves
    host = null;
    opts.onClose?.();
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }

  async function open(): Promise<boolean> {
    if (isOpen()) return true;

    // 1) fetch the static view of THIS doc, same-origin (editor cookies ride along).
    let html: string;
    try {
      const resp = await fetch(mobilebasicUrl(opts.id, opts.tab), {
        credentials: "same-origin",
      });
      // A login/consent redirect means we cannot read the static view here.
      if (!resp.ok || new URL(resp.url).hostname !== "docs.google.com") return false;
      html = await resp.text();
    } catch {
      return false;
    }

    // 2) parse + extract. mobilebasic wraps the document in .doc-content; the
    //    fetched <style> rules are collected so headings/lists keep their look
    //    (they style class names that exist only inside our shadow root).
    //    DOMPurify is an on-demand vendor chunk — fetched alongside the document.
    let content: Element | null = null;
    let docTitle = "";
    let docCss = "";
    try {
      const { default: DOMPurify } = await loadPurify();
      const parsed = new DOMParser().parseFromString(html, "text/html");
      docTitle = parsed.title.replace(/ - Google Docs$/, "").trim();
      for (const st of parsed.querySelectorAll("style")) docCss += st.textContent ?? "";
      content = parsed.querySelector(".doc-content") ?? parsed.body;
      if (!content || !(content.textContent ?? "").trim()) return false;
      sanitize(DOMPurify, content);
    } catch {
      return false;
    }

    // 3) build the overlay. The HOST intentionally has NO data-anagram marker —
    //    the walker must descend into it; only the bar (our chrome) is marked.
    host = document.createElement("div");
    host.id = DOCS_OVERLAY_ID;
    const shadow = host.attachShadow({ mode: "open" });
    const docStyle = document.createElement("style");
    docStyle.textContent = docCss;
    shadow.adoptedStyleSheets = [overlaySheet()];
    adoptHighlightStyles(shadow); // underline rules must exist in this tree scope

    const ovl = document.createElement("div");
    ovl.className = "ovl";

    const bar = document.createElement("header");
    bar.className = "bar";
    bar.setAttribute(MARK_ATTR, "host"); // our chrome — never scored

    const mark = document.createElement("span");
    mark.className = "mark";
    mark.textContent = "A";

    const titles = document.createElement("div");
    titles.className = "titles";
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = docTitle || "Google Docs document";
    const s = document.createElement("div");
    s.className = "s";
    s.textContent = "Anagram reading mode — every paragraph analyzed · editor untouched behind";
    titles.append(t, s);

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

    bar.append(mark, titles, openPage, closeBtn);

    const paperwrap = document.createElement("div");
    paperwrap.className = "paperwrap";
    const notice = document.createElement("div");
    notice.className = "notice";
    notice.setAttribute(MARK_ATTR, "host");
    notice.textContent =
      "Static snapshot of the document — edits made in the editor appear after reopening.";
    const paper = document.createElement("main");
    paper.className = "paper";
    paper.append(...content.childNodes);
    paperwrap.append(notice, paper);

    ovl.append(bar, paperwrap);
    shadow.append(docStyle, ovl);

    // Below the FAB (2147483647) so the ball + panel stay usable above it.
    host.style.cssText = "position:fixed;inset:0;z-index:2147483645;";
    (document.body ?? document.documentElement).appendChild(host);
    document.addEventListener("keydown", onKey, true);
    // Pull keyboard focus OUT of the editor: Docs focuses a cross-origin iframe
    // whose key events can never reach this document — without this, Esc would
    // silently go to the canvas instead of closing the overlay.
    closeBtn.focus({ preventScroll: true });
    return true;
  }

  return { open, close, isOpen };
}
