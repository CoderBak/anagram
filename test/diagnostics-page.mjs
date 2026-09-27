// test/diagnostics-page.mjs — the page "Copy page diagnostics" is checked on, in Chromium
// (test/pw/diagnostics.spec.mjs) and in Firefox (test/diagnostics-firefox.mjs).
//
// Every block below is here because it goes silent for a DIFFERENT reason, and the words
// in it are distinctive so the privacy assertion has something to look for.

const VOCAB =
  "the quick brown fox jumps over a lazy dog while rain falls gently on rooftops and children read books near warm windows during long quiet evenings".split(
    " ",
  );
export const words = (n, seed = 0) =>
  Array.from({ length: n }, (_, i) => VOCAB[(i * 7 + seed * 13) % VOCAB.length]).join(" ") + ".";

/** Strings that must never reach the clipboard, one per hiding place. */
export const SECRETS = {
  author: "Wilhelmina Bracklethorpe",
  mail: "wilhelmina.bracklethorpe@heliotrope.example",
  url: "https://intranet.example/thread/9182?session=OTTERGLASS77",
  data: "Nightjar rehearsal schedule",
  alt: "Saltmarsh watercolour",
  title: "Pennyroyal annotation",
  value: "Cinnabarquill",
  json: "Thistledown",
  comment: "Waxwing editorial memo",
};

const POST = (i) =>
  `<div class="post"><div class="byline">${["Ada", "Grace", "Karen", "Barbara", "Jean"][i]} · ${i + 1}h</div>` +
  `<p>${words(22, i + 3)}</p></div>`;

export const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title>
<style>body{max-width:760px;margin:20px auto;font:15px/1.6 system-ui}nav a{margin-right:8px}</style></head>
<body>
<!-- ${SECRETS.comment} -->
<script type="application/json">{"editor":"${SECRETS.json}","by":"${SECRETS.author}"}</script>
<nav class="site-nav">${Array.from({ length: 8 }, (_, i) => `<a href="${SECRETS.url}">${words(3, i)}</a>`).join(" ")}</nav>
<main>
  <article id="story" data-note="${SECRETS.data}">
    <h1 title="${SECRETS.title}">${words(5)}</h1>
    ${Array.from({ length: 6 }, (_, i) => `<p>${words(80, i)}</p>`).join("\n    ")}
  </article>

  <section class="feed">${Array.from({ length: 5 }, (_, i) => POST(i)).join("")}</section>

  <div class="link-list"><p>${Array.from({ length: 6 }, (_, i) => `<a href="${SECRETS.url}">${words(4, i + 9)}</a>`).join(" ")}</p></div>

  <pre><code>const ${SECRETS.json} = require("${SECRETS.value}");
function build(opts) { return opts.map((o) => o.id).filter(Boolean); }
if (!build([])) { throw new Error("empty"); }
module.exports = { build, ${SECRETS.json} };</code></pre>

  <p id="zh-long" lang="zh">这是一段用于测试的中文段落，它足够长，可以形成一个完整的分析单元。我们需要确认扩展程序能够正确地识别中文内容，并且在本地语言判定环节就把它挡下来，而不是把文字发送给后台的评分服务。段落里没有任何真实的个人信息，只有为了测试而写的普通句子。这样一来，报告里就可以准确地说明为什么这一段没有得到任何标记，以及是哪一条规则做出了这个判断。</p>

  <!-- A short Chinese paragraph with a heading on either side: a heading is a barrier, so
       it has nobody of its own voice to merge with and stays under the floor. -->
  <h2>${words(4, 31)}</h2>
  <p id="zh-short" lang="zh">这一段很短，不到七十五个词的下限，因此不会形成任何单元，旁边也没有同一段落可以合并。</p>
  <h2>${words(4, 33)}</h2>

  <div id="behind" aria-hidden="true"><p>${words(80, 11)}</p></div>

  <address>${SECRETS.author} &lt;${SECRETS.mail}&gt;</address>
  <img alt="${SECRETS.alt}" src="${SECRETS.url}" width="40" height="40">
  <form><input value="${SECRETS.value}"></form>
</main>
<iframe src="/frame.html" width="640" height="360" title="embed"></iframe>
</body></html>`;

export const FRAME = `<!doctype html><html lang="en"><body><p>${words(80, 21)}</p></body></html>`;
