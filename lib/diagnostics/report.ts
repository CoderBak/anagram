// lib/diagnostics/report.ts — the text the right-click entry puts on the clipboard.
//
// It is written for ONE reader: whoever has to make a failing site into a fixture. So it
// is in English whatever the interface is in, it is Markdown-ish because it is pasted into
// a chat, and it is capped at a size a chat will take. Everything in it is either a
// number, a tag name, a class token the page's own author wrote, or a computed style —
// never a word of the page (see ./anonymise.ts for the policy and test/unit.mjs for the
// check that proves it).
//
// The order answers the questions in the order they are asked: what is this and is Anagram
// even on (header), how much did it read (counts), what did it refuse and why (silence —
// the part worth having), what else is on the page (frames), and finally the shape of the
// region itself, anonymised, which is the fixture.
//
// NOTHING HERE TOUCHES AN EXTENSION API. This module and the two beside it are built as an
// on-demand chunk (scripts/vendor.mjs → public/vendor/diagnostics.min.mjs) so the content
// script that runs on every page does not carry twenty kilobytes for a menu entry almost
// nobody uses; a chunk loaded by URL has no `#imports` to resolve. Everything the platform
// knows is handed in as `DiagnosticsEnv` by lib/diagnostics/index.ts, which is the part
// that does run in the content script. It also makes the whole report provable in a plain
// browser page, which is where test/unit.mjs checks that no page text escapes it.
import { findMainContent } from "../dom/mainContent";
import { MIN_MERGE_WORDS } from "../dom/text";
import { captureRegion, pathOf } from "./anonymise";
import { surveyPage, type SilentStretch } from "./silence";
import { HYDRATION_MARKERS } from "./vocabulary";

/** What a chat window will take without complaint, and what a reviewer will read. */
export const MAX_BYTES = 60_000;
/** How many silent stretches are worth naming. Past this the answer repeats itself. */
export const MAX_SILENT = 15;

/** What the daemon is doing, reduced to the four answers that change what to do next. */
export interface DaemonFacts {
  state: "up" | "idle" | "down" | "contract" | "unknown";
  /** Model identity when it is up — it decides the verdicts and belongs in a bug report. */
  model?: string;
  device?: string;
  /** The contract string a mismatched daemon reported. */
  contract?: string;
}

/** Everything the page cannot find out for itself, gathered by the content script. */
export interface DiagnosticsEnv {
  version: string;
  manifestVersion: number;
  /** The language the browser asked for, and the one the message files answered with —
   *  they differ on a zh-TW browser, and that difference has been a bug report before. */
  uiLanguage: string;
  messageLocale: string;
  analysisScope: string;
  mergeShorts: boolean;
  displayMode: string;
  /** The per-site rule that decides this host, and the global switch behind it. */
  siteRule: { host: string; mode: string } | null;
  globallyEnabled: boolean;
  daemon: DaemonFacts;
  /** Anagram is analyzing this page — by the settings, or for this page only. */
  running: boolean;
  /** The run was asked for once from the context menu, against the settings. */
  onceForPage: boolean;
  /** The browser has translated the page, which stops any run (lib/dom/translation.ts). */
  translated?: boolean;
  /** The tab is a PDF the browser's own viewer is showing. */
  pdf: boolean;
  /** Google Docs, and in which shape ("editor" / "reading"). */
  docs: string | null;
  counts: { scored: number; flagged: number; unsupported: number; unavailable: number };
  /** The size gate a subframe has to pass to be scanned at all. */
  frameGate: { minWidth: number; minArea: number };
  /** The frame the reader right-clicked in; 0 is the page itself. */
  clickedFrameId: number;
  /** What they right-clicked, when the page still holds it. */
  target: Element | null;
  /** The extension's own language pre-gate (lib/capture/langGate.ts), handed in because
   *  it is the browser's detector and this module may not call one. */
  detectLanguage: (text: string) => Promise<{ lang: string; prob: number } | null>;
}

