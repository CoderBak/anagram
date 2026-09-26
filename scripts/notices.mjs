// scripts/notices.mjs — THIRD_PARTY_NOTICES.md, generated from the list below.
//
// Anagram's own code is AGPL-3.0-or-later (LICENSE). What it ships of other people's work,
// and what its source adapts from other projects, is COMPONENTS below; the notices file is
// written from that list and from licence texts already on disk (the packages' own files,
// the pinned vendor trees, scripts/licences/), so a version or a licence file that changes
// upstream changes the file. It is committed, shipped next to LICENSE in both browser builds
// (wxt.config.ts) and in the component package (scripts/release.mjs), and kept honest by:
//   · test/node/notices.test.ts — the committed file is what this script writes; every
//     third-party project named in shipped source is listed; every adaptation listed is
//     still in the file it names;
//   · the extension build (wxt.config.ts) and scripts/vendor.mjs — a bundle that takes code
//     from an npm package not listed in `packages` below fails, and so does a listed
//     package that no longer ships.
//
//   node scripts/notices.mjs           rewrite THIRD_PARTY_NOTICES.md
//   node scripts/notices.mjs --check   exit 1 when it is stale
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const NOTICES_FILE = "THIRD_PARTY_NOTICES.md";

const read = (rel) => readFileSync(join(ROOT, rel), "utf8");
const json = (rel) => JSON.parse(read(rel));
/** The installed version of an npm package: the notices follow what is really built. */
const npm = (name) => json(`node_modules/${name}/package.json`).version;
const pdfjsPin = () => json("vendor/pdfjs/upstream.json");
const workerPin = () => json("vendor/document-worker/upstream.json");
const short = (commit) => commit.slice(0, 7);

// ---- licences --------------------------------------------------------------------------------

const MIT_BODY = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const ZLIB_BODY = `This software is provided 'as-is', without any express or implied
warranty. In no event will the authors be held liable for any damages
arising from the use of this software.

Permission is granted to anyone to use this software for any purpose,
including commercial applications, and to alter it and redistribute it
freely, subject to the following restrictions:

1. The origin of this software must not be misrepresented; you must not
  claim that you wrote the original software. If you use this software
  in a product, an acknowledgment in the product documentation would be
  appreciated but is not required.
2. Altered source versions must be plainly marked as such, and must not be
  misrepresented as being the original software.
3. This notice may not be removed or altered from any source distribution.`;

/** The long licences, reproduced once at the end and referred to by their identifier. */
const FULL_TEXTS = {
  "Apache-2.0": { title: "Apache License 2.0", file: "node_modules/pdfjs-dist/LICENSE" },
  "MPL-2.0": { title: "Mozilla Public License 2.0", file: "node_modules/dompurify/LICENSE-MPL" },
  "GPL-3.0": { title: "GNU General Public License v3.0", file: "scripts/licences/GPL-3.0.txt" },
};
const ABOUT = {
  "AGPL-3.0": "the same text as LICENSE, which ships beside this file",
  "Apache-2.0": "full text under Licence texts below",
  "MPL-2.0": "full text under Licence texts below",
  "GPL-3.0": "full text under Licence texts below",
};

/** A short licence written out with one component's own copyright line. */
const composed = (kind, copyright) =>
  kind === "MIT" ? `MIT License\n\n${copyright}\n\n${MIT_BODY}` : `${copyright}\n\n${ZLIB_BODY}`;

// ---- the components --------------------------------------------------------------------------
//
// Fields: name, version, url (the project; source attributions are matched against it and
// `urls`), licence (SPDX), copyright, where (what of it ships, and where), notice (files
// reproduced verbatim — the component's own licence carrying its own copyright — or
// { compose: "MIT" | "Zlib" } to write the short licence out with `copyright`), packages
// (npm packages whose code is bundled; checked against the build) and chunk (the vendor/
// chunk scripts/vendor.mjs builds them into, when it is not the extension build), adapted
// (files of Anagram's own source that adapt it; checked to still name it), note.

