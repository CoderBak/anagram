// test/pdf-bench/corpus.mjs — the benchmark's documents, kept OUTSIDE the repository.
//
//   node test/pdf-bench/corpus.mjs seed <ids.txt> [<dir with <id>.pdf>]   add arXiv ids
//   node test/pdf-bench/corpus.mjs add <id> <pdf-url> <category,…> [--html <url>] [--truth tagged]
//   node test/pdf-bench/corpus.mjs derive <id> <parent-id> <category,…> <how it was made>
//   node test/pdf-bench/corpus.mjs fetch                                  download what is missing
//
// ANAGRAM_PDF_BENCH names the corpus directory. It holds manifest.json, pdf/<id>.pdf and
// html/<id>.html (arXiv's LaTeXML rendering, the ground truth). Third-party documents are
// never committed; the manifest records where each came from so the corpus can be rebuilt.
// Requests go out with a generic User-Agent and at most one every three seconds.
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.env.ANAGRAM_PDF_BENCH;
if (!ROOT) throw new Error("set ANAGRAM_PDF_BENCH to the corpus directory");
const MANIFEST = join(ROOT, "manifest.json");
const UA = "anagram-pdfbench/0.1";
const PAUSE_MS = 3100;

const load = () => (existsSync(MANIFEST) ? JSON.parse(readFileSync(MANIFEST, "utf8")) : []);
const save = (docs) => writeFileSync(MANIFEST, `${JSON.stringify(docs, null, 1)}\n`);
const safeId = (id) => id.replace(/[^\w.-]+/g, "_");
const arxivPdf = (id) => `https://export.arxiv.org/pdf/${id}`;
const arxivHtml = (id) => `https://arxiv.org/html/${id}`;

let last = 0;
async function politeGet(url) {
  const wait = last + PAUSE_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  last = Date.now();
  const response = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  return { status: response.status, url: response.url, body: Buffer.from(await response.arrayBuffer()) };
}

function upsert(docs, entry) {
  const at = docs.findIndex((d) => d.id === entry.id);
  if (at < 0) docs.push(entry);
  else docs[at] = { ...docs[at], ...entry };
}

const [command, ...args] = process.argv.slice(2);
mkdirSync(join(ROOT, "pdf"), { recursive: true });
mkdirSync(join(ROOT, "html"), { recursive: true });
const docs = load();

if (command === "seed") {
  const [idsFile, from] = args;
  for (const line of readFileSync(idsFile, "utf8").split("\n")) {
    const [id, subject] = line.trim().split(/\s+/);
    if (!id) continue;
    const file = `pdf/${safeId(id)}.pdf`;
    if (from && !existsSync(join(ROOT, file)) && existsSync(join(from, `${safeId(id)}.pdf`))) {
      copyFileSync(join(from, `${safeId(id)}.pdf`), join(ROOT, file));
    }
    upsert(docs, {
      id, source: arxivPdf(id), html_source: arxivHtml(id), subject: subject ?? null,
      category: ["arxiv-recent"], file, html: `html/${safeId(id)}.html`,
    });
  }
  save(docs);
  console.log(`${docs.length} documents`);
} else if (command === "add") {
  const [id, url, categories] = args;
  const option = (name) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : null);
  const htmlUrl = option("html");
  upsert(docs, {
    id, source: url, html_source: htmlUrl, subject: null,
    category: categories.split(","), file: `pdf/${safeId(id)}.pdf`,
    html: htmlUrl ? `html/${safeId(id)}.html` : null, truth: option("truth"),
  });
  save(docs);
} else if (command === "derive") {
  // A document made from another one (line numbers stamped onto an arXiv paper): the
  // PDF is put in pdf/<id>.pdf by hand and it keeps its parent's truth.
  const [id, parentId, categories, how] = args;
  const parent = docs.find((d) => d.id === parentId);
  upsert(docs, {
    id, source: `derived from ${parentId}: ${how}`, html_source: parent.html_source, subject: parent.subject,
    category: categories.split(","), file: `pdf/${safeId(id)}.pdf`, html: parent.html, has_html: parent.has_html,
  });
  save(docs);
} else if (command === "fetch") {
  for (const doc of docs) {
    if (!existsSync(join(ROOT, doc.file))) {
      const got = await politeGet(doc.source);
      if (got.status === 200 && got.body.subarray(0, 5).toString() === "%PDF-") {
        writeFileSync(join(ROOT, doc.file), got.body);
      } else console.log(`pdf ${doc.id}: ${got.status}`);
    }
    if (doc.html && doc.html_source && doc.has_html === undefined) {
      const got = await politeGet(doc.html_source);
      // arXiv answers 404 for a paper it could not convert, and some conversions come
      // back as a page that only says so; neither is ground truth.
      const ok = got.status === 200 && got.body.includes("ltx_page_main");
      if (ok) writeFileSync(join(ROOT, doc.html), got.body);
      doc.has_html = ok;
      doc.html_status = got.status;
      console.log(`html ${doc.id}: ${got.status}${ok ? "" : " (none)"}`);
      save(docs);
    }
    doc.has_html = doc.html ? existsSync(join(ROOT, doc.html)) : false;
  }
  save(docs);
  console.log(`${docs.filter((d) => existsSync(join(ROOT, d.file))).length} PDFs, ${docs.filter((d) => d.has_html).length} with HTML`);
} else {
  console.log("usage: corpus.mjs seed <ids.txt> [<pdf dir>] | add <id> <url> <cats> [<html-url>] | fetch");
}
