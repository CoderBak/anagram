// test/csp-page.mjs — what the Content-Security-Policy checks open and listen with, in
// Chromium (test/pw/csp.spec.mjs) and in Firefox (test/csp-firefox.mjs).

/** A page with enough prose for the pipeline to chip and the panel to list. */
const PARA =
  "A language model trained on ordinary prose will produce sentences that read as though " +
  "somebody wrote them on purpose, and the whole question this extension asks of a paragraph " +
  "is how far the writing has moved away from that, measured against text that nobody edited " +
  "at all, which is what the local daemon on this computer was trained to answer for any " +
  "paragraph of this length or longer.";
export const ARTICLE =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>An article</title></head>` +
  `<body><article><h1>An article</h1>${[1, 2, 3, 4]
    .map((n) => `<p>${PARA} This is paragraph number ${n} of it.</p>`)
    .join("")}</article></body></html>`;

/** Runs in every page before its own scripts do: collect refusals as they happen. */
export const WATCH = () => {
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) =>
    window.__csp.push(`${e.violatedDirective} → ${e.blockedURI || "inline"}`),
  );
};

/** A console line that is the browser complaining about this policy. */
export const isCspLine = (text) =>
  /Content Security Policy|Refused to (connect|load|execute|apply)|violates the following Content Security/i.test(
    text,
  );
