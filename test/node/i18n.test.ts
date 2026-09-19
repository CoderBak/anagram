// test/node/i18n.test.ts — the message files and the lookup that reads them.
//
// Nothing here renders anything: it is the contract between the two locale files and the
// code that names their keys. A message added to one file and not the other, a placeholder
// that moved, a key nobody uses any more and a key used but never written all fail here
// rather than as a blank label in a Chinese browser nobody on this machine has open.
import { describe, expect, it, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { t, tn, messageLocale, type MessageKey } from "../../lib/i18n";
import {
  entryFilesOf,
  keysUsedBy,
  reachableSources,
  unscanned,
} from "../../scripts/i18nSubset";

interface Entry {
  message: string;
  description?: string;
}

const ROOT = join(__dirname, "..", "..");
const load = (locale: string): Record<string, Entry> =>
  JSON.parse(readFileSync(join(ROOT, "public", "_locales", locale, "messages.json"), "utf8"));

const EN = load("en");
const ZH = load("zh_CN");

/** Every $1…$9 a message uses, as a sorted set. */
const placeholders = (message: string): string[] =>
  [...new Set(message.match(/\$[1-9]/g) ?? [])].sort();

/** Everything that could possibly name a message key, in one string. */
function sources(): string {
  const out: string[] = [];
  const skip = new Set(["node_modules", "output", ".wxt", ".git", "_locales"]);
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (skip.has(name)) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|mjs|html)$/.test(name)) out.push(readFileSync(path, "utf8"));
    }
  };
  for (const dir of ["lib", "entrypoints", "test"]) walk(join(ROOT, dir));
  out.push(readFileSync(join(ROOT, "wxt.config.ts"), "utf8"));
  return out.join("\n");
}
const SOURCE = sources();

/** `foo` for `foo_one`/`foo_other`, which is the name tn() is called with. */
const base = (key: string): string => key.replace(/_(one|other)$/, "");

describe("message files", () => {
  it("both parse and carry the same keys", () => {
    expect(Object.keys(EN).length).toBeGreaterThan(0);
    expect(Object.keys(ZH).sort()).toEqual(Object.keys(EN).sort());
  });

  it("declares its own locale, so the UI never has to guess what resolved", () => {
    expect(EN.localeTag.message).toBe("en");
    expect(ZH.localeTag.message).toBe("zh-CN");
  });

  it("has no empty message", () => {
    for (const [key, entry] of Object.entries(EN)) expect(entry.message.trim(), key).not.toBe("");
    for (const [key, entry] of Object.entries(ZH)) expect(entry.message.trim(), key).not.toBe("");
  });

  it("gives every English message a description for translators", () => {
    for (const [key, entry] of Object.entries(EN)) {
      expect(entry.description?.trim(), key).toBeTruthy();
    }
  });

  it("uses the same placeholders in both languages", () => {
    for (const key of Object.keys(EN)) {
      expect(placeholders(ZH[key].message), key).toEqual(placeholders(EN[key].message));
    }
  });

  it("gives every plural an _one and an _other", () => {
    for (const key of Object.keys(EN)) {
      if (key.endsWith("_one")) expect(EN, key).toHaveProperty(`${base(key)}_other`);
      if (key.endsWith("_other")) expect(EN, key).toHaveProperty(`${base(key)}_one`);
    }
  });
});

