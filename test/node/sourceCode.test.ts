// test/node/sourceCode.test.ts — the AGPL "Source code" link in the Settings and setup pages.
// test/pw/scenarios-i18n.spec.mjs reads the rendered link (Chinese copy and the running version's tag).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sourceCodeUrl } from "../../lib/ui/sourceCode";

const ROOT = join(__dirname, "..", "..");
const read = (...parts: string[]): string => readFileSync(join(ROOT, ...parts), "utf8");

describe("the source code link", () => {
  it("points at the release tag of the running version", () => {
    expect(sourceCodeUrl("0.7.0")).toBe("https://github.com/CoderBak/anagram/tree/v0.7.0");
  });

  it.each([["options", "footer", "modelLine"], ["onboarding", "nav", "onbOpenSettings"]])("sits in the %s page's links and is pointed at the source when the page starts", (page, tag, other) => {
    const html = read("entrypoints", page, "index.html");
    const links = html.slice(html.indexOf(`<${tag} class="links">`), html.indexOf(`</${tag}>`));
    expect(links).toContain(`data-i18n="${other}"`);
    expect(links).toContain('<a id="sourceCode" target="_blank" rel="noopener noreferrer" data-i18n="sourceCodeLink">');
    expect(read("entrypoints", page, "main.ts")).toMatch(/^linkSourceCode\(\);$/m);
  });

  it("keeps the model's licence on the setup page, where the person first sees the extension", () => {
    expect(read("entrypoints", "onboarding", "index.html")).toContain('data-i18n="onbModelNotice"');
  });
});
