// test/node/report.test.ts — the copied report's rules that need no page: when a flagged
// paragraph gets a link, and how that link is written. Generating the fragment itself needs
// a real DOM and is checked in test/unit.mjs; opening it, in test/scenarios.mjs.
import { describe, expect, it } from "vitest";
import { mayLinkParagraphs } from "../../lib/render/report";
import { textDirective, withTextDirective } from "../../lib/render/textFragment";

describe("links to flagged paragraphs", () => {
  const page = "https://example.com/post";

  it("are given only when the report carries both the address and passage text", () => {
    expect(mayLinkParagraphs({ includeUrl: true, includeText: true, pageUrl: page })).toBe(true);
    // The link IS the address, so without it there is nothing to link.
    expect(mayLinkParagraphs({ includeUrl: false, includeText: true, pageUrl: page })).toBe(false);
    // … and it carries words of the paragraph, which the reader asked to keep out.
    expect(mayLinkParagraphs({ includeUrl: true, includeText: false, pageUrl: page })).toBe(false);
    expect(mayLinkParagraphs({ includeUrl: false, includeText: false, pageUrl: page })).toBe(false);
  });

  it("are given only on pages somebody else could open", () => {
    const ok = (pageUrl: string) => mayLinkParagraphs({ includeUrl: true, includeText: true, pageUrl });
    expect(ok("http://example.com/a")).toBe(true);
    expect(ok("file:///Users/me/notes.html")).toBe(false);
    expect(ok("chrome-extension://abcdef/reader.html?src=x")).toBe(false);
    expect(ok("moz-extension://abcdef/reader.html")).toBe(false);
    expect(ok("about:blank")).toBe(false);
    expect(ok("not a url")).toBe(false);
  });

  it("encode what the directive's own syntax and a Markdown link would read as punctuation", () => {
    expect(textDirective({ textStart: "self-attention, in (short)", textEnd: "R&D costs" })).toBe(
      "text=self%2Dattention%2C%20in%20%28short%29,R%26D%20costs",
    );
    expect(textDirective({ prefix: "as noted", textStart: "the model", suffix: "and so" })).toBe(
      "text=as%20noted-,the%20model,-and%20so",
    );
    expect(textDirective({ textStart: "café's 100% “quoted” text*!" })).toBe(
      "text=caf%C3%A9%27s%20100%25%20%E2%80%9Cquoted%E2%80%9D%20text%2A%21",
    );
  });

  it("keep the page's own fragment and replace a directive already on the address", () => {
    const f = { textStart: "first words", textEnd: "last words" };
    expect(withTextDirective(page, f)).toBe(`${page}#:~:text=first%20words,last%20words`);
    // An anchor stays: it is where the browser goes if the words are not found.
    expect(withTextDirective(`${page}#methods`, f)).toBe(`${page}#methods:~:text=first%20words,last%20words`);
    // A hash route decides what the page shows at all.
    expect(withTextDirective("https://app.example.com/#/thread/42?sort=new", f)).toBe(
      "https://app.example.com/#/thread/42?sort=new:~:text=first%20words,last%20words",
    );
    expect(withTextDirective(`${page}#:~:text=old`, f)).toBe(`${page}#:~:text=first%20words,last%20words`);
    expect(withTextDirective(`${page}?q=a#top:~:text=old&text=older`, f)).toBe(`${page}?q=a#top:~:text=first%20words,last%20words`);
  });
});
