// test/node/flavor.test.ts — the two flavors (scripts/flavor.mjs) and what each build links.
//
// The swap itself is pinned without a build; what came out of one is read from output/
// when both flavors' Chrome builds are there and newer than the config, the way
// test/node/permissions.test.ts reads manifests (npm run build, npm run build:oneclick).
import { describe, expect, expectTypeOf, it } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { ORT_FILES } from "../../scripts/webengine.mjs";
import {
  FLAVOR_ENTRYPOINTS,
  FLAVOR_MODULES,
  buildsEntrypoint,
  flavorAliases,
  flavorOf,
  outputDir,
} from "../../scripts/flavor.mjs";
import type { EngineTransport } from "../../lib/backend/transport";
import type * as NativeTransport from "../../lib/backend/nativeTransport";
import type * as WebTransport from "../../lib/webengine/client";
import type * as NativePanel from "../../lib/ui/componentSettings";
import type * as WebPanel from "../../lib/ui/inBrowserEngine";

const ROOT = join(__dirname, "..", "..");

/** Every source file under lib/ and entrypoints/, repository-relative. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|html)$/.test(name)) out.push(relative(ROOT, path).split(sep).join("/"));
    }
  };
  for (const dir of ["lib", "entrypoints"]) walk(join(ROOT, dir));
  return out.sort();
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("choosing a flavor", () => {
  it("builds native unless ANAGRAM_FLAVOR says otherwise, and refuses a flavor it does not know", () => {
    expect(flavorOf({})).toBe("native");
    expect(flavorOf({ ANAGRAM_FLAVOR: "" })).toBe("native");
    expect(flavorOf({ ANAGRAM_FLAVOR: "oneclick" })).toBe("oneclick");
    expect(() => flavorOf({ ANAGRAM_FLAVOR: "one-click" })).toThrow(/ANAGRAM_FLAVOR/);
  });

  it("keeps the native outputs where they always were and puts oneclick beside them", () => {
    expect(outputDir("native", "chrome", 3)).toBe("chrome-mv3");
    expect(outputDir("native", "firefox", 2)).toBe("firefox-mv2");
    expect(outputDir("oneclick", "chrome", 3)).toBe("oneclick-chrome-mv3");
    expect(outputDir("oneclick", "firefox", 2)).toBe("oneclick-firefox-mv2");
  });

  it("builds the in-browser engine's page in the oneclick flavor only, and every other page in both", () => {
    expect(buildsEntrypoint("native", "engine")).toBe(false);
    expect(buildsEntrypoint("oneclick", "engine")).toBe(true);
    for (const name of ["background", "content", "onboarding", "options", "popup", "reader", "paste", "pdf-loader"]) {
      expect(buildsEntrypoint("native", name), name).toBe(true);
      expect(buildsEntrypoint("oneclick", name), name).toBe(true);
    }
    expect(Object.values(FLAVOR_ENTRYPOINTS)).not.toContain("native");
  });
});

describe("the modules each flavor links", () => {
  it("resolves every #flavor/ import to a file that exists, in both flavors", () => {
    for (const flavor of ["native", "oneclick"] as const) {
      for (const [spec, file] of Object.entries(flavorAliases(flavor, ROOT))) expect(existsSync(file), `${flavor} ${spec}`).toBe(true);
    }
  });

  it("names only specifiers the build knows", () => {
    const used = new Set(sources().flatMap((rel) => [...read(rel).matchAll(/from\s*"(#flavor\/[^"]+)"/g)].map((m) => m[1])));
    expect([...used].sort()).toEqual(Object.keys(FLAVOR_MODULES).sort());
  });

  it("lets nothing import a swapped module except through its specifier", () => {
    // A direct import would link the native transport into the oneclick build, or the
    // other way round, behind the swap's back. Type-only imports erase and do not count.
    const swapped = new Set(Object.values(FLAVOR_MODULES).flatMap((files) => Object.values(files)));
    const offenders: string[] = [];
    const IMPORT = /\b(?:import|export)\s+(type\s+)?[^"';]*?\bfrom\s*"(\.{1,2}\/[^"]+)"|\bimport\s*\(\s*"(\.{1,2}\/[^"]+)"\s*\)/g;
    for (const rel of sources()) {
      for (const m of read(rel).matchAll(IMPORT)) {
        if (m[1]) continue;
        const spec = m[2] ?? m[3]!;
        const target = join(rel, "..", spec).split(sep).join("/");
        if (swapped.has(target) || swapped.has(`${target}.ts`)) offenders.push(`${rel} → ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("gives both flavors' modules the exports their importers use, with the same types", () => {
    // Checked by tsc (npm run typecheck), which reads this file.
    expectTypeOf<ReturnType<typeof NativeTransport.engineTransport>>().toMatchTypeOf<EngineTransport>();
    expectTypeOf<ReturnType<typeof WebTransport.engineTransport>>().toMatchTypeOf<EngineTransport>();
    type Panel = "mountComponentSettings" | "componentReady" | "componentConnectionLabel";
    expectTypeOf<Pick<typeof WebPanel, Panel>>().toEqualTypeOf<Pick<typeof NativePanel, Panel>>();
  });
});

// ---- what came out of the builds ----------------------------------------------------------

const DECIDES = join(ROOT, "wxt.config.ts");
function built(dir: string): string | null {
  const out = join(ROOT, "output", dir);
  const manifest = join(out, "manifest.json");
  if (!existsSync(manifest) || statSync(manifest).mtimeMs < statSync(DECIDES).mtimeMs) return null;
  return out;
}
/** All of a build's JavaScript under `sub`, concatenated. */
function code(out: string, sub = ""): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (name !== "vendor") walk(path); }
      else if (name.endsWith(".js")) parts.push(readFileSync(path, "utf8"));
    }
  };
  walk(join(out, sub));
  return parts.join("\n");
}
/** String literals of `files` (16+ characters) that no other source file writes: text that
 *  can only be in a bundle because one of these files was linked into it. */
