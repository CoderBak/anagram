// test/node/popupState.test.ts — the popup leads with ONE action, and it is the right one.
//
// The popup opens over every kind of page there is, and the button at the top of it is the
// whole of what a new reader is offered: Anagram installs able to read no site, so the page
// under the popup is usually one it is doing nothing on. Every combination of the five
// facts the popup can know is settled here rather than in a browser, because four of the
// five states need a page no test browser can produce (a PDF tab, a browser page, a dead
// daemon, no tab at all).
import { describe, expect, it } from "vitest";
import { ACTION_LABEL, popupLead, type PageFacts } from "../../entrypoints/popup/state";

/** An ordinary granted http(s) page with Anagram running on it, as the base to vary. */
const RUNNING: PageFacts = {
  hasTab: true,
  pattern: "https://example.com/*",
  pdfTab: false,
  pdfReadable: true,
  tab: { enabled: true },
  daemon: "up",
};

const lead = (over: Partial<PageFacts>) => popupLead({ ...RUNNING, ...over });

describe("what the popup leads with", () => {
  it("offers another look at a page it is already reading", () => {
    // Not the main event: the page is already doing what it is there to do.
    expect(lead({})).toEqual({ action: "rescan", primary: false, status: "counts" });
  });

  it("offers the one run that needs no permission on a page it is off for", () => {
    // Switched off by a rule: the content script is there and says so.
    expect(lead({ tab: { enabled: false } })).toEqual({
      action: "analyze",
      primary: true,
      status: "off",
    });
    // Nothing granted for this site at all — nobody answered, which is every page on a
    // fresh install. The offer is the same one, and it writes nothing either.
    expect(lead({ tab: null })).toEqual({ action: "analyze", primary: true, status: "off" });
  });

  it("offers the reading mode on a PDF tab, and nothing else", () => {
    // Before the on/off state: the tab itself holds no text to score, so "Rescan page"
    // there would be a button that cannot do anything.
    expect(lead({ pdfTab: true })).toEqual({ action: "readPdf", primary: true, status: "none" });
    expect(lead({ pdfTab: true, tab: { enabled: false } })).toEqual({
      action: "readPdf",
      primary: true,
      status: "none",
    });
    // Firefox's viewer is a privileged page no content script reaches, so there is nobody
    // to hand the bytes over: the file has to come in through the reader's own drop zone.
    expect(lead({ pdfTab: true, pdfReadable: false })).toEqual({
      action: "openReader",
      primary: false,
      status: "unsupported",
    });
  });

  it("falls back to a PDF from this computer where nothing can run", () => {
    // A browser page, the web store, a `file:` URL: no origin pattern covers them.
    expect(lead({ pattern: null, tab: null })).toEqual({
      action: "openReader",
      primary: false,
      status: "unsupported",
    });
    // The popup opened with no active tab behind it at all.
    expect(lead({ hasTab: false, pattern: null, tab: null })).toEqual({
      action: "openReader",
      primary: false,
      status: "noTab",
    });
  });

  it("puts the daemon first, whatever the page is", () => {
    // Nothing anywhere can be scored while it is silent, so every page offers the same
    // one thing — and the status line beside it carries the command that fixes it.
    for (const over of [{}, { tab: null }, { pdfTab: true }, { pattern: null }, { hasTab: false }]) {
      expect(lead({ ...over, daemon: "down" })).toEqual({
        action: "retry",
        primary: true,
        status: "daemon",
      });
      expect(lead({ ...over, daemon: "mismatch" })).toEqual({
        action: "retry",
        primary: true,
        status: "daemon",
      });
    }
  });

  it("answers every page with one labelled action, and says counts only where there are some", () => {
    // Every combination of the facts, not a chosen few: the popup has to have an answer
    // for each of them, that answer has to have a label, and the two properties the
    // rebuild is for have to hold — a filled button only ever starts something, and the
    // counts line only ever appears over the button that re-reads a running page.
    const bools = [true, false];
    const seen = new Set<string>();
    let total = 0;
    for (const hasTab of bools)
      for (const pattern of ["https://example.com/*", null])
        for (const pdfTab of bools)
          for (const pdfReadable of bools)
            for (const tab of [null, { enabled: true }, { enabled: false }])
              for (const daemon of ["up", "down", "mismatch"] as const) {
                const got = popupLead({ hasTab, pattern, pdfTab, pdfReadable, tab, daemon });
                total += 1;
                seen.add(got.action);
                expect(ACTION_LABEL[got.action]).toBeTruthy();
                if (got.primary) expect(["analyze", "readPdf", "retry"]).toContain(got.action);
                expect(got.status === "counts").toBe(got.action === "rescan");
              }
    expect(total).toBe(144);
    // All five buttons are reachable — none of them is dead code.
    expect([...seen].sort()).toEqual(["analyze", "openReader", "readPdf", "rescan", "retry"]);
  });
});
