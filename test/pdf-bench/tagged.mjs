// test/pdf-bench/tagged.mjs — ground truth from a Tagged PDF's structure tree.
//
// Word (and Acrobat's PDFMaker) writes every document it saves as PDF with a structure
// tree: its own paragraphs (P, LBody), headings (H1–H6), lists, tables and figures, in
// the document's logical order, with running heads and page numbers marked as artifacts
// and so left out. For a Word-made paper, which arXiv cannot render as HTML, that is the
// truth: the application's own paragraphs, not a guess from geometry. The text is the
// marked content each element owns, joined the way the page sets it.
//
// Word tags a caption and a reference-list entry as P like any paragraph, so two things
// are read off the text instead: the paragraphs after a "References" heading are
// references, and a paragraph opening "Figure 3:" or "Table 2." is a caption. A heading
// longer than any heading is body text in a heading style. A paragraph Word breaks
// across a page is two elements in pdf.js's per-page trees; the second is folded back
// into the first when the first ends without a sentence end and was the last thing on
// its page.
import { tokenize } from "./truth.mjs";

const HEADING = /^(?:H\d?|Title|TOCI?)$/;
const PARAGRAPH = new Set(["P", "LBody", "BlockQuote"]);
const TABLE = new Set(["Table", "TR", "TH", "TD", "THead", "TBody", "TFoot"]);
const NOTE = new Set(["Note", "FENote", "Footnote", "Endnote"]);
const SENTENCE_END = /[.!?:;。"”’)\]]\s*$/;
/** The same bound the reflow puts on a heading (lib/pdf/reflow.ts HEADING_MAX_WORDS). */
const HEADING_MAX_WORDS = 20;
/** Word tags its reference list and its captions as plain P; their text says what they are. */
const REFERENCES = /^(?:\d+\.?\s*)?(?:references|bibliography|literature cited|works cited|reference list)\s*$/i;
const CAPTION = /^(?:fig(?:ure)?|table|scheme|chart)\.?\s*[A-Z]?\d+[a-z]?\s*[.:|–—-]/i;
const CAPTION_MAX_WORDS = 120;

/** The text of every marked-content sequence on a page, by its id. */
function markedText(content) {
  const text = new Map();
  const stack = [];
  let prev = null;
  for (const item of content.items) {
    if (item.type === "beginMarkedContentProps" || item.type === "beginMarkedContent") { stack.push(item.id ?? null); continue; }
    if (item.type === "endMarkedContent") { stack.pop(); continue; }
    if (!("str" in item)) continue;
    const id = [...stack].reverse().find((x) => x) ?? null;
    if (!id) continue;
    const x = item.transform[4], y = item.transform[5], h = Math.abs(item.height) || 1;
    let sep = "";
    if (prev && text.has(id)) {
      const newLine = Math.abs(y - prev.y) > h * 0.5;
      sep = newLine || prev.eol || x - prev.right > h * 0.15 ? " " : "";
    }
    text.set(id, (text.get(id) ?? "") + sep + item.str);
    prev = { y, right: x + item.width, eol: item.hasEOL };
  }
  return text;
}

/** {tokens, paras} as truthOf builds them, or null when the PDF carries no tags. */
export async function taggedTruthOf(pdfjs, options, maxPages) {
  const doc = await pdfjs.getDocument(options).promise;
  try {
    const mark = await doc.getMarkInfo().catch(() => null);
    if (!mark?.Marked) return null;
    const runs = [];
    const paras = [];
    let open = null;
    let inReferences = false;
    const push = (text, cat, para) => {
      const last = runs[runs.length - 1];
      if (last && last.cat === cat && last.para === para) last.text += ` ${text}`;
      else runs.push({ text: ` ${text}`, cat, para });
    };
    for (let n = 1; n <= Math.min(doc.numPages, maxPages); n++) {
      const page = await doc.getPage(n);
      const text = markedText(await page.getTextContent({ includeMarkedContent: true, disableNormalization: true }));
      const tree = await page.getStructTree().catch(() => null);
      let firstOnPage = true;
      const textOf = (node) => (node.type === "content" ? text.get(node.id) ?? "" : (node.children ?? []).map(textOf).join(" ")).trim();
      const words = (node) => textOf(node).split(/\s+/).length;
      const walk = (node, ctx) => {
        if (!node) return;
        if (node.type === "content") { const t = text.get(node.id); if (t) push(t, ctx.cat, ctx.para); return; }
        if (node.type) return;
        // A "heading" of a paragraph's length is body text in a heading style.
        const role = HEADING.test(node.role ?? "") && words(node) > HEADING_MAX_WORDS ? "P" : node.role ?? "";
        let next = ctx;
        if (HEADING.test(role) || (PARAGRAPH.has(role) && REFERENCES.test(textOf(node)))) {
          inReferences = REFERENCES.test(textOf(node));
          next = { cat: "heading", para: -1, inside: true };
        }
        else if (role === "Lbl") next = { ...ctx, cat: ctx.cat === "body" ? "mark" : ctx.cat };
        else if (role === "Caption") next = { cat: "caption", para: -1, inside: true };
        else if (role === "Figure") next = { cat: "figtext", para: -1, inside: true };
        else if (TABLE.has(role)) next = { cat: "figtext", para: -1, inside: true };
        else if (NOTE.has(role)) next = { cat: "footnote", para: -1, inside: true };
        else if (role === "Formula") next = { ...ctx, cat: ctx.para >= 0 ? "inline-math" : "display-math" };
        else if (PARAGRAPH.has(role) && !ctx.inside) {
          // The rest of a paragraph the previous page broke off.
          if (firstOnPage && open && !SENTENCE_END.test(open.tail) && open.lastPage === n - 1) {
            next = { cat: "body", para: open.para, inside: true };
          } else if (inReferences) {
            next = { cat: "reference", para: -1, inside: true };
          } else if (CAPTION.test(textOf(node)) && words(node) <= CAPTION_MAX_WORDS) {
            next = { cat: "caption", para: -1, inside: true };
          } else {
            const para = paras.length;
            paras.push({ cat: "body", soft: false, abstract: false });
            next = { cat: "body", para, inside: true };
          }
          firstOnPage = false;
          const before = runs.length;
          for (const c of node.children ?? []) walk(c, next);
          const mine = runs.slice(before).filter((r) => r.para === next.para).map((r) => r.text).join(" ").trim();
          if (mine) open = { para: next.para, tail: mine, lastPage: n };
          return;
        }
        for (const c of node.children ?? []) walk(c, next);
        if (HEADING.test(role) || TABLE.has(role) || role === "Figure" || role === "Caption") firstOnPage = false;
      };
      walk(tree, { cat: "body", para: -1, inside: false });
      page.cleanup();
    }
    const tokens = [];
    const bounds = paras.map(() => ({ start: -1, end: -1 }));
    for (const run of runs) {
      for (const tok of tokenize(run.text)) {
        if (run.para >= 0) {
          const b = bounds[run.para];
          if (b.start < 0) b.start = tokens.length;
          b.end = tokens.length + 1;
        }
        tokens.push({ t: tok.t, r: run.text.slice(tok.s, tok.e), cat: run.cat, para: run.para });
      }
    }
    return { tokens, paras: paras.map((p, i) => ({ ...p, ...bounds[i] })) };
  } finally {
    await doc.destroy();
  }
}