// ---- small facts about the platform ----------------------------------------------------

/** The browser and its version, taken from the user agent by a fixed pattern rather than
 *  copied out of it — a UA string can carry whatever a vendor or an enterprise put there. */
function browserVersion(): string {
  const ua = navigator.userAgent;
  const patterns: [string, RegExp][] = [
    ["Firefox", /Firefox\/([\d.]+)/],
    ["Edge", /Edg\/([\d.]+)/],
    ["Opera", /OPR\/([\d.]+)/],
    ["Chrome", /Chrome\/([\d.]+)/],
    ["Safari", /Version\/([\d.]+).*Safari/],
  ];
  for (const [name, re] of patterns) {
    const m = re.exec(ua);
    if (m) return `${name} ${m[1]}`;
  }
  return "unknown browser";
}

function daemonLine(daemon: DaemonFacts): string {
  switch (daemon.state) {
    case "up":
      return `daemon: up · ${daemon.model ?? "no model reported"}${daemon.device ? ` on ${daemon.device}` : ""}`;
    case "idle":
      return "daemon: idle (model unloaded; scoring wakes it automatically)";
    case "contract":
      return `daemon: CONTRACT MISMATCH — it speaks ${daemon.contract ?? "?"}, this build speaks another major`;
    case "down":
      return "daemon: down (nothing answered the last probe)";
    default:
      return "daemon: unknown (the service worker did not answer)";
  }
}

/** Which framework marker the page carries, if any. */
function hydrationMarker(): string {
  for (const [selector, name] of HYDRATION_MARKERS) {
    try {
      if (document.querySelector(selector)) return name;
    } catch {
      /* a selector this engine will not parse — try the next */
    }
  }
  return "none";
}

// ---- frames -----------------------------------------------------------------------------

/** Subframes, by origin and size only. v1 never looks inside one: a cross-origin frame
 *  cannot be read from here at all, and a same-origin one has its own content script. */
function frameLines(env: DiagnosticsEnv): string[] {
  const frames = Array.from(document.querySelectorAll("iframe,frame"));
  if (frames.length === 0) return ["- no subframes"];
  const out = [`- ${frames.length} subframe(s); this report covers the top frame only`];
  for (const frame of frames.slice(0, 12)) {
    const raw = frame.getAttribute("src") ?? "";
    let where = raw === "" ? (frame.hasAttribute("srcdoc") ? "srcdoc" : "about:blank") : "(unparsable src)";
    // A srcdoc or about:blank frame, or a blob: document, has no address of its own and runs
    // our script by the origin it takes from this page (lib/access/worker.ts). A data:
    // document takes none.
    let scriptable = raw === "";
    try {
      if (raw !== "") {
        const url = new URL(raw, location.href);
        where = url.protocol === "http:" || url.protocol === "https:" ? url.hostname : url.protocol;
        scriptable =
          url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:" ||
          url.protocol === "about:" || url.protocol === "blob:";
      }
    } catch {
      /* an address that does not parse */
    }
    // A sandbox without allow-same-origin takes the origin away, whatever the address, and
    // the content script leaves such a frame alone (entrypoints/content.ts).
    const sandbox = frame.getAttribute("sandbox");
    const opaque = sandbox !== null && !sandbox.split(/\s+/).includes("allow-same-origin");
    const box = frame.getBoundingClientRect();
    const w = Math.round(box.width);
    const h = Math.round(box.height);
    const gate = w >= env.frameGate.minWidth && w * h >= env.frameGate.minArea;
    const verdict = opaque
      ? "no content script (a sandboxed frame has no origin a grant could cover)"
      : !scriptable
      ? "no content script (not an http(s)/file document, nor one that takes this page's origin)"
      : gate
        ? "our content script runs there and passes the size gate"
        : `our content script runs there but the frame is under the size gate (${env.frameGate.minWidth}px wide, ${env.frameGate.minArea}px² needed)`;
    out.push(`  - ${where} · ${w}×${h} · ${verdict}`);
  }
  if (frames.length > 12) out.push(`  - … and ${frames.length - 12} more`);
  return out;
}