/** @type {{ title: string, intro: string, components: () => object[] }[]} */
const GROUPS = [
  {
    title: "Bundled into the extension's scripts",
    intro: "Compiled into Anagram's own minified bundles (background, content scripts, pages) and its on-demand chunks under vendor/.",
    components: () => [
      { name: "Floating UI", version: npm("@floating-ui/dom"), url: "https://github.com/floating-ui/floating-ui",
        licence: "MIT", copyright: "Copyright (c) 2021-present Floating UI contributors",
        where: `@floating-ui/core ${npm("@floating-ui/core")}, @floating-ui/dom ${npm("@floating-ui/dom")} and @floating-ui/utils ${npm("@floating-ui/utils")}: positioning of the chip card, the selection card and the panel.`,
        notice: ["node_modules/@floating-ui/dom/LICENSE"], packages: ["@floating-ui/core", "@floating-ui/dom", "@floating-ui/utils"] },
      { name: "culori", version: npm("culori"), url: "https://github.com/Evercoder/culori",
        licence: "MIT", copyright: "Copyright (c) 2018 Dan Burzo",
        where: "Colour parsing for the chips' contrast with the page.", notice: ["node_modules/culori/LICENSE"], packages: ["culori"] },
      { name: "idb", version: npm("idb"), url: "https://github.com/jakearchibald/idb",
        licence: "ISC", copyright: "Copyright (c) 2016, Jake Archibald",
        where: "The score cache's IndexedDB wrapper.", notice: ["node_modules/idb/LICENSE"], packages: ["idb"] },
      { name: "Valibot", version: npm("valibot"), url: "https://github.com/open-circle/valibot",
        licence: "MIT", copyright: "Copyright (c) Fabian Hiller",
        where: "Validation of messages and replies.", notice: ["node_modules/valibot/LICENSE.md"], packages: ["valibot"] },
      { name: "WXT runtime", version: npm("wxt"), url: "https://github.com/wxt-dev/wxt",
        licence: "MIT", copyright: "Copyright (c) 2023 Aaron",
        where: `wxt ${npm("wxt")}, @wxt-dev/browser ${npm("@wxt-dev/browser")} and @wxt-dev/storage ${npm("@wxt-dev/storage")}: the entry-point wrappers, the browser API and the settings storage.`,
        notice: ["node_modules/@wxt-dev/storage/LICENSE"], packages: ["wxt", "@wxt-dev/browser", "@wxt-dev/storage"] },
      { name: "@webext-core/match-patterns", version: npm("@webext-core/match-patterns"), url: "https://github.com/aklinker1/webext-core",
        licence: "MIT", copyright: "Copyright (c) 2022 Aaron",
        where: "Match patterns for the content scripts, through WXT.", notice: ["node_modules/@webext-core/match-patterns/LICENSE"], packages: ["@webext-core/match-patterns"] },
      { name: "async-mutex", version: npm("async-mutex"), url: "https://github.com/DirtyHairy/async-mutex",
        licence: "MIT", copyright: "Copyright (c) 2016 Christian Speckner",
        where: "Through @wxt-dev/storage.", notice: ["node_modules/async-mutex/LICENSE"], packages: ["async-mutex"] },
      { name: "dequal", version: npm("dequal"), url: "https://github.com/lukeed/dequal",
        licence: "MIT", copyright: "Copyright (c) Luke Edwards",
        where: "Through @wxt-dev/storage.", notice: ["node_modules/dequal/license"], packages: ["dequal"] },
      { name: "Vite", version: npm("vite"), url: "https://github.com/vitejs/vite",
        licence: "MIT", copyright: "Copyright (c) 2019-present, VoidZero Inc. and Vite contributors",
        where: "Its module-preload polyfill and preload helper, which the build inserts into the pages' scripts.",
        notice: { compose: "MIT" }, packages: ["vite"] },
      { name: "Rolldown", version: npm("rolldown"), url: "https://github.com/rolldown/rolldown",
        licence: "MIT", copyright: "Copyright (c) 2024-present VoidZero Inc. & Contributors",
        where: "Its module runtime, which the build inserts into the bundles.", notice: ["node_modules/rolldown/LICENSE"], packages: ["rolldown"] },
      { name: "Defuddle", version: npm("defuddle"), url: "https://github.com/kepano/defuddle",
        licence: "MIT", copyright: "Copyright (c) 2025 Steph Ango (@kepano)",
        where: "vendor/defuddle.min.mjs: finds a page's main content for the \"Main content only\" scope.",
        notice: ["node_modules/defuddle/LICENSE"], packages: ["defuddle"], chunk: "defuddle.min.mjs" },
      { name: "DOMPurify", version: npm("dompurify"), url: "https://github.com/cure53/DOMPurify",
        licence: "MPL-2.0 OR Apache-2.0", copyright: "Copyright (c) Cure53 and other contributors",
        where: "vendor/purify.min.mjs: sanitizes the Google Docs reading view.",
        packages: ["dompurify"], chunk: "purify.min.mjs" },
    ],
  },
  {
    title: "PDF.js and its data",
    intro: "Copied unmodified from the pinned pdfjs-dist package and Mozilla's generic viewer release (scripts/vendor.mjs, scripts/pdfjsViewer.mjs).",
    components: () => [
      { name: "PDF.js", version: npm("pdfjs-dist"), url: "https://github.com/mozilla/pdf.js",
        licence: "Apache-2.0", copyright: "Copyright Mozilla Foundation and the PDF.js contributors",
        where: "vendor/pdfjs.min.mjs and vendor/pdf.worker.mjs (pdfjs-dist/build), unmodified, with their licence headers." },
      { name: "PDF.js generic viewer", version: pdfjsPin().version, url: "https://github.com/mozilla/pdf.js/releases",
        licence: "Apache-2.0 AND MPL-2.0", copyright: "Copyright Mozilla Foundation and the PDF.js contributors",
        where: `vendor/pdfjs/web/ (viewer script, stylesheet, images, translations) and reader.html, derived from its viewer.html with the upstream notice kept (${pdfjsPin().url}). The Fluent translations and a few icons are MPL-2.0 and carry that notice in each file; the rest is Apache-2.0, and vendor/pdfjs/LICENSE ships beside it.` },
      { name: "Adobe CMap resources", version: `pdfjs-dist ${npm("pdfjs-dist")}`, url: "https://github.com/adobe-type-tools/cmap-resources",
        licence: "BSD-3-Clause", copyright: "Copyright 1990-2009 Adobe Systems Incorporated",
        where: "vendor/cmaps/ (packed .bcmap files).", notice: ["node_modules/pdfjs-dist/cmaps/LICENSE"] },
      { name: "Foxit standard fonts", version: `pdfjs-dist ${npm("pdfjs-dist")}`, url: "https://pdfium.googlesource.com/pdfium/",
        licence: "BSD-3-Clause", copyright: "Copyright 2014 PDFium Authors",
        where: "vendor/standard_fonts/Foxit*.pfb.", notice: ["node_modules/pdfjs-dist/standard_fonts/LICENSE_FOXIT"] },
      { name: "Liberation Sans fonts", version: `pdfjs-dist ${npm("pdfjs-dist")}`, url: "https://github.com/liberationfonts/liberation-fonts",
        licence: "OFL-1.1", copyright: "Copyright (c) 2010 Google Corporation; Copyright (c) 2012 Red Hat, Inc.",
        where: "vendor/standard_fonts/LiberationSans-*.ttf.", notice: ["node_modules/pdfjs-dist/standard_fonts/LICENSE_LIBERATION"] },
      { name: "Compact ICC profile (CGATS001Compat-v2-micro)", version: `pdfjs-dist ${npm("pdfjs-dist")}`, url: "https://github.com/saucecontrol/Compact-ICC-Profiles",
        licence: "CC0-1.0", copyright: "Clinton Ingram, dedicated to the public domain",
        where: "vendor/iccs/.", notice: ["node_modules/pdfjs-dist/iccs/LICENSE"] },
      { name: "OpenJPEG (JPEG 2000 decoder, PDF.js WebAssembly build)", version: `pdfjs-dist ${npm("pdfjs-dist")}`, url: "https://github.com/uclouvain/openjpeg",
        licence: "BSD-2-Clause", copyright: "Copyright (c) 2002-2014 Universite catholique de Louvain (UCL) and the OpenJPEG authors; Copyright (c) 2024 Mozilla Foundation",
        where: "vendor/wasm/openjpeg.wasm.", notice: ["node_modules/pdfjs-dist/wasm/LICENSE_OPENJPEG", "node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_OPENJPEG"] },
      { name: "PDFium JBIG2 decoder (PDF.js WebAssembly build)", version: `pdfjs-dist ${npm("pdfjs-dist")}`, url: "https://pdfium.googlesource.com/pdfium/",
        licence: "BSD-3-Clause AND Apache-2.0", copyright: "Copyright 2014 The PDFium Authors; Copyright 2026 Mozilla Foundation",
        where: "vendor/wasm/jbig2.wasm.", notice: [{ file: "node_modules/pdfjs-dist/wasm/LICENSE_JBIG2", until: "Apache License" }, "node_modules/pdfjs-dist/wasm/LICENSE_PDFJS_JBIG2"] },
    ],
  },
  {
    title: "Zotero's document-worker",
    intro: "The PDF reader's paragraphs: a build of Zotero's document-worker, pinned by commit and hash in vendor/document-worker/upstream.json and regenerated by scripts/documentWorker.mjs. Shipped as vendor/document-worker/ with its licences beside it; it runs in the reader page only and fetches nothing from the network.",
    components: () => [
      { name: "Zotero document-worker", version: `commit ${short(workerPin().commit)}`, url: workerPin().repository,
        licence: "AGPL-3.0", copyright: "Copyright (c) 2020 Corporation for Digital Scholarship, Vienna, Virginia, USA",
        where: `vendor/document-worker/worker.js, built from ${workerPin().repository}/tree/${workerPin().commit} with Anagram's entry (vendor/document-worker/src/).`,
        notice: [{ file: "vendor/document-worker/LICENSE.document-worker", until: "GNU AFFERO GENERAL PUBLIC LICENSE" }] },
      { name: "Zotero structured-document-text", version: `commit ${short(workerPin().submodules["structured-document-text"].commit)}`,
        url: workerPin().submodules["structured-document-text"].repository,
        licence: "AGPL-3.0", copyright: "Copyright (c) Corporation for Digital Scholarship",
        where: "Bundled into vendor/document-worker/worker.js. It carries no licence file of its own; Zotero distributes it as a submodule of document-worker, under that licence. lib/pdf/structured.ts adapts its textMap decoding (src/pdf/decode.js).",
        adapted: ["lib/pdf/structured.ts"] },
      { name: "Zotero's PDF.js fork", version: `commit ${short(workerPin().submodules["pdf.js"].commit)}`, url: workerPin().submodules["pdf.js"].repository,
        licence: "Apache-2.0", copyright: "Copyright Mozilla Foundation and the PDF.js contributors, with changes by the Corporation for Digital Scholarship",
        where: "Bundled into vendor/document-worker/worker.js, with its licence as vendor/document-worker/LICENSE.pdf.js; it reads the same CMaps, fonts and decoders listed above." },
      { name: "Block-segmentation models", version: `document-worker ${short(workerPin().commit)}`, url: workerPin().repository,
        licence: "AGPL-3.0", copyright: "Copyright (c) Corporation for Digital Scholarship",
        where: "vendor/document-worker/block-seg/ (ONNX models and their statistics). They carry no licence of their own; they are distributed as part of document-worker." },
      { name: "ONNX Runtime Web", version: workerPin().onnxruntime_web.version, url: "https://github.com/microsoft/onnxruntime",
        licence: "MIT", copyright: "Copyright (c) Microsoft Corporation",
        where: "Its JavaScript is bundled into vendor/document-worker/worker.js, and vendor/document-worker/onnx/ort-wasm-simd-threaded.wasm is copied from the pinned npm package. The WebAssembly build links third-party libraries whose notices Microsoft publishes with ONNX Runtime; they ship verbatim as vendor/document-worker/ThirdPartyNotices.onnxruntime-web.txt.",
        notice: ["vendor/document-worker/LICENSE.onnxruntime-web"] },
      { name: "pako", version: "2.1.0", url: "https://github.com/nodeca/pako",
        licence: "MIT AND Zlib", copyright: "Copyright (C) 2014-2017 by Vitaly Puzrin and Andrei Tuputcyn",
        where: "Bundled into vendor/document-worker/worker.js (a dependency of document-worker). Its zlib port is under the zlib licence: (C) 1995-2013 Jean-loup Gailly and Mark Adler, (C) 2014-2017 Vitaly Puzrin and Andrey Tupitsin.",
        notice: [{ compose: "MIT" }, { compose: "Zlib", copyright: "(C) 1995-2013 Jean-loup Gailly and Mark Adler\n(C) 2014-2017 Vitaly Puzrin and Andrey Tupitsin" }] },
      { name: "fastest-levenshtein", version: "1.0.16", url: "https://github.com/ka-weihe/fastest-levenshtein",
        licence: "MIT", copyright: "Copyright (c) 2020 Kasper Unn Weihe",
        where: "Bundled into vendor/document-worker/worker.js (a dependency of document-worker).", notice: { compose: "MIT" } },
    ],
  },
  {
    title: "Stylesheet",
    intro: "The extension pages' stylesheet, lib/ui/basecoat-vega.cdn.min.css, copied from the basecoat-css package.",
    components: () => [
      { name: "Basecoat (Vega)", version: npm("basecoat-css"), url: "https://github.com/hunvreus/basecoat",
        licence: "MIT", copyright: "Copyright (c) 2025 Ronan Berder",
        where: "Compiled into the popup, Settings, setup and paste pages' stylesheets.", notice: ["lib/ui/BASECOAT-LICENSE.md"] },
      { name: "Tailwind CSS", version: "4.3.1", url: "https://github.com/tailwindlabs/tailwindcss", urls: ["https://tailwindcss.com"],
        licence: "MIT", copyright: "Copyright (c) Tailwind Labs, Inc.",
        where: "Basecoat's stylesheet is compiled with Tailwind CSS and carries its base styles.", notice: { compose: "MIT" } },
    ],
  },
  {
    title: "Adapted in Anagram's source",
    intro: "Code, selectors and word lists that Anagram's own source takes or adapts from other projects, each marked with an attribution comment where it is used.",
    components: () => [
      { name: "DuckDuckGo autoconsent", version: "16.42.0", url: "https://github.com/duckduckgo/autoconsent", urls: ["https://mozilla.org/MPL/2.0/"],
        licence: "MPL-2.0", copyright: "Copyright (c) Sam Macbeth, DuckDuckGo and the autoconsent contributors",
        where: "The consent-banner containers in lib/dom/consentBanners.ts, which keeps the MPL-2.0 notice and is available in source form in Anagram's repository.",
        adapted: ["lib/dom/consentBanners.ts"] },
      { name: "Unicode CLDR", version: "English sentence-break suppressions", url: "https://github.com/unicode-org/cldr",
        licence: "Unicode-3.0", copyright: "Copyright (c) 2001-2026 Unicode, Inc.",
        where: "The abbreviations list in lib/dom/text.ts (common/segments/en.xml).", notice: ["scripts/licences/Unicode-3.0.CLDR.txt"],
        adapted: ["lib/dom/text.ts"] },
      { name: "pySBD", version: "standard abbreviations", url: "https://github.com/nipunsadvilkar/pySBD",
        licence: "MIT", copyright: "Copyright (c) 2019 Nipun Sadvilkar",
        where: "The prepositive and number abbreviations in lib/dom/text.ts (pysbd/lang/common/standard.py).", notice: { compose: "MIT" },
        adapted: ["lib/dom/text.ts"] },
      { name: "talon", version: "html_quotations.py", url: "https://github.com/mailgun/talon",
        licence: "Apache-2.0", copyright: "Copyright Mailgun Inc.",
        where: "The quoted-mail markers in lib/dom/scope.ts and the quotation-header pattern in lib/dom/text.ts.",
        adapted: ["lib/dom/scope.ts", "lib/dom/text.ts"] },
      { name: "planer", version: "src/htmlPlaner.coffee", url: "https://github.com/lever/planer",
        licence: "MIT", copyright: "Copyright (c) 2015 Leighton Wallace",
        where: "The JavaScript port of talon's quoted-mail markers, in lib/dom/scope.ts.", notice: { compose: "MIT" },
        adapted: ["lib/dom/scope.ts"] },
      { name: "Unclutter", version: "textContainer.ts", url: "https://github.com/lindylearn/unclutter",
        licence: "AGPL-3.0", copyright: "Copyright (c) the Unclutter authors",
        where: "The page-text share guard in lib/dom/boilerplate.ts.", adapted: ["lib/dom/boilerplate.ts"] },
      { name: "mwparserfromhtml (Wikimedia html-dumps)", version: "plain-text extraction rules", url: "https://gitlab.wikimedia.org/repos/research/html-dumps",
        licence: "MIT", copyright: "Copyright (c) 2022, Wikimedia Foundation",
        where: "The MediaWiki furniture classes the walk skips, in lib/dom/boilerplate.ts.", notice: { compose: "MIT" },
        adapted: ["lib/dom/boilerplate.ts"] },
      { name: "Read Frog", version: "src/utils/constants/dom-labels.ts", url: "https://github.com/mengxi-ream/read-frog",
        licence: "GPL-3.0", copyright: "Copyright (c) the Read Frog authors",
        where: "The attribute name its translation-only mode writes, in lib/dom/translation.ts.", adapted: ["lib/dom/translation.ts"] },
      { name: "FluentRead", version: "src/platform/shadow-ui/pageBridgeCore.ts", url: "https://github.com/FluentRead/FluentRead",
        licence: "GPL-3.0", copyright: "Copyright (c) the FluentRead contributors",
        where: "The attachShadow wrapper in entrypoints/shadow.content.ts.", adapted: ["entrypoints/shadow.content.ts"] },
      { name: "Firefox translations", version: "translations-document.sys.mjs", url: "https://github.com/mozilla-firefox/firefox",
        licence: "MPL-2.0", copyright: "Copyright (c) Mozilla Foundation and contributors",
        where: "The shadow-root walk in lib/dom/shadow.ts (TranslationsDocument#addShadowRootsToObserver), available in source form in Anagram's repository.",
        adapted: ["lib/dom/shadow.ts"] },
      { name: "Read Aloud", version: "content handlers and site adapters", url: "https://github.com/ken107/read-aloud",
        licence: "MIT", copyright: "Copyright (c) 2016 Hai Phan",
        where: "The reading surfaces in lib/surfaces/ (Google Drive preview, pdf.js viewers, Kindle, Webnovel, e-book reader frames).", notice: { compose: "MIT" },
        adapted: ["lib/surfaces/drive.ts", "lib/surfaces/pdfjs.ts", "lib/surfaces/kindle.ts", "lib/surfaces/paragraphs.ts", "lib/surfaces/frames.ts"] },
      { name: "cyrb53", version: "jshash/experimental/cyrb53.js", url: "https://github.com/bryc/code",
        licence: "Public domain", copyright: "cyrb53 (c) 2018 bryc; \"License: Public domain (or MIT if needed). Attribution appreciated.\"",
        where: "The cache-key hash in lib/hash.ts.", adapted: ["lib/hash.ts"] },
    ],
  },
  {
    title: "The local component package",
    intro: "The component archive (anagram.tar.gz, anagram.zip) holds Anagram's own engine, installer and native launcher, the two browser builds above with this file, LICENSE and this file. Nothing below is in it: the installer downloads each at install time from its publisher, and each keeps its own licence.",
    components: () => [
      { name: "uv", version: "pinned in install.sh and install.ps1", url: "https://github.com/astral-sh/uv",
        licence: "MIT OR Apache-2.0", copyright: "Copyright (c) Astral Software Inc.",
        where: "Downloaded from its GitHub releases; it installs the Python runtime and the packages below." },
      { name: "Python and the engine's Python packages", version: "locked in anagramd/uv.lock", url: "https://pypi.org/",
        licence: "Each package's own", copyright: "Their respective authors",
        where: "A Python runtime from uv's distributions and the packages anagramd/pyproject.toml names (PyTorch, Transformers, ONNX Runtime, fastText and others), installed from PyPI by uv at the exact versions of anagramd/uv.lock." },
      { name: "fastText language identification (lid.176.ftz)", version: "lid.176", url: "https://fasttext.cc/docs/en/language-identification.html",
        licence: "CC-BY-SA-3.0", copyright: "Copyright (c) Facebook, Inc.",
        where: "Downloaded with SHA-256 verification; it tells English from other languages in the engine." },
      { name: "EditLens RoBERTa-large", version: "pinned in anagramd/modelkit.json", url: "https://huggingface.co/pangram/editlens_roberta-large",
        urls: ["https://huggingface.co/CoderBak/editlens_roberta_modelkit"],
        licence: "CC-BY-NC-SA-4.0", copyright: "Pangram Labs",
        where: "The scoring model, downloaded with SHA-256 verification from the CoderBak/editlens_roberta_modelkit redistribution. Non-commercial use only." },
    ],
  },
];

