// test/node/readerFrames.test.ts — the frames e-book readers show their books from
// (lib/surfaces/frames.ts): granting the reader's site asks for them too, and a grant of
// them reaches the reader's open tabs.
import { describe, expect, it } from "vitest";
import { readerFrames, readerSitesFor } from "../../lib/surfaces/frames";
import { ALL_SITES, browsingOrigins, matchesAny, sitePattern } from "../../lib/access/patterns";

describe("reader frames", () => {
  it("names the book's frame for Play Books, Libby and VitalSource, from the reader's hostname", () => {
    expect(readerFrames("play.google.com")).toEqual(["https://books.googleusercontent.com/*"]);
    expect(readerFrames("books.google.com")).toEqual(["https://books.googleusercontent.com/*"]);
    expect(readerFrames("libbyapp.com")).toEqual(["https://*.read.libbyapp.com/*"]);
    expect(readerFrames("bookshelf.vitalsource.com")).toEqual(["https://jigsaw.vitalsource.com/*"]);
  });

  it("asks for nothing more anywhere else, the frame's own host included", () => {
    for (const host of ["en.wikipedia.org", "www.google.com", "docs.google.com", "jigsaw.vitalsource.com", "vitalsource.com.example.org", "libbyapp.com.example.org", "overdrive.com"]) {
      expect(readerFrames(host), host).toEqual([]);
    }
  });

  it("covers the addresses the books are really served from, and nothing an all-sites grant would not", () => {
    const frames = ["play.google.com", "libbyapp.com", "bookshelf.vitalsource.com"].flatMap(readerFrames);
    expect(matchesAny(frames, "https://books.googleusercontent.com/books/content/reader/frame")).toBe(true);
    expect(matchesAny(frames, "https://dewey-8a0b.read.libbyapp.com/?d=1")).toBe(true);
    expect(matchesAny(frames, "https://jigsaw.vitalsource.com/books/9780000000000/epubcfi/6/10")).toBe(true);
    expect(matchesAny(frames, "https://libbyapp.com/shelf")).toBe(false);
    // Each is a browsing origin the registration follows, and inside the optional grant.
    expect(browsingOrigins(frames)).toEqual(frames);
    for (const f of frames) expect(matchesAny(ALL_SITES, f.replace("*.", "x.").replace(/\*$/, "")), f).toBe(true);
  });

  it("leads a grant of the frame back to the reader's open tabs", () => {
    const tab = (url: string): boolean => matchesAny(readerSitesFor(readerFrames(new URL(url).hostname)), url);
    expect(tab("https://play.google.com/books/reader?id=abc")).toBe(true);
    expect(tab("https://libbyapp.com/open/loan/1/2")).toBe(true);
    expect(tab("https://bookshelf.vitalsource.com/reader/books/1")).toBe(true);
    expect(readerSitesFor(["https://example.org/*"])).toEqual([]);
    // The site pattern the popup asks for is always among the sites the frame leads back to.
    for (const url of ["https://play.google.com/books/reader?id=abc", "https://libbyapp.com/open/loan/1/2", "https://bookshelf.vitalsource.com/reader/books/1"]) {
      const site = sitePattern(url) as string;
      expect(matchesAny(readerSitesFor(readerFrames(new URL(url).hostname)), url), site).toBe(true);
    }
  });
});
