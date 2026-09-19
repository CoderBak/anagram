// test/node/pageCopy.test.ts — the English a page is WRITTEN in is the English message.
//
// lib/ui/localize.ts leaves an English UI's markup untouched ("the page already says the
// right thing"), so for an English reader the words in entrypoints/*/index.html are the
// product and public/_locales/en/messages.json is not. Nothing held the two together, and
// they drifted: a release changed what a score looks like and how the marks are drawn in
// the messages, and the onboarding and options pages went on saying "0%…100%" and "a
// matching underline" to everybody who reads English. This reads every page the way the
// localiser does and requires the markup to say exactly what the message says.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// linkedom is what WXT itself parses entrypoint HTML with, so it is always installed
// beside wxt; nothing else in the suite needs a DOM.
import { parseHTML } from "linkedom";

const ROOT = join(__dirname, "..", "..");
const EN: Record<string, { message: string }> = JSON.parse(
  readFileSync(join(ROOT, "public", "_locales", "en", "messages.json"), "utf8"),
);

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

/** A `data-i18n-html` container as the message it stands for: its own text, with each of
 *  its element children put back as $1…$9 in order — what applyParts splits on. */
function asMessage(el: Element): string {
  const parts = [...el.children];
  let out = "";
  for (const node of el.childNodes) {
    if (node.nodeType === 3) out += node.textContent ?? "";
    else if (node.nodeType === 1) out += `$${parts.indexOf(node as Element) + 1}`;
  }
  return squash(out);
}

const pages = readdirSync(join(ROOT, "entrypoints"))
  .map((name) => ({ name, file: join(ROOT, "entrypoints", name, "index.html") }))
  .filter((p) => existsSync(p.file));

describe("an English page says what the English messages say", () => {
  for (const page of pages) {
    it(`${page.name}/index.html`, () => {
      const { document } = parseHTML(readFileSync(page.file, "utf8"));
      const wrong: string[] = [];
      const check = (key: string | null, actual: string, how: string): void => {
        if (!key) return;
        const message = EN[key]?.message;
        if (message === undefined) return; // an unknown key is test/node/i18n.test.ts's to report
        if (squash(message) !== actual) wrong.push(`${how} ${key}\n    page:    ${actual}\n    message: ${squash(message)}`);
      };

      for (const el of document.querySelectorAll("[data-i18n]")) {
        const key = el.getAttribute("data-i18n");
        // A message with a placeholder is filled in by the page's script, not written here.
        if (key && /\$[1-9]/.test(EN[key]?.message ?? "")) continue;
        check(key, squash(el.textContent ?? ""), "data-i18n");
      }
      for (const el of document.querySelectorAll("[data-i18n-html]")) {
        check(el.getAttribute("data-i18n-html"), asMessage(el), "data-i18n-html");
      }
      for (const [attr, target] of [
        ["data-i18n-title", "title"],
        ["data-i18n-aria-label", "aria-label"],
        ["data-i18n-placeholder", "placeholder"],
      ] as const) {
        for (const el of document.querySelectorAll(`[${attr}]`)) {
          check(el.getAttribute(attr), squash(el.getAttribute(target) ?? ""), attr);
        }
      }
      expect(wrong, wrong.join("\n")).toEqual([]);
    });
  }
});