// ---- the region whose structure is captured ---------------------------------------------

/**
 * The smallest ancestor of the click that still holds a body of text — a post, a card, an
 * article — so the fixture is of the thing that went wrong rather than of the whole page.
 * With no click to go on, the page's own main region answers; Defuddle is not loaded
 * here, so that is the text-mass probe's answer rather than the precision scope's.
 */
function regionFor(target: Element | null): { el: Element; why: string } {
  if (target && target.isConnected) {
    let cur: Element | null = target;
    for (let up = 0; cur && up < 8; up++) {
      if ((cur.textContent ?? "").trim().length >= 200) return { el: cur, why: "the box you right-clicked in" };
      cur = cur.parentElement;
    }
    if (target.parentElement) {
      return { el: target.parentElement, why: "the box you right-clicked in (it holds little text)" };
    }
  }
  const main = findMainContent(document);
  if (main) return { el: main, why: "the page's main content region" };
  return { el: document.body, why: "<body> — no main region stands out" };
}

// ---- the report --------------------------------------------------------------------------

export async function buildDiagnostics(env: DiagnosticsEnv): Promise<string> {
  const survey = surveyPage({ running: env.running, max: MAX_SILENT });
  const coverage = survey.proseWords > 0 ? Math.round((survey.wordsJudged / survey.proseWords) * 100) : 0;

  const lines: string[] = [];
  lines.push("# Anagram page diagnostics");
  lines.push("");
  lines.push(
    `- Anagram ${env.version} (MV${env.manifestVersion}) · ${browserVersion()} · ` +
      `UI language ${env.uiLanguage} (messages ${env.messageLocale})`,
  );
  lines.push(
    `- host \`${location.hostname || "(none)"}\` (${location.protocol}) · ` +
      `document language \`${document.documentElement.lang || "unset"}\` · content type ${document.contentType}`,
  );
  lines.push(
    `- viewport ${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}× · ` +
      `${document.getElementsByTagName("*").length} elements · hydration marker: ${hydrationMarker()}`,
  );
  lines.push(
    `- scope \`${env.analysisScope}\` · merge short paragraphs ${env.mergeShorts ? "on" : "off"} · show \`${env.displayMode}\``,
  );
  lines.push(`- ${stateLine(env)}`);
  lines.push(`- ${daemonLine(env.daemon)}`);
  if (env.clickedFrameId !== 0) {
    lines.push(`- you right-clicked inside subframe #${env.clickedFrameId}; v1 reports the TOP frame only`);
  }

  lines.push("");
  lines.push("## Counts");
  lines.push(
    `- units ${survey.units.length} (${survey.multiPartUnits} multi-part) · ` +
      `chips on the page ${survey.chips}`,
  );
  lines.push(
    `- chips rendered ${env.counts.scored} · flagged ${env.counts.flagged} · ` +
      `unavailable ${env.counts.unavailable} · unsupported language ${env.counts.unsupported}`,
  );
  lines.push(
    `- words judged ${survey.wordsJudged} of ${survey.proseWords} visible prose words (${coverage} %), ` +
      `${survey.chromeWords} more in page chrome`,
  );
  lines.push(
    `- ${survey.examined} boxes over the ${MIN_MERGE_WORDS}-word floor examined · ` +
      `${survey.shadowRoots} open shadow root(s)`,
  );
  if (survey.darkElements.length > 0) {
    lines.push(
      `- ${survey.darkElements.join(", ")} draw a box and expose no text — a CLOSED shadow root ` +
        "hides its text from every script on the page, ours included",
    );
  }

  lines.push("");
  lines.push(`## Why the rest is silent (largest ${survey.silent.length})`);
  if (survey.silent.length === 0) {
    lines.push("- nothing over the floor was left out");
  } else {
    let n = 0;
    for (const stretch of survey.silent) {
      lines.push(`${String(++n).padStart(2)}. ${stretch.words}w · \`${stretch.path}\``);
      lines.push(`    ${await reasonOf(stretch, env)}`);
      if (stretch.note) lines.push(`    site: ${stretch.note}`);
    }
  }

  lines.push("");
  lines.push("## Frames");
  lines.push(...frameLines(env));

  const region = regionFor(env.target);
  lines.push("");
  lines.push(`## Structure, anonymised — ${region.why}`);
  lines.push(`- \`${pathOf(region.el)}\` (${region.el.getElementsByTagName("*").length} elements inside it)`);
  lines.push("");
  const budget = MAX_BYTES - byteLength(lines.join("\n")) - 200;
  const captured = captureRegion(region.el, Math.max(0, budget));
  lines.push("```html");
  lines.push(captured.html);
  if (captured.truncated) lines.push("<!-- truncated: the region is larger than this report may carry -->");
  lines.push("```");

  return cap(lines.join("\n") + "\n");
}

