// test/pdf-bench/labelled.mjs — ground truth from two labelled datasets, in truthOf's shape.
//
// Both label the PDF's own text, so neither depends on a second rendering of the paper.
//
// HRDoc (https://github.com/jfma-USTC/HRDoc, AAAI 2023; its licence is unclear and the data
// is used offline, for development only, never redistributed): every text line of a PDF in
// reading order, with its class and the line it hangs from. A "fstline" opens a paragraph and
// a "para" line CONNECTED to the line before it carries it on — over a column, a page or a
// figure — so HRDoc says where paragraphs start as the document's author meant them, which
// is the truth this benchmark lacked beyond arXiv's HTML. Its classes map onto truth.mjs's
// labels: section heads are heading, title, authors, affiliations and e-mails front,
// captions caption, tables and figures figtext, equations display-math, page heads and feet
// margin, footnotes footnote; the paragraphs after a "References" head are reference, those
// under an acknowledgements head ack, and those after the references (the appendix)
// appendix. A caption or a figure standing between two parts of one paragraph comes after
// the paragraph, as truth.mjs moves a footnote.
//
// DocBank (https://github.com/doc-analysis/DocBank, Apache-2.0): every token of a sampled
// arXiv page with one of twelve labels. It knows no paragraph instances and its tokens are
// in the order the PDF draws them, so it measures what is read — coverage and leakage — and
// neither boundaries nor order. Its labels come from recolouring the LaTeX, and about a fifth
// of what it calls "paragraph" is not prose (relabel): formulas, figures' own text, junk
// glyphs, running heads, whole bibliographies. Its pages are those of the authors' own build
// of the LaTeX; each is found in the arXiv PDF by its words (at least MIN_OVERLAP of them on
// one page near its number), and one found nowhere is left out.
import { tokenize } from "./truth.mjs";

// ---- HRDoc ------------------------------------------------------------------------------

const HRDOC_CLASS = {
  title: "front", author: "front", mail: "front", affili: "front",
  sec1: "heading", sec2: "heading", sec3: "heading", secx: "heading",
  fstline: "body", para: "body",
  tab: "figtext", fig: "figtext", tabcap: "caption", figcap: "caption",
  equ: "display-math", foot: "margin", header: "margin", fnote: "footnote",
};
const REFERENCES_HEAD = /^(?:\d+\.?\s*)?(?:references|bibliography|literature cited)\s*$/i;
const ACK_HEAD = /^(?:\d+\.?\s*)?acknowledge?ments?\s*$/i;

/** {tokens, paras} from one HRDoc document (its JSON: an array of lines). */
export function hrdocTruthOf(lines) {
  const byId = new Map(lines.map((l) => [l.line_id, l]));
  /** A line's class, an "opara" (a line carrying on another) taking its root's. */
  const classOf = (l) => {
    let x = l;
    for (let n = 0; x.class === "opara" && n < 1000; n++) x = byId.get(x.parent_id) ?? { class: "para" };
    return x.class;
  };
  // Units in reading order: a paragraph is one unit however it is interrupted.
  const units = [];
  const unitOf = new Map();
  let section = "body";
  for (const l of [...lines].sort((a, b) => a.line_id - b.line_id)) {
    const cls = classOf(l);
    let cat = HRDOC_CLASS[cls] ?? "body";
    if (cat === "heading") {
      const head = l.text.trim();
      section = REFERENCES_HEAD.test(head) ? "reference" : ACK_HEAD.test(head) ? "ack" : section === "reference" || section === "appendix" ? "appendix" : "body";
    }
    if (cat === "body") cat = section;
    const parent = unitOf.get(l.parent_id);
    const carries = l.relation === "connect" && parent && (l.class === "para" || l.class === "opara");
    // The text after a display equation carries its paragraph on; like LaTeXML's second
    // p.ltx_p of one paragraph, it is a SOFT start: a boundary there is neither owed nor wrong.
    const afterEquation = carries && l.class === "para" && !parent.prose;
    if (carries && !afterEquation) {
      parent.lines.push(l);
      unitOf.set(l.line_id, parent);
      continue;
    }
    const unit = { cat, prose: cls === "fstline" || cls === "para", soft: afterEquation, lines: [l] };
    units.push(unit);
    unitOf.set(l.line_id, unit);
  }
  const tokens = [];
  const paras = [];
  for (const u of units) {
    const prose = u.prose && ["body", "appendix", "ack"].includes(u.cat);
    const para = prose ? paras.length : -1;
    const start = tokens.length;
    // A line ending in a hyphen runs its word on into the next line.
    let text = "";
    for (const l of u.lines) text = /[-‐]$/u.test(text) && /^\p{Ll}/u.test(l.text) ? text.slice(0, -1) + l.text : `${text} ${l.text}`;
    for (const tok of tokenize(text)) tokens.push({ t: tok.t, r: text.slice(tok.s, tok.e), cat: u.cat, para });
    if (prose && tokens.length > start) paras.push({ cat: u.cat, soft: u.soft, abstract: false, start, end: tokens.length });
  }
  return { tokens, paras };
}

// ---- DocBank ------------------------------------------------------------------------------

const DOCBANK_LABEL = {
  paragraph: "body", abstract: "body", list: "body", section: "heading", title: "front", author: "front",
  date: "front", caption: "caption", equation: "display-math", figure: "figtext", table: "figtext",
  reference: "reference", footer: "margin",
};
/** Share of a DocBank page's prose words that must be on one page of the PDF for it to be
 *  that page, and how many prose words it needs for the share to say anything. The arXiv PDF
 *  is often a later version than the one DocBank built, and a page of it that shares 80% of
 *  its words with DocBank's has paragraphs the truth does not. */
