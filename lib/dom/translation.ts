// lib/dom/translation.ts — text a machine translated into the page.
//
// A translation is nobody's writing, and a verdict on it says nothing about the page. Two
// kinds reach the DOM:
//
//   · The browser's own page translation. Chrome rewrites the text IN PLACE — every text
//     node becomes <font> copies holding the translation — and classes <html>
//     `translated-ltr` or `translated-rtl` for as long as it is on; "Show original" puts the
//     nodes back and drops the class. The whole page is then the translator's, so the
//     content script stops while the class is there and starts again when it goes
//     (entrypoints/content.ts).
//   · Translator extensions. Read Frog's bilingual mode, KISS Translator and FluentRead (as
//     their source shows) add the translation as a COPY beside the original and mark it
//     `notranslate` or `translate="no"`, which the walk already leaves alone
//     (isNoTranslate). Read Frog's "translation only" mode instead writes the translation
//     into the paragraph's own text nodes and marks the paragraph
//     `data-read-frog-translation-only` (src/utils/constants/dom-labels.ts in
//     https://github.com/mengxi-ream/read-frog, GPL-3.0, © the Read Frog authors); such a
//     paragraph is skipped wherever it stands.

const TRANSLATED_PAGE_CLASSES = ["translated-ltr", "translated-rtl"];

/** Has the browser translated this page? */
export function isPageTranslated(doc: Document = document): boolean {
  const cls = doc.documentElement?.classList;
  return !!cls && TRANSLATED_PAGE_CLASSES.some((name) => cls.contains(name));
}

/**
 * Call `onChange` whenever the page is translated or shown in the original again. The
 * class is set and removed long after load, whenever the reader asks, so it is watched.
 */
export function watchPageTranslation(onChange: (translated: boolean) => void, doc: Document = document): () => void {
  const root = doc.documentElement;
  if (!root) return () => undefined;
  let last = isPageTranslated(doc);
  const observer = new MutationObserver(() => {
    const now = isPageTranslated(doc);
    if (now === last) return;
    last = now;
    onChange(now);
  });
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

const TRANSLATED_IN_PLACE_ATTR = "data-read-frog-translation-only";

/** Is this element's text a translator extension's, written over the original? */
export function isTranslatedInPlace(el: Element): boolean {
  return el.hasAttribute(TRANSLATED_IN_PLACE_ATTR);
}