/** Is Anagram on here, and on whose say-so — the first thing to know about a page that
 *  shows nothing, and the one thing a broken page still answers. */
function stateLine(env: DiagnosticsEnv): string {
  const where = env.pdf
    ? " · this tab is a PDF in the browser's own viewer"
    : env.docs
      ? ` · Google Docs (${env.docs})`
      : "";
  if (env.translated) {
    return `state: PAUSED — the browser has translated this page (html.translated-ltr/rtl); nothing is read until it shows the original${where}`;
  }
  if (!env.running) {
    if (env.siteRule?.mode === "off") return `state: DISABLED for this site by rule \`${env.siteRule.host}\`${where}`;
    if (!env.globallyEnabled) return `state: DISABLED — the global switch is off${where}`;
    return `state: not analyzing this frame${where}`;
  }
  if (env.onceForPage) {
    return `state: running for this page only (from the right-click menu; the settings say off)${where}`;
  }
  return `state: running${env.siteRule ? ` (site rule \`${env.siteRule.host}\`: ${env.siteRule.mode})` : ""}${where}`;
}

/**
 * The reason, finished. A stretch the walk refused already carries its own; a stretch that
 * became a unit and drew nothing is the language gate, the daemon or the display mode, and
 * the language question can only be asked asynchronously.
 */
async function reasonOf(stretch: SilentStretch, env: DiagnosticsEnv): Promise<string> {
  // The language is asked for every stretch, not only the undrawn ones: where a box became
  // a unit and nothing was drawn it IS the answer, and where the walk refused the box it is
  // still what a reader of the report needs to know before reaching for the markup.
  const detected = await env.detectLanguage(stretch.el.textContent ?? "").catch(() => null);
  const language = detected
    ? ` · the language gate reads this as "${detected.lang}" (${detected.prob}) and EditLens reads English`
    : "";
  if (!stretch.undrawn) return stretch.reason + language;
  if (detected) {
    return `a unit was made and nothing drawn — the local language gate settled it as "${detected.lang}" (${detected.prob}); EditLens reads English`;
  }
  if (env.daemon.state === "down" || env.daemon.state === "contract") {
    return 'a unit was made and nothing drawn — the daemon did not answer, so the verdict is "Unavailable"';
  }
  if (env.displayMode === "flagged") {
    return 'a unit was made and nothing drawn — "show flagged only" is on and this verdict is not flagged';
  }
  return "a unit was made and nothing drawn — the scan is viewport-first, so it may not have reached this box yet";
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/** A last, blunt cut: the structure budget is computed in bytes, but a Han-heavy page can
 *  still overshoot it, and a report too big to paste is a report nobody reads. */
function cap(text: string): string {
  if (byteLength(text) <= MAX_BYTES) return text;
  const note = "\n\n(truncated at 60 kB)\n";
  let cut = text.slice(0, MAX_BYTES - note.length);
  while (byteLength(cut) > MAX_BYTES - note.length) cut = cut.slice(0, -256);
  return cut + note;
}
