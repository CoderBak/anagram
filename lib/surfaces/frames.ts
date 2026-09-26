// lib/surfaces/frames.ts — e-book readers that show the book from another address.
//
// Google Play Books, Libby and VitalSource Bookshelf are pages that hold the book in a frame
// of a different origin: the reader chrome is play.google.com, the chapter is
// books.googleusercontent.com. Access is granted per site and a content script runs only in
// frames whose own origin is granted, so turning Anagram on for the reader's site reached
// nothing of the book — the frame's text is ordinary markup the walk reads well, but no
// script was ever put there. Granting such a site therefore asks for the book's address too,
// in the same prompt, which names both. Nothing is fetched from either: the script reads the
// frame the reader itself opened.
//
// The frames are the ones Read Aloud asks permission for (js/content-handlers.js,
// https://github.com/ken107/read-aloud, MIT licence, Copyright (c) 2016 Hai Phan and
// contributors). Readers whose frames hold nothing Anagram reads are left out: Chegg's
// eReader draws its pages with pdf2htmlEX, and Word's editor frames are an editor.
// Pure string work, tested in test/node/readerFrames.test.ts.

/** Reader sites (as match patterns of the tab) and the frame origins their books are in. */
const READERS: { sites: string[]; frames: string[]; is: (host: string) => boolean }[] = [
  {
    sites: ["https://play.google.com/*", "https://books.google.com/*"],
    frames: ["https://books.googleusercontent.com/*"],
    is: (host) => host === "play.google.com" || host === "books.google.com",
  },
  {
    sites: ["https://libbyapp.com/*"],
    frames: ["https://*.read.libbyapp.com/*"],
    is: (host) => host === "libbyapp.com",
  },
  {
    sites: ["https://*.vitalsource.com/*"],
    frames: ["https://jigsaw.vitalsource.com/*"],
    is: (host) => host.endsWith(".vitalsource.com") && host !== "jigsaw.vitalsource.com",
  },
];

/** The frame origins a reader's site shows its books from, by the site's hostname. */
export function readerFrames(host: string): string[] {
  return READERS.find((r) => r.is(host))?.frames ?? [];
}

/** The reader sites whose tabs hold frames of these origins: a grant of the frame reaches
 *  the tabs already open on the site. */
export function readerSitesFor(origins: readonly string[]): string[] {
  return READERS.filter((r) => r.frames.some((f) => origins.includes(f))).flatMap((r) => r.sites);
}
