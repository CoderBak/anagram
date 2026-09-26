// test/node/sourceCode.test.ts — the AGPL "Source code" link in the Settings and setup footers.
// test/scenarios.mjs reads the rendered link (Chinese copy and the running version's tag).
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

  it.each(["options", "onboarding"])("sits in the %s footer and is pointed at the source when the page starts", (page) => {
    const html = read("entrypoints", page, "index.html");
    const footer = html.slice(html.indexOf('<footer class="foot">'), html.indexOf("</footer>"));
    expect(footer).toContain('data-i18n="modelLine"');
    expect(footer).toContain('<a id="sourceCode" target="_blank" rel="noopener noreferrer" data-i18n="sourceCodeLink">');
    expect(read("entrypoints", page, "main.ts")).toMatch(/^linkSourceCode\(\);$/m);
  });
});