/** Every component, in order, with its group. */
export function components() {
  return GROUPS.flatMap((group) => group.components().map((c) => ({ ...c, group: group.title })));
}

/**
 * The npm packages the extension may bundle: each with its component and, for the
 * on-demand chunks scripts/vendor.mjs builds, the chunk it is built into. The rest are
 * what the extension build itself (wxt.config.ts) compiles into Anagram's scripts.
 */
export function bundledPackages() {
  const out = new Map();
  for (const c of components()) for (const p of c.packages ?? []) out.set(p, { component: c.name, chunk: c.chunk });
  return out;
}

/**
 * The npm package a bundled module came from, or null for Anagram's own source. Module ids
 * are absolute paths (vite), paths relative to the root (esbuild's metafile) or the
 * bundler's own virtual modules: vite's helpers, rolldown's runtime, WXT's entry wrappers.
 */
export function packageOfModule(id) {
  const clean = id.replace(/^\0+/, "").split("?")[0];
  const at = clean.lastIndexOf("node_modules/");
  if (at >= 0) {
    const rest = clean.slice(at + "node_modules/".length).split("/");
    return rest[0].startsWith("@") ? `${rest[0]}/${rest[1]}` : rest[0];
  }
  if (/^vite\//.test(clean)) return "vite";
  if (/^rolldown[:/]/.test(clean)) return "rolldown";
  if (/^virtual:wxt-/.test(clean)) return "wxt";
  if (/^anagram:/.test(clean) || clean === "<stdin>") return null;
  const path = clean.replaceAll("\\", "/");
  if (path.startsWith("/") || /^[A-Za-z]:\//.test(path) || /^(lib|entrypoints|public|scripts)\//.test(path)) return null;
  // Anything else is a module of unknown origin: name it, and the check will refuse it.
  return `(unknown module ${clean})`;
}

/** Packages a bundle took code from that the list does not name. */
export function unlistedPackages(packages) {
  const listed = bundledPackages();
  return [...new Set(packages)].filter((p) => !listed.has(p)).sort();
}

// ---- the file --------------------------------------------------------------------------------

function excerpt(entry, copyright) {
  if (typeof entry === "string") return read(entry).replace(/^﻿/, "").trimEnd();
  if (entry.compose) return composed(entry.compose, entry.copyright ?? copyright);
  const text = read(entry.file);
  const cut = text.indexOf(entry.until);
  if (cut < 0) throw new Error(`${entry.file} no longer has "${entry.until}"`);
  // The part before the long licence the file goes on to reproduce, without the rule
  // that separates the two.
  return text.slice(0, cut).trimEnd().replace(/\n=+$/, "").trimEnd();
}

const fence = (text) => {
  if (text.includes("```")) throw new Error("A licence text contains a code fence");
  return "```text\n" + text + "\n```";
};

export function render() {
  const out = [
    "# Third-party notices",
    "",
    "Anagram is free software under the GNU Affero General Public License v3.0 or later",
    "(LICENSE, beside this file). Its source is at https://github.com/CoderBak/anagram.",
    "",
    "Anagram ships, bundles or adapts the third-party work below, and each keeps its own licence.",
    "Every entry names the project, the version or commit Anagram uses, its licence and",
    "copyright, and what of it Anagram contains. Where a licence asks for its notice to travel",
    "with copies, the notice follows the entry; the longer licences are reproduced once, at the",
    "end. This file is generated by scripts/notices.mjs.",
    "",
  ];
  for (const group of GROUPS) {
    out.push(`## ${group.title}`, "", group.intro, "");
    for (const c of group.components()) {
      out.push(`### ${c.name}${c.version ? ` (${c.version})` : ""}`, "");
      out.push(`- Project: ${c.url}`);
      const about = c.licence.split(/ (?:AND|OR) /).map((id) => ABOUT[id]).filter(Boolean);
      out.push(`- Licence: ${c.licence}${about.length ? ` (${[...new Set(about)].join("; ")})` : ""}`);
      out.push(`- Copyright: ${c.copyright}`);
      out.push(`- In Anagram: ${c.where}`, "");
      const notices = c.notice === undefined ? [] : Array.isArray(c.notice) ? c.notice : [c.notice];
      for (const n of notices) out.push(fence(excerpt(n, c.copyright)), "");
    }
  }
  out.push("## Licence texts", "");
  for (const { title, file } of Object.values(FULL_TEXTS)) out.push(`### ${title}`, "", fence(read(file).trimEnd()), "");
  return out.join("\n").trimEnd() + "\n";
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = join(ROOT, NOTICES_FILE);
  const text = render();
  if (process.argv.includes("--check")) {
    const fresh = existsSync(target) && readFileSync(target, "utf8") === text;
    if (!fresh) {
      console.error(`${NOTICES_FILE} is stale: run node scripts/notices.mjs`);
      process.exit(1);
    }
    console.log(`${NOTICES_FILE} is up to date`);
  } else {
    writeFileSync(target, text);
    console.log(`${NOTICES_FILE}: ${components().length} components, ${(text.length / 1024).toFixed(1)} kB`);
  }
}
