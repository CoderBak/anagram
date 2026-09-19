// lib/diagnostics/anonymise.ts — a page's SHAPE without a word of what it says.
//
// This is test/fixtures/capture.js as a module, with a stricter attribute policy. That
// snippet is pasted into a real page by hand during site work and has to keep working on
// its own, so the two live side by side; this one is the version the product ships, and
// what it produces is meant to be pasted into a chat by somebody who has not read either
// file. The rule both obey: the ELEMENT TREE survives — nesting, layout and the handful of
// attributes the walker consults decide how a page segments, so a fixture rebuilt from the
// output segments the way the original did — while the TEXT does not. Every word becomes
// filler of the same length, script and capitalisation, digits become 0, and punctuation
// and line breaks stay where they were, so word counts, sentence ends and blank-line
// paragraphs survive without a character anybody wrote leaving the page.
//
// Where the two differ, this file is the stricter one: URLs are dropped rather than
// replaced, an image is reduced to its box, `datetime` and `aria-label` are reported as
// PRESENT with no value, and class/id/testid tokens keep only word-shaped atoms (a hashed
// atom such as "css-175oi2r" says nothing about the markup and might say something about
// the reader). Anything not on the list below never reaches the output at all — that is
// what makes the privacy check in test/unit.mjs provable rather than hopeful.
import { tagOf } from "../dom/tags";

/** Filler alphabets. Latin words become lorem-ipsum letters, Han text becomes Han, so a
 *  rebuilt fixture still exercises the CJK paths (no spaces between words, a different
 *  word-counting rule) the original did. */
const LATIN = "loremipsumdolorsitametconsecteturadipiscingelit";
const HAN = "文字段落示例内容测试语句结构分组";

/** Tags whose content says nothing about segmentation and everything about the reader:
 *  scripts (JSON blobs of page state), styles, media and embedded documents. */
const SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META",
  "VIDEO", "AUDIO", "CANVAS", "IFRAME", "FRAME", "OBJECT", "EMBED", "SOURCE", "TRACK", "PICTURE",
]);

/** Attributes kept with a value, because the walker or the layout reads them and their
 *  values come from a fixed vocabulary rather than from a person. */
const KEEP_VALUE_ATTRS = ["role", "dir", "lang", "translate", "contenteditable", "rel", "type"];

/** Attributes kept as a bare PRESENCE marker: whether a `<time>` carries a machine date
 *  changes nothing about how it is read, while the date itself is content. */
const KEEP_PRESENCE_ATTRS = ["hidden", "open", "datetime", "disabled", "checked", "selected"];

/** Attributes whose value is a page-authored name rather than prose — kept, but only the
 *  word-shaped atoms of it (see `wordy`). */
const KEEP_TOKEN_ATTRS = ["data-testid", "itemprop"];

/** ARIA values that are enumerated by the specification, so printing them leaks nothing.
 *  Every other aria-* value (aria-label, aria-description, aria-valuetext) is prose. */
const ARIA_ENUM_RE =
  /^(?:true|false|mixed|undefined|none|inherit|off|polite|assertive|page|step|location|date|time|vertical|horizontal|ascending|descending|other|grammar|spelling|list|tree|grid|dialog|menu|both|inline|all|copy|move|link|execute|popup|additions|removals|text|\d+)$/i;

/** Word-shaped class/id atoms: letters, dashes and underscores. A token with digits or
 *  hashes in it ("css-175oi2r", "sc-1f2a3b") is generated and carries no meaning; six of
 *  them are more than enough to recognise a container by. */
const WORDY_RE = /^[A-Za-z][A-Za-z_-]*$/;
const MAX_WORDY_TOKENS = 6;

/** Keep only the word-shaped atoms of a class list, id or test id. */
export function wordy(value: string | null | undefined): string {
  if (!value) return "";
  return String(value)
    .split(/\s+/)
    .filter((token) => WORDY_RE.test(token))
    .slice(0, MAX_WORDY_TOKENS)
    .join(" ");
}

/**
 * A filler generator. The counters run across a whole capture so the same page always
 * produces the same shape of nonsense, and no word ever maps back to what it replaced:
 * the only thing carried over is each character's CLASS (Latin letter, Han character,
 * digit, everything else) and, for Latin, its case.
 */
