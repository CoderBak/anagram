// test/fixtures/capture.js — turn a region of a REAL page into a faithful, anonymous fixture.
//
// Segmentation bugs live in markup nobody would invent: X keeps a whole post in ONE text
// node with blank lines in it, Reddit hides comments in shadow roots, Zhihu needs a login
// to show anything at all. Fixtures written from memory miss exactly those details. This
// snippet is pasted into a page (DevTools console, or an automation tool's "run
// JavaScript") and returns an HTML string that lays out the same way for the walker:
//
//   - the element tree is kept as it is (nesting decides which paragraphs may merge),
//     with the attributes the walker reads: role, aria-hidden, contenteditable, translate,
//     lang, dir, datetime, data-testid, itemprop/itemtype, rel, and class/id tokens that
//     are words (hashed atoms such as "css-175oi2r" are dropped);
//   - every COMPUTED style the walker consults is written inline: display, white-space,
//     position (+ size and clip when out of flow), float, visibility, opacity 0,
//     font-size 0, writing-mode, content-visibility;
//   - display:none subtrees, media, scripts and our own chips are left out; open shadow
//     roots are kept as declarative <template shadowrootmode="open">;
//   - the TEXT IS NOT COPIED: every word becomes filler of the same length, script and
//     capitalisation, digits become 0, punctuation and line breaks stay where they were —
//     so word counts, sentence ends and blank-line paragraphs survive, and nothing a
//     person wrote (or their name) ends up in the repository.
//
// Usage in the page:   captureRegion({ root: "main", item: "article", max: 6 })
//   root  selector of the region (default: body)      item  selector of repeated posts
//   max   keep only the first `max` items (default 6)  limit hard cap on output chars
// Save the result as test/fixtures/<site>-<kind>.html with a comment saying where and when
// it was captured and what a reader should see (which blocks are one voice).
function captureRegion({ root = "body", item = null, max = 6, limit = 60000 } = {}) {
  const SKIP = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "VIDEO", "AUDIO", "CANVAS", "IFRAME", "OBJECT", "EMBED", "SOURCE", "TRACK", "PICTURE"]);
  const KEEP_ATTRS = ["role", "aria-hidden", "contenteditable", "translate", "lang", "dir", "datetime", "data-testid", "itemprop", "itemtype", "rel", "hidden", "open"];
  const LATIN = "loremipsumdolorsitametconsecteturadipiscingelit";
  const HAN = "文字段落示例内容测试语句结构分组";
  let li = 0;
  let hi = 0;
  const filler = (word) =>
    [...word]
      .map((ch) => {
        if (/\p{Script=Han}/u.test(ch)) return HAN[hi++ % HAN.length];
        if (/\p{Nd}/u.test(ch)) return "0";
        if (!/\p{L}/u.test(ch)) return ch;
        if (!/\p{Script=Latin}/u.test(ch)) return ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? "X" : "x";
        const f = LATIN[li++ % LATIN.length];
        return ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? f.toUpperCase() : f;
      })
      .join("");
  const anonymise = (s) => s.replace(/[\p{L}\p{Nd}]+/gu, filler);
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const wordy = (t) => t.split(/\s+/).filter((c) => /^[A-Za-z][A-Za-z_-]*$/.test(c)).slice(0, 6).join(" ");

  const region = document.querySelector(root);
  if (!region) return `<!-- capture: no element matches ${root} -->`;
  const items = item ? [...region.querySelectorAll(item)] : [];
  const dropped = new Set(items.slice(max));

  function styleOf(el) {
    const cs = getComputedStyle(el);
    const out = [`display:${cs.display}`];
    if (cs.whiteSpace !== "normal") out.push(`white-space:${cs.whiteSpace}`);
    if (cs.position === "absolute" || cs.position === "fixed") {
      out.push(`position:${cs.position}`, `width:${cs.width}`, `height:${cs.height}`);
      if (cs.clip !== "auto") out.push(`clip:${cs.clip}`);
      if (cs.clipPath !== "none") out.push(`clip-path:${cs.clipPath}`);
    }
    if (cs.float !== "none") out.push(`float:${cs.float}`);
    if (cs.visibility !== "visible") out.push(`visibility:${cs.visibility}`);
    if (cs.opacity === "0") out.push("opacity:0");
    if (parseFloat(cs.fontSize) === 0) out.push("font-size:0");
    if (cs.writingMode !== "horizontal-tb") out.push(`writing-mode:${cs.writingMode}`);
    if (cs.contentVisibility === "hidden") out.push("content-visibility:hidden");
    return out.join(";");
  }

  function ser(node) {
    if (node.nodeType === Node.TEXT_NODE) return esc(anonymise(node.textContent));
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node;
    const tag = el.tagName;
    if (SKIP.has(tag) || dropped.has(el) || el.hasAttribute("data-anagram")) return "";
    if (tag === "svg" || tag === "SVG") return "<svg></svg>";
    if (tag === "IMG") return `<img alt="${el.getAttribute("alt") ? "x" : ""}">`;
    if (tag === "BR") return "<br>";
    if (getComputedStyle(el).display === "none") return "";
    const name = tag.toLowerCase();
    let attrs = "";
    for (const a of KEEP_ATTRS) if (el.hasAttribute(a)) attrs += ` ${a}="${esc(el.getAttribute(a) || "").slice(0, 60)}"`;
    const cls = wordy(el.getAttribute("class") || "");
    if (cls) attrs += ` class="${cls}"`;
    const id = wordy(el.id || "");
    if (id) attrs += ` id="${id}"`;
    if (tag === "A") attrs += ' href="#"';
    attrs += ` style="${styleOf(el)}"`;
    let inner = "";
    if (el.shadowRoot) inner += `<template shadowrootmode="open">${[...el.shadowRoot.childNodes].map(ser).join("")}</template>`;
    inner += [...el.childNodes].map(ser).join("");
    if (!inner.trim() && !el.hasAttribute("role")) return ""; // empty wrappers (icon rows) say nothing
    return `<${name}${attrs}>${inner}</${name}>`;
  }

  const html = ser(region);
  const head = `<!-- captured ${new Date().toISOString().slice(0, 10)} from ${location.hostname}${location.pathname.replace(/[0-9]{4,}/g, "N").replace(/\/[^/]{12,}/g, "/…")} · root ${root}${item ? ` · first ${Math.min(max, items.length)} of ${items.length} ${item}` : ""} · text anonymised -->\n`;
  return head + (html.length > limit ? html.slice(0, limit) + "\n<!-- capture: truncated -->" : html);
}
