// test/node/footprint.test.ts — docs/footprint.md, checked against the code it describes.
//
// The footprint page is the one thing an auditor reads: every network call the extension
// can make, every key it stores, every address written into it. A page like that is worth
// nothing the day after somebody adds a `fetch` and forgets it, so this test reads the page
// and the sources and refuses any difference in either direction — a call site nobody wrote
// down, and a line written down whose call site has gone.
//
// The second half reads the SHIPPING manifest, where the Content-Security-Policy and
// `web_accessible_resources` live. Those checks skip when `output/chrome-mv3` is older than
// the config that decides them, the way test/node/i18n.test.ts does: CI builds before it
// runs vitest, so there they always run.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = join(__dirname, "..", "..");
const DOC = readFileSync(join(ROOT, "docs", "footprint.md"), "utf8");

/** Every shipped source file the inventory is about, as repository-relative paths. */
function shippedSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      // .css is in the list because a stylesheet can name a remote host too — an @import,
      // a webfont, a background image — and a vendored one is exactly where nobody looks.
      else if (/\.(ts|html|css)$/.test(name)) out.push(relative(ROOT, path).split(sep).join("/"));
    }
  };
  for (const dir of ["lib", "entrypoints"]) walk(join(ROOT, dir));
  return out.sort();
}
const SOURCES = shippedSources();
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/**
 * The rows of the first markdown table after `heading`, as arrays of cells with the
 * backticks stripped. A table ends at the first line that is not a row.
 */
function tableUnder(heading: string): string[][] {
  const at = DOC.indexOf(heading);
  expect(at, `docs/footprint.md has no "${heading}" heading`).toBeGreaterThan(-1);
  const lines = DOC.slice(at).split("\n");
  const rows: string[][] = [];
  let started = false;
  for (const line of lines.slice(1)) {
    if (!line.startsWith("|")) {
      if (started) break;
      continue;
    }
    started = true;
    const cells = line
      .slice(1, line.replace(/\|\s*$/, "").length)
      .split("|")
      .map((c) => c.trim().replace(/^`|`$/g, ""));
    if (cells.every((c) => /^-+$/.test(c)) || cells[0] === "File" || cells[0] === "Key") continue;
    rows.push(cells);
  }
  expect(rows.length, `no table under "${heading}"`).toBeGreaterThan(0);
  return rows;
}

// ---- the network inventory ------------------------------------------------------------------

/**
 * Every way a source file can start a request. `fetch(` is matched with the preceding
 * character excluded so that `schedulePrefetch(` is not one; a member call such as
 * `deps.fetch(` still is, because that is a request too. A dynamic `import()` counts only
 * when its argument is not a literal — `import("./x")` is the bundler's business, and
 * `import(url)` is a load by address.
 */
