// test/fixtures/probe-report.js — run AFTER the probe bundle (see probe-entry.ts) in a page.
// probeReport("article") → compact JSON: per post-like container, the words a reader sees
// and the units that cover them. No text leaves the page — only counts and tag names.
//   post  selector of one post/comment/answer container ("article", "[role=article]",
//         ".comment", "shreddit-comment" …); omit it to get page totals only.
function probeReport(post, max = 12) {
  const P = window.__anagramProbe;
  if (!P) return "probe bundle not loaded";
  const units = P.collectUnits(document.body);
  const posts = post ? [...document.querySelectorAll(post)].filter((el) => el.getBoundingClientRect().height > 0) : [];
  const inside = (u, el) => u.parts.some((p) => el.contains(p.container));
  const words = (el) => P.countWords(el.innerText || "");
  const rows = posts.slice(0, max).map((el, i) => {
    const mine = units.filter((u) => inside(u, el));
    return {
      i,
      words: words(el),
      nested: !!(el.parentElement && el.parentElement.closest(post)),
      units: mine.map((u) => ({ parts: u.parts.length, words: u.wordCount, crosses: u.parts.some((p) => !el.contains(p.container)) })),
    };
  });
  const loose = units.filter((u) => !posts.some((el) => inside(u, el)));
  return JSON.stringify({
    url: location.hostname + location.pathname.replace(/[0-9]{5,}/g, "N"),
    lang: document.documentElement.lang || null,
    units: units.length,
    merged: units.filter((u) => u.parts.length > 1).length,
    wordsJudged: units.reduce((n, u) => n + u.wordCount, 0),
    wordsOnPage: P.countWords(document.body.innerText || ""),
    posts: posts.length,
    postsWith50: rows.filter((r) => r.words >= 50).length,
    silent50: rows.filter((r) => r.words >= 50 && r.units.length === 0).map((r) => r.i),
    fragmented: rows.filter((r) => r.units.length > 1).map((r) => ({ i: r.i, words: r.words, units: r.units.map((u) => u.parts + "p/" + u.words + "w") })),
    crossing: rows.filter((r) => r.units.some((u) => u.crosses)).map((r) => r.i),
    rows: rows.map((r) => r.words + "w:" + (r.units.map((u) => u.parts + "p/" + u.words + "w").join("+") || "-")),
    outsidePosts: loose.slice(0, 8).map((u) => u.parts.length + "p/" + u.wordCount + "w@" + u.container.tagName.toLowerCase()),
  });
}
