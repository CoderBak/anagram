// test/surveyCheck.ts — the scopes' kept survey (lib/dom/scope.ts, liveScopeSurvey) holds to a
// survey made anew: on the page it is run in, through `rounds` random changes of the kinds a
// page makes (classes, texts, attributes the survey reads, elements removed, moved, copied,
// wrapped and unwrapped, pictures of people, running text set beside an element), every
// element is asked of both after each change. Bundled into the unit page (test/unit-entry.ts).
import { liveScopeSurvey, surveyScopes } from "../lib/dom/scope";

/** A small seeded generator (mulberry32), so a failure can be run again. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ATTRIBUTES: [string, (string | null)[]][] = [
  ["class", ["", "post", "in-view", "post in-view", "comment", "avatar", "gmail_quote", null]],
  ["href", ["/u/alice", "/user/bob", "/people/carol", "https://elsewhere.example/author/x", "/r/sub", null]],
  ["title", ["2026-09-18 10:00", "3 March 2025, 10:00", "4.5 out of 5 stars", "a tooltip", null]],
  ["datetime", ["2026-09-18T10:00:00Z", null]],
  ["role", ["article", "main", "button", "navigation", "listitem", "heading", null]],
  ["aria-label", ["Rated 4 stars", "Post 3", null]],
  ["alt", ["5 stars", "a picture", null]],
  ["src", ["https://avatars.githubusercontent.com/u/1", "/x.png", null]],
  ["id", ["divRplyFwdMsg", "appendonsend", "x", null]],
  ["style", ["border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm", "color:red", null]],
  ["itemprop", ["reviewBody", "review", null]],
  ["hidden", ["", null]],
];

const TEXTS = ["", "ok", " · ", "replied", "3 hr. ago", "This is a long stretch of running text that reads like a sentence of somebody's post.", "From:", "Posted by"];

export function surveyHoldsUnderChange(seed: number, rounds: number): { mismatches: number; note: string } {
  const rand = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(rand() * list.length)]!;
  const live = liveScopeSurvey(() => document);
  const elements = (): Element[] => [...document.body.querySelectorAll("*")];
  const notes: string[] = [];
  let mismatches = 0;

  const compare = (round: number, what: string): void => {
    const kept = live();
    const fresh = surveyScopes(document);
    for (const el of document.querySelectorAll("*")) {
      const a = [kept.isPost(el), kept.hasByline(el), kept.historyAt(el)];
      const b = [fresh.isPost(el), fresh.hasByline(el), fresh.historyAt(el)];
      if (a[0] !== b[0] || a[1] !== b[1] || a[2] !== b[2]) {
        mismatches++;
        if (notes.length < 3) {
          const name = `${el.localName}${el.id ? `#${el.id}` : ""}${el.getAttribute("class") ? `.${el.getAttribute("class")!.trim().split(/\s+/).join(".")}` : ""}`;
          notes.push(`round ${round} after ${what}: ${name} kept [post ${a[0]}, byline ${a[1]}, history ${!!a[2]}] new [post ${b[0]}, byline ${b[1]}, history ${!!b[2]}]`);
        }
      }
    }
  };

  compare(0, "nothing");
  for (let round = 1; round <= rounds; round++) {
    const all = elements();
    if (all.length < 2) break;
    const el = pick(all);
    const op = Math.floor(rand() * 10);
    let what = "";
    if (op === 0 || op === 1) {
      const [name, values] = pick(ATTRIBUTES);
      const value = pick(values);
      if (value === null) el.removeAttribute(name);
      else el.setAttribute(name, value);
      what = `${name}=${value}`;
    } else if (op === 2) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const texts: Text[] = [];
      for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
      if (texts.length > 0) {
        const t = pick(texts);
        t.data = pick(TEXTS);
        what = `text "${t.data.slice(0, 12)}"`;
      }
    } else if (op === 3) {
      el.remove();
      what = `remove ${el.localName}`;
    } else if (op === 4) {
      const to = pick(all);
      if (to !== el && !el.contains(to)) {
        to.appendChild(el);
        what = `move ${el.localName} into ${to.localName}`;
      }
    } else if (op === 5) {
      el.after(el.cloneNode(true));
      what = `copy ${el.localName}`;
    } else if (op === 6) {
      const box = document.createElement("div");
      el.replaceWith(box);
      box.appendChild(el);
      what = `wrap ${el.localName}`;
    } else if (op === 7) {
      el.replaceWith(...el.childNodes);
      what = `unwrap ${el.localName}`;
    } else if (op === 8) {
      const a = document.createElement("a");
      a.href = pick(["/u/alice", "/user/bob", "/people/carol"]);
      const img = document.createElement("img");
      img.className = "avatar";
      a.appendChild(img);
      el.prepend(a);
      what = `picture of ${a.getAttribute("href")}`;
    } else {
      el.before(document.createTextNode(pick(TEXTS)));
      what = "text beside";
    }
    compare(round, what || "nothing");
  }
  return { mismatches, note: notes.join(" | ") };
}
