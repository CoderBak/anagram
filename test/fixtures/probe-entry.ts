// test/fixtures/probe-entry.ts — the walker, packaged to be pasted into ANY live page.
//
// Some pages can only be judged where they live: X, Zhihu or LinkedIn show their real
// markup to a logged-in reader only, and a fixture written from memory misses exactly the
// detail that matters (X keeps a whole post in one text node with blank lines in it). This
// entry bundles the segmentation code into one self-contained script:
//
//   npx esbuild test/fixtures/probe-entry.ts --bundle --minify --format=iife \
//       --target=chrome120 --outfile=/tmp/anagram-probe.min.js        (about 12 kB)
//
// Paste the result into the page (DevTools console, or an automation tool's "run
// JavaScript"), then paste test/fixtures/probe-report.js to get a compact JSON summary of
// how the page would be segmented: which posts get a unit, which are cut into several,
// which units cross two posts. It reads the page and changes nothing a reader can see
// (like the extension itself, it may split a text node at a blank line).
import { collectUnits } from "../../lib/dom/walker";
import { countWords } from "../../lib/dom/text";

(window as unknown as { __anagramProbe: unknown }).__anagramProbe = { collectUnits, countWords };
