// test/pdf-bench/truth.mjs — the paragraphs Anagram should read, from arXiv's LaTeXML HTML.
//
// The ground truth is a stream of TOKENS in the HTML's order, each labelled with what it
// is, plus the list of prose paragraphs over it. The rules, applied to <article
// class="ltx_document"> and nothing outside it (arXiv's banner, TOC and footer are gone):
//
//  - PROSE is every p.ltx_p of the abstract and of the body sections, list items and
//    theorem and proof bodies included. Each p.ltx_p is one paragraph. LaTeXML cuts a TeX
//    paragraph into several p.ltx_p at a display equation or a list inside it; the second
//    and later ones of one div.ltx_para are SOFT — a boundary there is neither required
//    nor an error. Appendix paragraphs (section.ltx_appendix) and the acknowledgements are
//    prose too, but NEUTRAL: reading them is right and so is leaving them.
//  - INLINE MATH (math.ltx_Math) is not prose: Anagram's web walker skips it. Its MathML
//    tokens stay in the stream, labelled inline-math, so the PDF's glyphs for it are
//    recognised as math rather than as noise; they count neither as prose to cover nor
//    (in the headline) as prose read.
//  - DISPLAY EQUATIONS (table.ltx_equation / ltx_equationgroup, math[display=block]) and
//    their numbers are display-math. Figures and tables are figtext (tabular cells, SVG
//    text, listings) with their figcaption as caption; the accessibility description arXiv
//    adds inside <object> is not printed and is dropped. Footnotes are footnote, moved to
//    just after the paragraph that calls them; the call mark stays in the paragraph as
//    mark. The bibliography is reference. Title, authors, affiliations, e-mails, dates,
//    keywords and title-page notes are front. Section titles are heading; run-in titles
//    (\paragraph, theorem and proof heads) are runin; list labels are mark.
//  - CITATIONS (cite.ltx_cite) in prose are cite, and neutral: LaTeXML often renders a
//    natbib citation author-year where the PDF prints "[7]", so neither side can be held
//    to the other's form.
//
// Tokens are words of letters or runs of digits, compared case-folded, with ligatures,
// diacritics and TeX's loose accents ("na¨ıve") folded away, so a PDF and its HTML spell
// every word alike however each was set.
import { parseHTML } from "linkedom";

export const PROSE = new Set(["body", "appendix", "ack"]);
/** Right to read and right to leave: never coverage, never leakage. "number" is a bare
 *  number the truth does not have in that place (a citation or reference renumbered). */
export const NEUTRAL = new Set(["appendix", "ack", "runin", "mark", "cite", "number"]);

const TOKEN = /[\p{L}\p{M}¨´`ˆ˜¸˚˘ˇ]+|\p{N}+/gu;
const FOLD = /[\p{M}¨´`ˆ˜¸˚˘ˇ]/gu;

/** Tokens of `text` with their offsets in it. */
export function tokenize(text) {
  const out = [];
  for (const m of text.matchAll(TOKEN)) {
    const t = m[0].normalize("NFKD").replace(FOLD, "").replace(/ı/g, "i").toLowerCase();
    if (t) out.push({ t, s: m.index, e: m.index + m[0].length });
  }
  return out;
}

const SKIP_TAGS = new Set(["script", "style", "nav", "header", "footer", "button", "object", "img", "annotation", "annotation-xml", "input", "form"]);
const SKIP_CLASSES = ["ltx_TOC", "ltx_page_logo", "ltx_pagination", "ltx_role_newpage"];
const BLOCK_TAGS = new Set(["p", "div", "li", "ul", "ol", "dl", "dt", "dd", "td", "th", "tr", "table", "figure", "figcaption", "section", "h1", "h2", "h3", "h4", "h5", "h6", "br", "blockquote", "pre", "math", "article"]);
const FRONT = ["ltx_authors", "ltx_keywords", "ltx_dates", "ltx_classification", "ltx_subtitle"];
const RUNIN = ["ltx_runin", "ltx_title_paragraph", "ltx_title_subparagraph", "ltx_title_theorem", "ltx_title_proof"];
const FLOATS = ["ltx_figure", "ltx_table", "ltx_float", "ltx_algorithm", "ltx_listing"];

/**
 * @returns {{tokens: {t: string, r: string, cat: string, para: number}[],
 *   paras: {cat: string, soft: boolean, abstract: boolean, start: number, end: number}[]}}
 */
