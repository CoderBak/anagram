// lib/dom/translation.ts — text a machine translated into the page.
//
// A translation is nobody's writing, and a verdict on it says nothing about the page. Two
// kinds reach the DOM:
//
//   · The browser's own page translation. It rewrites the text IN PLACE, and the whole page
//     is then the translator's, so the content script stops while it is on and starts again
//     when the original is back (entrypoints/content.ts). Each browser marks it its own way:
//       Chrome turns every text node into <font> copies holding the translation and classes
//       <html> `translated-ltr` or `translated-rtl` for as long as it is on; "Show original"
//       puts the nodes back and drops the class.
//       Edge's translator gives every element it rewrites the attributes `_msttexthash` and
//       `_msthash` (the ones behind the "extra attributes from the server" hydration errors
//       React and Next.js users report from translated pages); the page is translated while
//       one of them is anywhere in it.
//       Firefox's full-page translation (translations-document.sys.mjs) sets <html lang> to
//       the language it translates into when it starts, and while a block is being
//       translated numbers the elements inside it with `data-moz-translations-id`, removed
//       again once the translation is in. Neither stays as a mark of a translated page, so
//       the first sight of either is taken as the start; "Show original" reloads the page.
//   · Translator extensions. Read Frog's bilingual mode, KISS Translator and FluentRead (as
//     their source shows) add the translation as a COPY beside the original and mark it
//     `notranslate` or `translate="no"`, which the walk already leaves alone
//     (isNoTranslate). Immersive Translate puts its copy in a
//     `font.immersive-translate-target-wrapper`, the class its documentation gives for
//     styling translations; such a copy is skipped whatever else it is marked with. Read
//     Frog's "translation only" mode instead writes the translation into the paragraph's own
//     text nodes and marks the paragraph `data-read-frog-translation-only`
//     (src/utils/constants/dom-labels.ts in https://github.com/mengxi-ream/read-frog,
//     GPL-3.0, © the Read Frog authors); such a paragraph is skipped wherever it stands.
import { TRANSLATION_RELABELS_PAGE } from "../surface";

const TRANSLATED_PAGE_CLASSES = ["translated-ltr", "translated-rtl"];
/** On every element Edge's translator has rewritten. */
const EDGE_TRANSLATED_ATTR = "_msttexthash";
/** On the elements inside a block Firefox is translating, for as long as it is. */
const FIREFOX_TRANSLATING_ATTR = "data-moz-translations-id";

/** Has the browser translated this page? What can still be seen of it once it is done:
 *  Chrome's class, Edge's attributes. Firefox's marks are gone by then (watchPageTranslation). */
export function isPageTranslated(doc: Document = document): boolean {
  const cls = doc.documentElement?.classList;
  if (cls && TRANSLATED_PAGE_CLASSES.some((name) => cls.contains(name))) return true;
  return doc.querySelector(`[${EDGE_TRANSLATED_ATTR}]`) !== null;
}

/** The primary language of a `lang` value ("de" of "de-AT"), or "" when there is none. */
function primaryLanguage(lang: string | null): string {
  return (lang ?? "").trim().split(/[-_]/)[0].toLowerCase();
}

/**
 * Call `onChange` whenever the page is translated or shown in the original again. The marks
 * are set and removed long after load, whenever the reader asks, so they are watched: the
 * class and the language on <html> by themselves, the translators' attributes anywhere in
 * the page (an attribute filter, so the rest of the page's changes cost nothing).
 */
export function watchPageTranslation(onChange: (translated: boolean) => void, doc: Document = document): () => void {
  const root = doc.documentElement;
  if (!root) return () => undefined;
  let lang = primaryLanguage(root.getAttribute("lang"));
  /** Firefox has started translating: nothing on the page says it any more once it is done. */
  let firefox = false;
  let last = isPageTranslated(doc);
  const update = (): void => {
    const now = firefox || isPageTranslated(doc);
    if (now === last) return;
    last = now;
    onChange(now);
  };
  const onRoot = new MutationObserver(() => {
    const now = primaryLanguage(root.getAttribute("lang"));
    // A page relabelled from one language to another by the browser's own translation.
    if (TRANSLATION_RELABELS_PAGE && lang !== "" && now !== "" && now !== lang) firefox = true;
    lang = now;
    update();
  });
  onRoot.observe(root, { attributes: true, attributeFilter: ["class", "lang"] });
  const inPage = new MutationObserver((records) => {
    if (records.some((r) => r.attributeName === FIREFOX_TRANSLATING_ATTR)) firefox = true;
    update();
  });
  inPage.observe(root, { attributes: true, subtree: true, attributeFilter: [EDGE_TRANSLATED_ATTR, FIREFOX_TRANSLATING_ATTR] });
  return () => {
    onRoot.disconnect();
    inPage.disconnect();
  };
}

const TRANSLATED_IN_PLACE_ATTR = "data-read-frog-translation-only";
const TRANSLATION_COPY_CLASS = "immersive-translate-target-wrapper";

/** Is this element's text a translator extension's — written over the original, or a copy
 *  of the translation set beside it? */
export function isTranslatedInPlace(el: Element): boolean {
  return el.hasAttribute(TRANSLATED_IN_PLACE_ATTR) || el.classList.contains(TRANSLATION_COPY_CLASS);
}