export function createFiller(): (text: string) => string {
  let latinAt = 0;
  let hanAt = 0;
  const word = (w: string): string =>
    [...w]
      .map((ch) => {
        if (/\p{Script=Han}/u.test(ch)) return HAN[hanAt++ % HAN.length];
        if (/\p{Nd}/u.test(ch)) return "0";
        if (!/\p{L}/u.test(ch)) return ch;
        // A letter outside Latin and Han keeps only its case: Cyrillic, Greek, Arabic and
        // Hangul all count words the way Latin does, so the shape is all that matters.
        if (!/\p{Script=Latin}/u.test(ch)) return ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? "X" : "x";
        const f = LATIN[latinAt++ % LATIN.length];
        return ch === ch.toUpperCase() && ch !== ch.toLowerCase() ? f.toUpperCase() : f;
      })
      .join("");
  return (text: string) => text.replace(/[\p{L}\p{Nd}]+/gu, word);
}

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The anonymised name of one element: `article.post.card#main[role=article]`. */
export function nameOf(el: Element): string {
  const tag = tagOf(el).toLowerCase();
  const cls = wordy(el.getAttribute("class"));
  const id = wordy(el.id);
  const role = el.getAttribute("role");
  return (
    tag +
    (cls ? "." + cls.split(" ").join(".") : "") +
    (id ? "#" + id.split(" ")[0] : "") +
    (role && WORDY_RE.test(role) ? `[role=${role}]` : "")
  );
}

/**
 * Where an element sits, as a reader of the report can follow it in DevTools:
 * `main > div.feed > article.post > div.body > p`. The chain crosses shadow boundaries the
 * way the walk does (a host stands in for its root) and stops at `stopAt`, or after
 * `maxDepth` steps — a path forty containers long says less than its last five.
 */
export function pathOf(el: Element, stopAt: Element | null = null, maxDepth = 6): string {
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur !== stopAt && parts.length < maxDepth) {
    parts.unshift(nameOf(cur));
    const parent: ParentNode | null = cur.parentElement ?? (cur.getRootNode() as ShadowRoot).host ?? null;
    cur = parent instanceof Element ? parent : null;
  }
  return (cur && cur !== stopAt ? "… > " : "") + parts.join(" > ");
}

/** The computed facts the walk and the chip placement read — never the page's own CSS. */
function styleOf(el: Element): string {
  let cs: CSSStyleDeclaration;
  try {
    cs = getComputedStyle(el);
  } catch {
    return "";
  }
  const out = [`display:${cs.display}`];
  if (cs.whiteSpace !== "normal") out.push(`white-space:${cs.whiteSpace}`);
  if (cs.position === "absolute" || cs.position === "fixed") {
    out.push(`position:${cs.position}`, `width:${cs.width}`, `height:${cs.height}`);
    if (cs.clip !== "auto" && cs.clip !== "") out.push(`clip:${cs.clip}`);
    if (cs.clipPath !== "none") out.push(`clip-path:${cs.clipPath}`);
  }
  if (cs.cssFloat !== "none") out.push(`float:${cs.cssFloat}`);
  if (cs.visibility !== "visible") out.push(`visibility:${cs.visibility}`);
  if (cs.opacity === "0") out.push("opacity:0");
  if (parseFloat(cs.fontSize) === 0) out.push("font-size:0");
  if (cs.writingMode !== "horizontal-tb") out.push(`writing-mode:${cs.writingMode}`);
  // Read through getPropertyValue: these two are not in every TypeScript DOM library and
  // an engine that has never heard of them answers "" rather than throwing.
  if (cs.getPropertyValue("content-visibility") === "hidden") out.push("content-visibility:hidden");
  // What clips a "see more" box, which is why a paragraph can be on the page and not on
  // the screen: the clamp itself, and an overflow that hides what does not fit.
  const clamp = cs.getPropertyValue("-webkit-line-clamp");
  if (clamp && clamp !== "none") out.push(`-webkit-line-clamp:${clamp}`);
  if (cs.overflowY === "hidden" || cs.overflowY === "clip") out.push(`overflow-y:${cs.overflowY}`);
  if (cs.maxHeight !== "none") out.push(`max-height:${cs.maxHeight}`);
  return out.join(";");
}

