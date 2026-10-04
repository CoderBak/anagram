// test/csp-page.mjs — what the Content-Security-Policy checks open and listen with, in
// Chromium (test/pw/csp.spec.mjs) and in Firefox (test/csp-firefox.mjs).
import { fakeScore } from "./fake-native.mjs";

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

/**
 * A page under a policy of its own that refuses every inline style, as some sites' is, with
 * a report-uri: whatever Anagram draws into it must draw anyway and leave the page nothing
 * to hear (Firefox holds what a content script writes into a page to the page's policy).
 * The page itself has no inline style, so any refusal is Anagram's. Its two paragraphs are
 * ones the fake host flags, so there are underlines to paint.
 */
const STRICT_PARA = (tag) =>
  `${tag} opens a paragraph long enough to be read on its own, on a page whose policy lets no ` +
  "inline style in at all, so that whatever Anagram adds to it — the chip, the card that opens " +
  "over it, the rules the underlines are painted with — has to arrive by a way the policy does " +
  "not govern, or the page would be told about every one of them and its reader would see " +
  `nothing at all of what was found in it, which is the whole point of reading it, ${tag}.`;
const STRICT_TAGS = [];
for (let n = 1; STRICT_TAGS.length < 2 && n < 5000; n++) if (fakeScore(STRICT_PARA(`STRICT-${n}`)).score >= 0.88) STRICT_TAGS.push(`STRICT-${n}`);
export const STRICT_POLICY = "default-src 'none'; style-src 'self'; img-src 'self'; report-uri /csp-report";
export const STRICT_ARTICLE =
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>A strict page</title></head>` +
  `<body>${STRICT_TAGS.map((tag) => `<p>${STRICT_PARA(tag)}</p>`).join("\n")}</body></html>`;

/** What the strict page shows once read, asked in the page (the test build's chips are open):
 *  its chips with a verdict, whether its underlines can paint — marks registered, and their
 *  rules in a sheet the page's policy has not refused — and where a card puts its marker. */
export const STRICT_PROBE = async (sel) => {
  const hosts = [...document.querySelectorAll(sel)];
  let marks = 0;
  for (const h of CSS.highlights?.values() ?? []) marks += h.size;
  const rules = [...document.adoptedStyleSheets, ...document.styleSheets].filter((s) => !s.disabled).flatMap((s) => {
    try {
      return [...s.cssRules].map((r) => r.cssText);
    } catch {
      return ["(a sheet the page may not read)"];
    }
  });
  const host = hosts[0];
  host?.dispatchEvent(new MouseEvent("mouseenter"));
  await new Promise((r) => setTimeout(r, 600));
  const marker = host?.shadowRoot?.querySelector(".card .dist .marker");
  host?.dispatchEvent(new MouseEvent("mouseleave"));
  return {
    chips: hosts.filter((h) => h.shadowRoot?.querySelector(".pill.scored")).length,
    marks,
    painted: rules.some((t) => t.includes("::highlight(anagram-")),
    rules: rules.length,
    marker: marker ? marker.style.left : null,
  };
};

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