describe("keys and the code that names them", () => {
  it("has no message nothing uses", () => {
    const unused = Object.keys(EN).filter(
      (key) =>
        !SOURCE.includes(`"${key}"`) &&
        !SOURCE.includes(`"${base(key)}"`) &&
        !SOURCE.includes(`__MSG_${key}__`),
    );
    expect(unused).toEqual([]);
  });

  it("has a message for every key the code asks for", () => {
    const asked = new Set<string>();
    for (const m of SOURCE.matchAll(/\bt\(\s*"([A-Za-z0-9_]+)"/g)) asked.add(m[1]);
    for (const m of SOURCE.matchAll(/\btn\(\s*"([A-Za-z0-9_]+)"/g)) {
      asked.add(`${m[1]}_one`);
      asked.add(`${m[1]}_other`);
    }
    for (const m of SOURCE.matchAll(/data-i18n(?:-title|-aria-label|-placeholder|-html)?="([A-Za-z0-9_]+)"/g)) {
      asked.add(m[1]);
    }
    for (const m of SOURCE.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)) asked.add(m[1]);
    expect(asked.size).toBeGreaterThan(50);
    expect([...asked].filter((key) => !(key in EN)).sort()).toEqual([]);
  });
});

describe("t()", () => {
  // Whatever this runner brought with it — WXT's fake browser, nothing at all — goes back
  // afterwards, so the cases below cannot leak an i18n stub into the suites after them.
  const host = globalThis as Record<string, unknown>;
  const saved = { browser: host.browser, chrome: host.chrome };
  afterEach(() => {
    Object.assign(host, saved);
  });

  /** What test/unit-entry.ts and these suites run in: no extension API at all. */
  function withoutExtension(): void {
    Object.assign(host, { browser: undefined, chrome: undefined });
  }

  it("answers in English when there is no extension API", () => {
    withoutExtension();
    expect(t("panelTitle")).toBe("Flagged paragraphs");
    expect(messageLocale()).toBe("en");
  });

  it("substitutes $1…$9 itself in that fallback", () => {
    withoutExtension();
    expect(t("panelTitleCount", 6)).toBe("Flagged paragraphs (6)");
    expect(t("cardOfCount", 2, 5)).toBe("2 of 5");
    expect(t("panelItemAria", "AI-generated", 96, "Delving into…")).toBe(
      "AI-generated, 96%: Delving into…",
    );
  });

  it("picks the singular only for one", () => {
    withoutExtension();
    expect(tn("countAria", 1)).toBe("1 flagged paragraph — show list");
    expect(tn("countAria", 2)).toBe("2 flagged paragraphs — show list");
    expect(tn("countAria", 0)).toBe("0 flagged paragraphs — show list");
  });

  it("prefers the platform's answer, and falls back when it has none", () => {
    Object.assign(host, {
      browser: undefined,
      chrome: { i18n: { getMessage: (key: string) => (key === "panelTitle" ? "面板" : "") } },
    });
    expect(t("panelTitle")).toBe("面板");
    expect(t("panelRetry")).toBe("Retry"); // "" means the platform has nothing
  });

  it("survives a platform that throws (an invalidated extension context)", () => {
    Object.assign(host, {
      browser: undefined,
      chrome: {
        i18n: {
          getMessage: () => {
            throw new Error("Extension context invalidated.");
          },
        },
      },
    });
    expect(t("panelRetry")).toBe("Retry");
  });

  it("survives a bundle that was built without the key", () => {
    // Every extension bundle carries only the messages its own surface can show
    // (scripts/i18nSubset.ts). Nothing should ever ask for one it was not given — but if
    // it does, with no platform to answer either, the key name is what comes back.
    // Assembled rather than written out: a literal here would be a key nobody wrote.
    const absent = ["noSuchMessage", "Anywhere"].join("") as MessageKey;
    withoutExtension();
    expect(t(absent)).toBe("noSuchMessageAnywhere");
  });

  it("still falls back for a content-script key when the context is gone", () => {
    // The whole reason the English travels in the bundle at all. A content script whose
    // extension was just reloaded gets a throw from getMessage; one asking for a message
    // the platform has not got gets "". Both are the panel's own strings, which the
    // content script's trimmed fallback therefore has to have kept.
    const gone = (): string => {
      throw new Error("Extension context invalidated.");
    };
    Object.assign(host, { browser: undefined, chrome: { i18n: { getMessage: gone } } });
    expect(t("panelTitle")).toBe("Flagged paragraphs");
    expect(t("bandHeavy")).toBe("Heavily edited");
    expect(tn("countAria", 3)).toBe("3 flagged paragraphs — show list");
    Object.assign(host, { browser: undefined, chrome: { i18n: { getMessage: () => "" } } });
    expect(t("cardScored")).toBe(EN.cardScored.message);
    expect(messageLocale()).toBe("en");
  });

  it("types the key union off the English file", () => {
    // A compile-time assertion: this only builds while the union is derived from the JSON.
    const key: MessageKey = "panelTitle";
    expect(key in EN).toBe(true);
  });
});

// The English fallback compiled into a bundle is not the whole file any more: WXT builds
// the background, the content script and the extension pages separately, and each gets
// the messages the sources ITS entry can reach actually name. These are the two halves
// of that — the scan that decides, and what really came out of the last build.
describe("the English each bundle carries", () => {
  const entry = (...parts: string[]): string => join(ROOT, ...parts);
  const SURFACES = {
    content: [entry("entrypoints", "content.ts")],
    background: [entry("entrypoints", "background.ts")],
    pages: ["onboarding", "options", "popup", "reader"].map((p) =>
      entry("entrypoints", p, "index.html"),
    ),
  };

  describe("the scan that decides", () => {
    it("reads WXT's two build shapes and nothing else", () => {
      // A content script / the background: a single-entry library build, behind a virtual
      // module that carries the real path after the `?`. The pages: one HTML input each.
      expect(
        entryFilesOf({
          build: { lib: { entry: `virtual:wxt-background-entrypoint?${SURFACES.background[0]}` } },
        }),
      ).toEqual(SURFACES.background);
      expect(
        entryFilesOf({ build: { rollupOptions: { input: { popup: SURFACES.pages[2] } } } }),
      ).toEqual([SURFACES.pages[2]]);
      // Anything else — including the config WXT resolves for no build at all — keeps the
      // whole English file, which is what every non-extension consumer wants.
      expect(entryFilesOf({ build: { lib: false } })).toBeUndefined();
      expect(entryFilesOf({})).toBeUndefined();
    });

    it("follows our imports to the files that name messages, and stops at the rest", () => {
      const files = reachableSources(SURFACES.content, ROOT);
      expect(files).toContain(entry("lib", "render", "band.ts"));
      expect(files).toContain(entry("lib", "i18n.ts"));
      // The pages' own half of the translation is not in the content script.
      expect(files).not.toContain(entry("lib", "ui", "localize.ts"));
      // Never the English file itself — reading THAT for keys would find every one.
      expect(files.some((f) => f.endsWith("messages.json"))).toBe(false);
    });

    it("finds a key that is only ever held in a table, not written at a t() call", () => {
      // lib/render/band.ts names its six verdict labels in a Band → key record and calls
      // `t(BAND_KEY[b])`. Prefixes would have guessed them; the scan reads them.
      const { keys } = keysUsedBy([entry("lib", "render", "band.ts")], EN);
      for (const key of ["bandHuman", "bandLight", "bandHeavy", "bandAi", "bandUnavailable"]) {
        expect(keys, key).toContain(key);
      }
    });

    it("expands a plural from its base, which is the only name tn() is given", () => {
      const { keys } = keysUsedBy([entry("lib", "render", "fab.ts")], EN);
      expect(keys).toContain("countAria_one");
      expect(keys).toContain("countAria_other");
    });

    it("reports a key the code asks for that no message file has", () => {
      // What fails the BUILD, so a misspelt key never reaches a bundle that would then
      // have to fall back to printing it. The case lives in a file of its own, spelt out
      // of parts: written here, it would be one of the keys the suite above refuses.
      const misspelt = "optNoRule" + "z";
      const dir = mkdtempSync(join(tmpdir(), "anagram-i18n-"));
      const file = join(dir, "misspelt.ts");
      writeFileSync(file, `export const x = t(${JSON.stringify(misspelt)});\n`);
      try {
        const { keys, unknownKeys } = keysUsedBy([file], EN);
        expect(unknownKeys.join(" ")).toContain(misspelt);
        expect(keys).not.toContain(misspelt);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });

    it("reports a source file the bundler pulled in that the scan never read", () => {
      // The safety net: whatever an import looks like, a file in the real module graph
      // that this scan missed fails the build rather than losing that file's strings.
      const scanned = [entry("lib", "i18n.ts")];
      const graph = [entry("lib", "i18n.ts"), entry("lib", "render", "band.ts") + "?v=1"];
      // The scan speaks in forward slashes on every platform (a Vite module id does, and
      // node:path on Windows does not), so the expectation is put the same way.
      expect(unscanned(graph, ROOT, scanned)).toEqual([entry("lib", "render", "band.ts").replace(/\\/g, "/")]);
      // Dependencies and WXT's own generated shims are nobody's messages.
      expect(unscanned([join(ROOT, "node_modules", "x", "i.ts")], ROOT, [])).toEqual([]);
      expect(unscanned([join(ROOT, ".wxt", "i.ts")], ROOT, [])).toEqual([]);
    });
  });

  // These read the last `npm run build` (CI builds before it runs vitest); with no build
  // on disk there is nothing to check and they skip rather than fail.
  describe("what came out of the build", () => {
    const OUT = join(ROOT, "output", "chrome-mv3");
    /** `key:{message:` — how the compiled fallback object comes out of the minifier. */
    const compiledKeys = (code: string): Set<string> =>
      new Set([...code.matchAll(/\b([A-Za-z0-9_]+):\{message:/g)].map((m) => m[1]));

    /** Every built .js, by path relative to the output. */
    const bundles = (): string[] => {
      const out: string[] = [];
      const walk = (dir: string, prefix: string): void => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
          else if (name.endsWith(".js")) out.push(`${prefix}${name}`);
        }
      };
      walk(OUT, "");
      return out;
    };

    /** The one bundle of each surface that carries the compiled English. */
    const carriers = (): Record<string, string> => {
      const found: Record<string, string> = {};
      for (const rel of bundles()) {
        const code = readFileSync(join(OUT, rel), "utf8");
        if (!code.includes("localeTag:{message:")) continue;
        const surface = rel.startsWith("content-scripts/")
          ? "content"
          : rel.startsWith("background")
            ? "background"
            : "pages";
        found[surface] = rel;
      }
      return found;
    };

    // A build older than what decides its contents says nothing about this tree: a
    // developer who pulled and ran vitest without rebuilding got two failures here that
    // were only a stale `output/`. CI builds right before it runs vitest, so there these
    // always run.
    const DECIDES = [
      join(ROOT, "wxt.config.ts"),
      join(ROOT, "scripts", "i18nSubset.ts"),
      join(ROOT, "lib", "i18n.ts"),
      join(ROOT, "public", "_locales", "en", "messages.json"),
    ];
    const builtAt = existsSync(join(OUT, "manifest.json")) ? statSync(join(OUT, "manifest.json")).mtimeMs : 0;
    const ready = builtAt > 0 && DECIDES.every((path) => statSync(path).mtimeMs <= builtAt);

    it.skipIf(!ready)("gives each bundle exactly one compiled fallback", () => {
      expect(Object.keys(carriers()).sort()).toEqual(["background", "content", "pages"]);
    });

    it.skipIf(!ready)("compiles in every key its own sources can name", () => {
      for (const [surface, rel] of Object.entries(carriers())) {
        const { keys } = keysUsedBy(
          reachableSources(SURFACES[surface as keyof typeof SURFACES], ROOT),
          EN,
        );
        const compiled = compiledKeys(readFileSync(join(OUT, rel), "utf8"));
        expect(
          keys.filter((key) => !compiled.has(key)),
          `${surface} (${rel})`,
        ).toEqual([]);
      }
    });

    it.skipIf(!ready)("keeps the pages' strings out of the content script", () => {
      const compiled = compiledKeys(readFileSync(join(OUT, carriers().content), "utf8"));
      expect([...compiled].filter((key) => /^(opt|onb|popup|reader)/.test(key))).toEqual([]);
      // And it is a real saving, not a rounding of one.
      expect(compiled.size).toBeLessThan(Object.keys(EN).length / 2);
    });

    it.skipIf(!ready)("leaves the background worker its menu titles and little else", () => {
      const compiled = compiledKeys(readFileSync(join(OUT, carriers().background), "utf8"));
      expect([...compiled].sort()).toEqual([
        "localeTag",
        "menuAnalyzePage",
        "menuAnalyzeSelection",
        "menuCopyDiagnostics",
        "menuOpenPdf",
      ]);
    });
  });
});