/** Every attribute this file will ever print, with the value policy applied. */
function attrsOf(el: Element): string {
  let out = "";
  for (const name of KEEP_VALUE_ATTRS) {
    const v = el.getAttribute(name);
    if (v !== null) out += ` ${name}="${esc(v).slice(0, 40)}"`;
  }
  for (const name of KEEP_PRESENCE_ATTRS) if (el.hasAttribute(name)) out += ` ${name}=""`;
  for (const name of KEEP_TOKEN_ATTRS) {
    const v = wordy(el.getAttribute(name));
    if (v) out += ` ${name}="${v}"`;
  }
  // itemtype is a vocabulary URL (https://schema.org/Article); only its last segment says
  // anything, and a URL is exactly what must not travel.
  const itemtype = el.getAttribute("itemtype");
  if (itemtype) {
    const kind = wordy(itemtype.split(/[/#]/).pop() ?? "");
    if (kind) out += ` itemtype="${kind}"`;
  }
  for (const attr of Array.from(el.attributes)) {
    if (!attr.name.startsWith("aria-")) continue;
    out += ` ${attr.name}="${ARIA_ENUM_RE.test(attr.value.trim()) ? esc(attr.value.trim()) : ""}"`;
  }
  const cls = wordy(el.getAttribute("class"));
  if (cls) out += ` class="${cls}"`;
  const id = wordy(el.id);
  if (id) out += ` id="${id}"`;
  const style = styleOf(el);
  if (style) out += ` style="${style}"`;
  return out;
}

export interface CaptureResult {
  html: string;
  /** The capture stopped at `limit` characters — the region is bigger than this. */
  truncated: boolean;
}

/**
 * Serialise a region as anonymous HTML. `limit` is a hard cap on the output: a page's main
 * column can be megabytes, and what the report is for is the SHAPE of the first screens of
 * it, so the walk stops dead once it has produced enough.
 */
export function captureRegion(region: Element, limit = 24_000): CaptureResult {
  const filler = createFiller();
  const parts: string[] = [];
  let size = 0;
  let truncated = false;

  const emit = (s: string): void => {
    if (truncated || s === "") return;
    if (size + s.length > limit) {
      truncated = true;
      return;
    }
    parts.push(s);
    size += s.length;
  };

  function ser(node: Node): void {
    if (truncated) return;
    if (node.nodeType === Node.TEXT_NODE) {
      emit(esc(filler(node.textContent ?? "")));
      return;
    }
    // Comment nodes and processing instructions hold templating state and, now and then, a
    // whole draft of the page — they are not markup a reader sees and never come along.
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = tagOf(el);
    if (SKIP_TAGS.has(tag) || el.hasAttribute("data-anagram")) return;
    if (tag === "SVG") {
      emit("<svg></svg>"); // its paths are a picture; its <title> is prose
      return;
    }
    if (tag === "IMG") {
      const box = el.getBoundingClientRect();
      emit(`<img data-box="${Math.round(box.width)}x${Math.round(box.height)}">`);
      return;
    }
    if (tag === "BR") {
      emit("<br>");
      return;
    }
    let display = "";
    try {
      display = getComputedStyle(el).display;
    } catch {
      /* a detached or foreign element — serialise it as it stands */
    }
    if (display === "none") return; // takes no space: it is not why a reader sees nothing
    const name = tag.toLowerCase();
    const open = `<${name}${attrsOf(el)}>`;
    const mark = parts.length;
    emit(open);
    if (el.shadowRoot) {
      emit('<template shadowrootmode="open">');
      for (const child of el.shadowRoot.childNodes) ser(child);
      emit("</template>");
    }
    for (const child of el.childNodes) ser(child);
    // An empty wrapper (an icon row, a spacer) says nothing about segmentation, so it is
    // dropped again — unless it declares a role, where its emptiness is the finding.
    if (parts.length === mark + 1 && !el.hasAttribute("role")) {
      parts.pop();
      size -= open.length;
      return;
    }
    emit(`</${name}>`);
  }

  ser(region);
  return { html: parts.join(""), truncated };
}