function ownLiterals(files: string[]): string[] {
  const others = sources().filter((rel) => !files.includes(rel)).map(read).join("\n");
  const found = new Set<string>();
  for (const rel of files) {
    for (const m of read(rel).matchAll(/"([^"\\\n]{16,})"|`([^`\\$\n]{16,})`/g)) {
      const literal = m[1] ?? m[2]!;
      if (!others.includes(literal) && !literal.startsWith("../") && !literal.startsWith("./")) found.add(literal);
    }
  }
  return [...found];
}
const webEngineFiles = (): string[] => sources().filter((rel) => rel.startsWith("lib/webengine/") || rel.startsWith("entrypoints/engine/"));

describe("what each flavor's build carries", () => {
  const native = built("chrome-mv3");
  const oneclick = built("oneclick-chrome-mv3");

  it.skipIf(!native)("the native worker talks to the local engine and carries none of the in-browser one", () => {
    const worker = readFileSync(join(native!, "background.js"), "utf8");
    expect(worker).toContain("connectNative");
    expect(worker).toContain("dev.coderbak.anagram");
    const markers = ownLiterals(webEngineFiles());
    expect(markers.length).toBeGreaterThan(0);
    expect(markers.filter((m) => code(native!).includes(m))).toEqual([]);
  });

  it.skipIf(!oneclick)("the oneclick worker carries the in-browser engine and none of the native transport", () => {
    const worker = readFileSync(join(oneclick!, "background.js"), "utf8");
    expect(worker).not.toContain("connectNative");
    expect(worker).not.toContain("dev.coderbak.anagram");
    const native = ownLiterals(["lib/backend/nativeTransport.ts"]);
    expect(native.length).toBeGreaterThan(0);
    expect(native.filter((m) => code(oneclick!).includes(m))).toEqual([]);
    const engine = ownLiterals(webEngineFiles().filter((rel) => rel.startsWith("lib/webengine/")));
    expect(engine.some((m) => worker.includes(m)), engine.join(" | ")).toBe(true);
  });

  it.skipIf(!native || !oneclick)("each flavor's pages carry their own engine panel and not the other's", () => {
    // The install command is the native panel's; the in-browser block is the other's.
    const install = ["releases/download", "Invoke-RestMethod", "componentInstallIntro"];
    expect(install.filter((m) => code(oneclick!, "chunks").includes(m))).toEqual([]);
    expect(install.every((m) => code(native!, "chunks").includes(m))).toBe(true);
    expect(code(native!, "chunks")).not.toContain("engineInBrowserIntro");
    expect(code(oneclick!, "chunks")).toContain("engineInBrowserIntro");
  });

  it.skipIf(!native || !oneclick)("only the oneclick build ships the engine's runtime", () => {
    // The files scripts/webengine.mjs prepares: the runtime's two builds and the engine's worker.
    for (const file of [...ORT_FILES, "worker.min.mjs"]) {
      expect(existsSync(join(oneclick!, "vendor", "engine", file)), file).toBe(true);
    }
    expect(existsSync(join(native!, "vendor", "engine"))).toBe(false);
    expect(existsSync(join(native!, "engine.html"))).toBe(false);
    expect(existsSync(join(oneclick!, "engine.html"))).toBe(existsSync(join(ROOT, "entrypoints", "engine")));
  });
});
