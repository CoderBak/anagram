// test/node/i18n.test.ts — the message files and the lookup that reads them.
//
// Nothing here renders anything: it is the contract between the two locale files and the
// code that names their keys. A message added to one file and not the other, a placeholder
// that moved, a key nobody uses any more and a key used but never written all fail here
// rather than as a blank label in a Chinese browser nobody on this machine has open.
import { describe, expect, it, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { t, tn, messageLocale, type MessageKey } from "../../lib/i18n";

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

  it("types the key union off the English file", () => {
    // A compile-time assertion: this only builds while the union is derived from the JSON.
    const key: MessageKey = "panelTitle";
    expect(key in EN).toBe(true);
  });
});