const MIN_OVERLAP = 0.9;
const MIN_WORDS = 100;
/** How far from its own number a DocBank page is looked for in the PDF. */
const PAGE_REACH = 2;
/** Faces TeX and its kin set mathematics in. DocBank labels a formula inside a sentence
 *  "paragraph"; arXiv's HTML marks it inline-math, and so does this. */
const MATH_FACE = /(?:^|\+)(?:CM(?:MI|SY|EX|BSY|MIB)|MSAM|MSBM|EUFM|EUSM|EUR[MB]|RSFS|WASY|STIXMath|LMMath|CambriaMath|Symbol|MTMI|MTSY|txsy|txmi|pxmi|pxsy|stmary|bbm|dsrom|MnSymbol)/i;
/** DocBank's boxes are on a 0–1000 grid. A line of "paragraph" above TOP_BAND or below
 *  FOOT_BAND, set apart from the next by more than EDGE_GAP line pitches, is a running head,
 *  a journal's footer or a page number. */
const TOP_BAND = 100;
const FOOT_BAND = 920;
const EDGE_GAP = 1.8;
/** Tokens whose tops are this close on the grid stand on one line. */
const LINE_SLACK = 4;

/**
 * What a DocBank "paragraph" token is, where its labels are wrong in ways that would count
 * the reader's right choices against it: a glyph pdfminer could not name (U+FFFD, "(cid:n)")
 * is noise; text in an unnamed face is drawn in a figure (axis ticks, plot marks); a glyph in
 * a mathematics face is inline-math; a running head or page number is margin; a page of
 * numbered bibliography entries ("[9] X. Wang, …, 2016.") is reference.
 */
function relabel(rows) {
  const para = rows.filter((r) => r[9].trim() === "paragraph");
  const marks = para.filter((r) => /^\[\d+\]$/.test(r[0])).length;
  const years = para.filter((r) => /^\(?(?:19|20)\d\d[a-z]?[.,;:)]*$/.test(r[0])).length;
  const bibliography = marks >= 5 && years >= marks / 2;
  // Lines as runs of tops no more than LINE_SLACK apart: [first top, last top].
  const lines = [];
  for (const y of [...new Set(para.map((r) => Number(r[2])))].sort((a, b) => a - b)) {
    if (lines.length && y - lines[lines.length - 1][1] <= LINE_SLACK) lines[lines.length - 1][1] = y;
    else lines.push([y, y]);
  }
  const pitches = lines.slice(1).map((l, i) => l[0] - lines[i][1]).sort((a, b) => a - b);
  const pitch = pitches[pitches.length >> 1] ?? 12;
  const edge = [];
  const last = lines.length - 1;
  if (last >= 2 && lines[0][1] < TOP_BAND && lines[1][0] - lines[0][1] > EDGE_GAP * pitch) edge.push(lines[0]);
  if (last >= 2 && lines[last][0] > FOOT_BAND && lines[last][0] - lines[last - 1][1] > EDGE_GAP * pitch) edge.push(lines[last]);
  const onEdge = (y) => edge.some(([a, b]) => y >= a && y <= b);
  return (r) => {
    const label = r[9].trim();
    if (label !== "paragraph") return DOCBANK_LABEL[label] ?? "unmatched";
    if (/�|\(cid:\d+\)/.test(r[0])) return "noise";
    if (r[8] === "default") return "figtext";
    if (onEdge(Number(r[2]))) return "margin";
    if (bibliography) return "reference";
    if (MATH_FACE.test(r[8])) return "inline-math";
    return "body";
  };
}

/**
 * {tokens, paras, pages, bounds: false, order: false} from DocBank pages — each {index, text}
 * with `text` the page's .txt (token, box, colour, font, label per line) — matched to the
 * PDF's pages as pdf.js reads them (PdfPageText[]).
 */
export function docbankTruthOf(files, pdfPages) {
  const words = (s) => tokenize(s).map((t) => t.t);
  const bags = pdfPages.map((p) => new Set(words(p.items.map((it) => it.str).join(" "))));
  const tokens = [];
  const paras = [];
  const pages = new Set();
  for (const { index, text } of files) {
    const rows = text.split("\n").map((l) => l.split("\t")).filter((r) => r.length >= 10 && r[0] !== "##LTLine##");
    const mine = words(rows.filter((r) => r[9].trim() === "paragraph").map((r) => r[0]).join(" "));
    if (mine.length < MIN_WORDS) continue;
    let best = -1, share = 0;
    // DocBank numbers pages from 0: its page `index` is the PDF's page index + 1, bags[index].
    for (let k = index - PAGE_REACH; k <= index + PAGE_REACH; k++) {
      const bag = bags[k];
      if (!bag) continue;
      const s = mine.filter((w) => bag.has(w)).length / mine.length;
      if (s > share) { share = s; best = k; }
    }
    if (share < MIN_OVERLAP || pages.has(best + 1)) continue;
    pages.add(best + 1);
    const catOf = relabel(rows);
    let para = -1;
    for (const r of rows) {
      const cat = catOf(r);
      // A formula inside a sentence does not end its paragraph, and belongs to it (truth.mjs).
      if (cat === "inline-math") {
        for (const tok of tokenize(r[0])) tokens.push({ t: tok.t, r: r[0].slice(tok.s, tok.e), cat, para });
        continue;
      }
      if (cat !== "body") para = -1;
      else if (para < 0) { para = paras.length; paras.push({ cat: "body", soft: true, abstract: r[9].trim() === "abstract", start: tokens.length, end: tokens.length }); }
      for (const tok of tokenize(r[0])) {
        tokens.push({ t: tok.t, r: r[0].slice(tok.s, tok.e), cat, para });
        if (para >= 0) paras[para].end = tokens.length;
      }
    }
  }
  return { tokens, paras, pages, bounds: false, order: false };
}
