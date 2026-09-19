// lib/ui/localize.ts — the extension pages' half of the translation.
//
// The English stays IN the HTML. Nothing flashes, the pages read correctly with the
// script disabled, and a diff of the markup still shows the words. Each element that
// carries text names its key instead:
//
//   <h2 data-i18n="optDetection">Detection</h2>
//   <button data-i18n-title="popupAllSettings" data-i18n-aria-label="popupAllSettings">
//
// `data-i18n-placeholder` does the same for an input's placeholder. No field carries one
// today — both of ours hold a literal example ("example.com", a loopback URL), which is
// the same in every language — but a translatable placeholder is one attribute away.
//
// A sentence with markup in it — a <code> command, a <kbd> key, an emphasised word —
// keeps the markup in the page and names a key whose message has $1…$9 where those
// elements go:
//
//   <p data-i18n-html="optPrivacy">Nothing leaves … the local <code>anagramd</code> daemon…</p>
//
// The parts are the container's OWN element children, in order: the substitution can only
// ever put back an element the page already had, so no message is ever parsed as markup
// and nothing here goes near innerHTML. A translator is free to reorder them, which is
// the whole reason the sentence is one message rather than three fragments.
import { messageLocale, t, type MessageKey } from "../i18n";

/**
 * The substitutions that ask the platform to leave the placeholders alone. `getMessage`
 * fills every $1…$9 it finds, with an EMPTY string when it was given nothing — so a
 * message whose placeholders stand for elements rather than text has to be handed each
 * marker back as its own value, and comes out with them intact for applyParts to split on.
 */
const MARKERS = ["$1", "$2", "$3", "$4", "$5", "$6", "$7", "$8", "$9"];

/** Rebuild `el` from its message, threading its existing children in at $1…$9. */
function applyParts(el: HTMLElement, key: MessageKey): void {
  const parts = [...el.children];
  const message = t(key, ...MARKERS);
  const out = document.createDocumentFragment();
  let cut = 0;
  for (const m of message.matchAll(/\$([1-9])/g)) {
    const part = parts[Number(m[1]) - 1];
    if (!part) continue; // the message wants a part this page does not have — leave the $n
    if (m.index > cut) out.append(message.slice(cut, m.index));
    out.append(part); // moved, not cloned: the page's own element, with its own listeners
    cut = m.index + m[0].length;
  }
  if (cut < message.length) out.append(message.slice(cut));
  el.replaceChildren(out);
}

/**
 * Translate the page in place. Called first thing in every page's main.ts — before any
 * of its own rendering, so nothing is written twice.
 *
 * An English UI leaves the markup untouched: the page already says the right thing, and
 * not touching it is also the guarantee that the two can never disagree.
 */
export function localizePage(): void {
  const locale = messageLocale();
  // Always: the document has to declare what it is in, for screen readers and for the
  // font the browser picks for CJK.
  document.documentElement.lang = locale;
  if (locale === "en") return;

  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n]")) {
    el.textContent = t(el.dataset.i18n as MessageKey);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-title]")) {
    el.title = t(el.dataset.i18nTitle as MessageKey);
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-aria-label]")) {
    el.setAttribute("aria-label", t(el.dataset.i18nAriaLabel as MessageKey));
  }
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-placeholder]")) {
    el.setAttribute("placeholder", t(el.dataset.i18nPlaceholder as MessageKey));
  }
  // Last: the parts have their own text by now, and this is what moves them.
  for (const el of document.querySelectorAll<HTMLElement>("[data-i18n-html]")) {
    applyParts(el, el.dataset.i18nHtml as MessageKey);
  }
}
