// Automatic PDF routing is independent of source loading and authorization.
import { describe, expect, it } from "vitest";
import { shouldAutoOpen, type AutoOpenFacts } from "../../lib/pdf/route";

describe("the automatic route", () => {
  /** A PDF tab as it arrives with the setting on and nothing in the way. */
  const ordinary: AutoOpenFacts = {
    setting: true,
    contentType: "application/pdf",
    protocol: "https:",
    navigationType: "navigate",
    frame: 0,
    pass: false,
  };

  it("opens an ordinary PDF tab when the setting is on", () => {
    expect(shouldAutoOpen(ordinary)).toBe(true);
    expect(shouldAutoOpen({ ...ordinary, protocol: "http:" })).toBe(true);
    // A local PDF too: the tick that lets a content script run on file URLs is the same
    // one that lets the reader fetch them, so where this is asked at all it can be done.
    expect(shouldAutoOpen({ ...ordinary, protocol: "file:" })).toBe(true);
    // A reload of the PDF itself is an ordinary visit; the reader's own URL reloads as
    // the reader, which never reaches this decision at all.
    expect(shouldAutoOpen({ ...ordinary, navigationType: "reload" })).toBe(true);
  });

  it.each([
    ["the setting is off", { setting: false }],
    ["the document is not a PDF", { contentType: "text/html" }],
    ["the reader pressed Back out of the reading mode", { navigationType: "back_forward" }],
    ["the reader is on its way to the original", { pass: true }],
    ["the PDF is somebody's iframe, not the tab", { frame: 3 }],
    ["the PDF exists only in this tab (blob:)", { protocol: "blob:" }],
    ["the PDF exists only in this tab (data:)", { protocol: "data:" }],
    ["the tab is showing something that is not a document at all", { protocol: "about:" }],
  ])("leaves the tab alone when %s", (_why, override) => {
    expect(shouldAutoOpen({ ...ordinary, ...override })).toBe(false);
  });
});