export function truthOf(html) {
  const { document } = parseHTML(html);
  const article = document.querySelector("article.ltx_document") ?? document.querySelector(".ltx_page_content");
  if (!article) throw new Error("no LaTeXML article");
  /** Runs of text of one label, in order; tokenized at the end so words may span elements. */
  const runs = [];
  const paras = [];
  let group = 0;
  const groupSeen = new Set();

  const push = (sink, text, cat, para) => {
    const last = sink[sink.length - 1];
    if (last && last.cat === cat && last.para === para) last.text += text;
    else sink.push({ text, cat, para });
  };
  const has = (el, names) => names.some((c) => el.classList.contains(c));

  function walk(node, ctx, sink) {
    if (node.nodeType === 3) {
      push(sink, node.data, ctx.cat, ctx.para);
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node;
    const tag = el.localName;
    if (SKIP_TAGS.has(tag) || has(el, SKIP_CLASSES)) return;
    let next = ctx;
    const children = () => { for (const c of el.childNodes) walk(c, next, sink); };

    if (tag === "math") {
      const display = el.getAttribute("display") === "block" || ctx.cat === "display-math";
      const cat = display ? "display-math" : PROSE.has(ctx.cat) ? "inline-math" : ctx.cat;
      push(sink, " ", ctx.cat, ctx.para);
      for (const c of el.childNodes) walk(c, { ...ctx, cat }, sink);
      push(sink, " ", ctx.cat, ctx.para);
      return;
    }
    if (el.classList.contains("ltx_note")) {
      const footnote = has(el, ["ltx_role_footnote", "ltx_role_endnote"]);
      const cat = footnote ? "footnote" : "front";
      for (const c of el.childNodes) {
        if (c.nodeType === 1 && c.classList.contains("ltx_note_mark")) walk(c, { ...ctx, cat: footnote ? "mark" : "front" }, sink);
        else if (c.nodeType === 1) walk(c, { ...ctx, cat, para: -1 }, ctx.deferred ?? sink);
      }
      return;
    }
    if (/^h[1-6]$/.test(tag) && el.classList.contains("ltx_title")) {
      const cat = el.classList.contains("ltx_title_document") ? "front" : has(el, RUNIN) ? "runin" : "heading";
      next = { ...ctx, cat: ctx.cat === "reference" ? "reference" : cat, para: cat === "runin" ? ctx.para : -1 };
    } else if (has(el, FRONT)) next = { ...ctx, cat: "front", para: -1 };
    else if (el.classList.contains("ltx_bibliography")) next = { ...ctx, cat: "reference", para: -1 };
    else if (el.classList.contains("ltx_appendix")) next = { ...ctx, cat: "appendix", appendix: true };
    else if (has(el, ["ltx_equation", "ltx_equationgroup", "ltx_eqn_table"])) next = { ...ctx, cat: "display-math", para: -1 };
    else if (tag === "figcaption" || el.classList.contains("ltx_caption")) next = { ...ctx, cat: "caption", para: -1 };
    else if ((tag === "figure" || has(el, FLOATS) || el.classList.contains("ltx_tabular")) && ctx.cat !== "caption") {
      next = { ...ctx, cat: "figtext", para: -1 };
    } else if (has(el, ["ltx_tag_item", "ltx_tag_note"])) next = { ...ctx, cat: ctx.cat === "footnote" ? "footnote" : "mark" };
    else if (el.classList.contains("ltx_cite") && PROSE.has(ctx.cat)) next = { ...ctx, cat: "cite" };
    else if (el.classList.contains("ltx_abstract")) next = { ...ctx, cat: "body", abstract: true };
    else if (el.classList.contains("ltx_para")) next = { ...ctx, group: ++group };
    else if (el.classList.contains("ltx_acknowledgements") || (tag === "p" && el.classList.contains("ltx_p") && PROSE.has(ctx.cat))) {
      const cat = el.classList.contains("ltx_acknowledgements") ? "ack" : ctx.appendix ? "appendix" : "body";
      const soft = !el.classList.contains("ltx_acknowledgements") && ctx.group > 0 && groupSeen.has(ctx.group);
      groupSeen.add(ctx.group);
      const para = paras.length;
      paras.push({ cat, soft, abstract: !!ctx.abstract, run: runs.length });
      const deferred = [];
      next = { ...ctx, cat, para, deferred };
      push(sink, " ", ctx.cat, ctx.para);
      children();
      push(sink, " ", ctx.cat, ctx.para);
      for (const d of deferred) push(sink, ` ${d.text} `, d.cat, d.para);
      return;
    }
    children();
    if (BLOCK_TAGS.has(tag)) push(sink, " ", next.cat, next.para);
  }

  walk(article, { cat: "body", para: -1, group: 0, appendix: false, abstract: false, deferred: null }, runs);

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
  return {
    tokens,
    paras: paras.map((p, i) => ({ cat: p.cat, soft: p.soft, abstract: p.abstract, start: bounds[i].start, end: bounds[i].end })),
  };
}
