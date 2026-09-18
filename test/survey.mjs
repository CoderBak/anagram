// test/survey.mjs — load many kinds of pages with the built extension and the REAL daemon
// and report what a reader would notice on each: chip counts by verdict, chips inside page
// chrome, paragraphs cut into several units, long visible paragraphs with no chip, stuck
// "analyzing…" chips, extension console errors. Screenshots land in test/survey-<name>.png,
// the raw rows in test/survey.json. Not a pass/fail suite — a magnifying glass: every zero,
// split or unscored row is worth a look (many are legitimate: teaser-only front pages,
// captcha walls, pages of short paragraphs). Requires `npm run serve` running.
//
//   node test/survey.mjs                       # the default site list below
//   SITES='[["name","https://…"],…]' node test/survey.mjs
import { launchExtension, BADGE_SEL, ARTIFACTS, sweep } from "./harness.mjs";
import { writeFileSync } from "node:fs";
const OUT = ARTIFACTS;
const SITES = process.env.SITES ? JSON.parse(process.env.SITES) : [
  ["news-front", "https://www.theguardian.com/international"],
  ["longform-book", "https://www.gutenberg.org/files/1342/1342-h/1342-h.htm"],
  ["docs-mdn", "https://developer.mozilla.org/en-US/docs/Web/HTTP/Overview"],
  ["docs-python", "https://docs.python.org/3/tutorial/introduction.html"],
  ["docs-react-spa", "https://react.dev/learn"],
  ["docs-rust-book", "https://doc.rust-lang.org/book/ch01-01-installation.html"],
  ["forum-hn-thread", "https://news.ycombinator.com/item?id=41214675"],
  ["forum-discourse-topic", "https://discuss.python.org/t/pep-703-making-the-global-interpreter-lock-optional/22606"],
  ["marketing-apple", "https://www.apple.com/iphone/"],
  ["video-youtube", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
  ["gov-cn-unsupported", "http://www.mod.gov.cn/gfbw/qwfb/yw_214049/16486172.html"],
  ["gov-whitehouse", "https://www.whitehouse.gov/"],
  ["legal-eurlex-accordion-rewrite", "https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX:32016R0679"],
  ["paper-arxiv-abs", "https://arxiv.org/abs/2212.10001"],
  ["paper-arxiv-html-math", "https://arxiv.org/html/2212.10001v2"],
  ["paper-pubmed-authorlists", "https://pubmed.ncbi.nlm.nih.gov/33301246/"],
  ["blog-simonw", "https://simonwillison.net/"],
  ["blog-substack-post", "https://www.astralcodexten.com/p/royce-on-san-francisco"],
  ["wiki-de-unsupported", "https://de.wikipedia.org/wiki/Alan_Turing"],
  ["wiki-en-long", "https://en.wikipedia.org/wiki/World_War_II"],
  ["wiki-math", "https://en.wikipedia.org/wiki/Quadratic_formula"],
  ["serp-google", "https://www.google.com/search?q=alan+turing"],
  ["code-gitlab", "https://gitlab.com/gitlab-org/gitlab"],
  ["textplain-rfc", "https://www.rfc-editor.org/rfc/rfc2616.txt"],
];
const { context } = await launchExtension({ viewport: { width: 1280, height: 850 } });
const rows = [];
for (const [name, url] of SITES) {
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => { const u = m.location()?.url ?? ""; if (m.type() === "error" && u.startsWith("chrome-extension://") && !u.startsWith("chrome-extension://invalid")) errors.push(m.text().slice(0, 120)); });
  let status = 0;
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
    status = resp?.status() ?? 0;
  } catch (e) { rows.push({ name, url, error: "goto: " + String(e).slice(0, 60) }); await page.close(); continue; }
  const botWall = await page.evaluate(() => /verifying you are human|just a moment|attention required|checking your browser|access denied|are you a robot|prove your humanity/i.test(document.title + " " + (document.body?.innerText ?? "").slice(0, 600))).catch(() => false);
  await page.waitForSelector(BADGE_SEL, { timeout: 8000 }).catch(() => {});
  await sweep(page, 6, 350);
  await page.waitForFunction((sel) => ![...document.querySelectorAll(sel)].some((h) => h.shadowRoot?.querySelector(".pill.pending")), BADGE_SEL, { timeout: 25000 }).catch(() => {});
  await page.waitForTimeout(1500);
  const stats = await page.evaluate((sel) => {
    const hosts = [...document.querySelectorAll(sel)];
    const pill = (h) => h.shadowRoot?.querySelector(".pill");
    const bands = {};
    let pending = 0, chrome = 0;
    const blockOf = (el) => el.closest("p, li, blockquote, dd, td, h1, h2, h3, h4, pre, figcaption");
    const perBlock = new Map();
    for (const h of hosts) {
      const p = pill(h);
      const band = [...(p?.classList ?? [])].find((c) => c.startsWith("band-")) ?? "none";
      bands[band] = (bands[band] ?? 0) + 1;
      if (p?.classList.contains("pending")) pending++;
      const anchor = h.parentElement;
      if (anchor?.closest("nav, header, footer, aside, [role=navigation], [role=banner], [role=contentinfo], [role=complementary]")) chrome++;
      const b = anchor ? blockOf(anchor) : null;
      if (b) perBlock.set(b, (perBlock.get(b) ?? 0) + 1);
    }
    const split = [...perBlock.entries()].filter(([b, n]) => n > 1 && b.tagName === "P").map(([b, n]) => ({ n, text: b.textContent.replace(/\s+/g, " ").slice(0, 70) }));
    const words = (el) => el.textContent.trim().split(/\s+/).filter(Boolean).length;
    const visible = (el) => { const r = el.getBoundingClientRect(); return (r.width > 0 && r.height > 0) || el.getClientRects().length > 0; };
    const unscored = [...document.querySelectorAll("p")].filter((p) => words(p) >= 60 && !p.querySelector(sel) && !p.closest("nav, header, footer, aside, [aria-hidden=true], pre, [contenteditable]") && visible(p)).map((p) => ({ words: words(p), text: p.textContent.replace(/\s+/g, " ").trim().slice(0, 70) }));
    const samples = hosts.slice(0, 3).map((h) => (h.parentElement?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 60));
    const fab = document.getElementById("anagram-fab")?.shadowRoot?.querySelector(".count")?.textContent ?? "?";
    return { badges: hosts.length, bands, pending, chrome, splitCount: split.length, split: split.slice(0, 3), unscoredCount: unscored.length, unscored: unscored.slice(0, 3), samples, fab, title: document.title.slice(0, 50) };
  }, BADGE_SEL).catch((e) => ({ evalError: String(e).slice(0, 80) }));
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.screenshot({ path: `${OUT}/survey-${name}.png` }).catch(() => {});
  rows.push({ name, url, status, botWall, errors, ...stats });
  await page.close();
}
await context.close();
writeFileSync(`${OUT}/survey.json`, JSON.stringify(rows, null, 1));
for (const r of rows) {
  if (r.error) { console.log(`${r.name.padEnd(24)} ERROR ${r.error}`); continue; }
  console.log(`${r.name.padEnd(24)} ${r.status} ${r.botWall ? "BOTWALL " : ""}badges=${r.badges} bands=${JSON.stringify(r.bands)} pending=${r.pending} chrome=${r.chrome} splitP=${r.splitCount} unscoredP=${r.unscoredCount} fab=${r.fab} err=${r.errors?.length ?? 0}`);
}