const NETWORK_APIS: { name: string; find: RegExp }[] = [
  { name: "fetch(", find: /(?<![\w$])fetch\s*\(/g },
  { name: "XMLHttpRequest", find: /\bXMLHttpRequest\b/g },
  { name: "WebSocket", find: /\bWebSocket\b/g },
  { name: "EventSource", find: /\bEventSource\b/g },
  { name: "sendBeacon", find: /\bsendBeacon\b/g },
  { name: "importScripts", find: /\bimportScripts\b/g },
  { name: "import(", find: /(?<![\w$.])import\s*\((?!\s*["'])/g },
];

/** `file api` for every call site the sources really hold. */
function callSitesInCode(): Set<string> {
  const found = new Set<string>();
  for (const rel of SOURCES) {
    const code = read(rel);
    for (const { name, find } of NETWORK_APIS) {
      if (new RegExp(find.source, find.flags).test(code)) found.add(`${rel} ${name}`);
    }
  }
  return found;
}

describe("the network inventory in docs/footprint.md", () => {
  const rows = tableUnder("### Every call site");
  const inDoc = new Set(rows.map((r) => `${r[0]} ${r[1]}`));

  it("writes down every network call site in lib/ and entrypoints/", () => {
    // A call this test can see and the page does not name. Adding the call is fine; adding
    // it without saying where it goes is what fails here.
    expect([...callSitesInCode()].filter((c) => !inDoc.has(c)).sort()).toEqual([]);
  });

  it("names no call site that has gone", () => {
    const inCode = callSitesInCode();
    expect([...inDoc].filter((c) => !inCode.has(c)).sort()).toEqual([]);
  });

  it("says where each one goes", () => {
    for (const row of rows) {
      expect(row, row[0]).toHaveLength(4);
      expect(row[2].length, `${row[0]}: no purpose`).toBeGreaterThan(10);
      expect(row[3].length, `${row[0]}: no destination`).toBeGreaterThan(5);
    }
  });

  it("keeps the daemon client the only thing that talks to the daemon", () => {
    // The one call site whose destination is a server. If a second file ever grows one,
    // the row above will be new and this says which shape it has to have.
    const daemon = rows.filter((r) => r[3].includes("loopback daemon")).map((r) => r[0]);
    expect([...new Set(daemon)]).toEqual(["lib/backend/httpClient.ts"]);
  });
});

// ---- the addresses written into the source ----------------------------------------------------

/** An http(s) literal, stopping where a string, a template hole or a bracket does. */
const URL_LITERAL = /https?:\/\/[^\s"'`){<]*/g;

describe("the addresses in docs/footprint.md", () => {
  const rows = tableUnder("### Every address written in the source");

  /** `file url` for every literal the sources hold, trimmed of trailing punctuation. */
  const inCode: { file: string; url: string }[] = [];
  for (const rel of SOURCES) {
    for (const m of read(rel).matchAll(URL_LITERAL)) {
      inCode.push({ file: rel, url: m[0].replace(/[.,;:]+$/, "") });
    }
  }

  it("has a row for every http(s) literal in the shipped source", () => {
    const unlisted = inCode
      .filter(({ file, url }) => !rows.some((r) => r[0] === file && url.startsWith(r[1])))
      .map(({ file, url }) => `${file} ${url}`);
    expect([...new Set(unlisted)].sort()).toEqual([]);
  });

  it("lists no address that is no longer written anywhere", () => {
    const stale = rows
      .filter((r) => !inCode.some(({ file, url }) => file === r[0] && url.startsWith(r[1])))
      .map((r) => `${r[0]} ${r[1]}`);
    expect(stale.sort()).toEqual([]);
  });

  it("names no remote host that anything actually fetches", () => {
    // Every remote address here is either built for a link somebody clicks, or an example
    // in a comment. The one origin the code may really reach is loopback.
    for (const row of rows) {
      const remote = !/^https?:\/\/(127\.0\.0\.1|localhost)/.test(row[1]);
      if (remote) expect(row[2].length, `${row[0]} ${row[1]}`).toBeGreaterThan(10);
    }
    expect(rows.some((r) => r[1].startsWith("http://127.0.0.1"))).toBe(true);
  });
});

// ---- the storage inventory --------------------------------------------------------------------

describe("the storage inventory in docs/footprint.md", () => {
  const rows = tableUnder("### `chrome.storage.local`");
  const inDoc = new Set(rows.map((r) => r[0]));

  /** Every key the code really defines or writes by name. */
  function keysInCode(): Set<string> {
    const keys = new Set<string>();
    // `"local:<key>"` is WXT's own spelling of a storage.local item; the type argument in
    // front of it can carry its own angle brackets, so the key is read and not the call.
    for (const m of read("lib/settings/settings.ts").matchAll(/"local:([A-Za-z0-9_]+)"/g)) {
      keys.add(m[1]);
    }
    // Anything else written straight to storage.local, by the constant it is held in.
    for (const rel of SOURCES) {
      const code = read(rel);
      if (!/storage\.local\.(set|remove)/.test(code)) continue;
      for (const m of code.matchAll(/^const ([A-Z_]*(?:FLAG|KEY))\s*=\s*"([^"]+)"/gm)) keys.add(m[2]);
    }
    return keys;
  }

  it("writes down every storage.local key the code uses", () => {
    expect([...keysInCode()].filter((k) => !inDoc.has(k)).sort()).toEqual([]);
  });

  it("names no key the code no longer writes", () => {
    const inCode = keysInCode();
    expect([...inDoc].filter((k) => !inCode.has(k)).sort()).toEqual([]);
  });

  it("finds no storage area other than local anywhere in the sources", () => {
    // sync would leave this computer, and the page says nothing does.
    const strayed = SOURCES.filter((rel) => /storage\.(sync|managed)\b/.test(read(rel)));
    expect(strayed).toEqual([]);
  });

  it("stores a hash and a verdict in the score cache, never text", () => {
    // The row shape is spelt out on the page; this pins the claim underneath it, which is
    // that what goes into a row is derived from the text and is not the text.
    const cache = read("lib/backend/swCache.ts");
    expect(cache).toMatch(/keyOf\(text: string, dim: string\): string/);
    expect(DOC).toContain("No page text is ever stored.");
  });
});

// ---- what the built manifest really says -------------------------------------------------------

describe("the shipping manifest", () => {
  const OUT = join(ROOT, "output", "chrome-mv3");
  const CONFIG = join(ROOT, "wxt.config.ts");
  const builtAt = existsSync(join(OUT, "manifest.json"))
    ? statSync(join(OUT, "manifest.json")).mtimeMs
    : 0;
  const ready = builtAt > 0 && statSync(CONFIG).mtimeMs <= builtAt;
  const manifest = (): Record<string, unknown> =>
    JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8"));

  /** The exact policy, which docs/footprint.md quotes and test/csp-check.mjs exercises. */
  const CSP =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; " +
    "connect-src 'self' http://127.0.0.1:* http://localhost:*; " +
    "img-src 'self' data: blob:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
    "worker-src 'self'; frame-src 'none'; form-action 'none'; base-uri 'none'";

  it.skipIf(!ready)("carries that exact Content-Security-Policy", () => {
    expect((manifest().content_security_policy as { extension_pages: string }).extension_pages).toBe(
      CSP,
    );
  });

  it("quotes the same policy on the footprint page, directive for directive", () => {
    const quoted = DOC.slice(DOC.indexOf("```") + 3, DOC.indexOf("```", DOC.indexOf("```") + 3));
    expect(quoted.replace(/\s+/g, " ").trim()).toBe(CSP.replace(/\s+/g, " "));
  });

  it.skipIf(!ready)("lets connect-src reach nothing but itself and loopback", () => {
    const policy = (manifest().content_security_policy as { extension_pages: string })
      .extension_pages;
    const connect = /connect-src ([^;]+)/.exec(policy)?.[1].trim().split(/\s+/) ?? [];
    expect(connect).toEqual(["'self'", "http://127.0.0.1:*", "http://localhost:*"]);
  });

  it.skipIf(!ready)("makes only the three content-script chunks web accessible", () => {
    expect(manifest().web_accessible_resources).toEqual([
      {
        resources: [
          "vendor/readability.min.mjs",
          "vendor/purify.min.mjs",
          "vendor/diagnostics.min.mjs",
        ],
        matches: ["<all_urls>"],
        use_dynamic_url: true,
      },
    ]);
  });

  it.skipIf(!ready)("still ships the WebAssembly the policy lets it compile", () => {
    // The two decoders scripts/vendor.mjs names file by file. Without the keyword in
    // script-src they are dead weight and a scanned page draws blank — measured in
    // test/pdf-codecs-check.mjs, which is why the keyword is in the policy above.
    for (const file of ["openjpeg.wasm", "jbig2.wasm"]) {
      expect(existsSync(join(OUT, "vendor", "wasm", file)), file).toBe(true);
    }
  });
});
