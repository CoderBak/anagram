// test/node/engines.test.ts — one extension, two engines: which one scores
// (lib/backend/engines.ts), and what the one build carries of each.
//
// What came out of a build is read from output/ when it is there and newer than the config,
// the way test/node/permissions.test.ts reads manifests (npm run build, build:firefox, build:test).
import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { LID as PACKAGED_LID, ORT_FILES } from "../../scripts/webengine.mjs";
import { LID, LID_PATH } from "../../lib/webengine/pin";
import type { EngineTransport } from "../../lib/backend/transport";
import type { NativeReply } from "../../lib/backend/nativeProtocol";
import type * as NativePanel from "../../lib/ui/componentSettings";
import type * as WebPanel from "../../lib/ui/inBrowserEngine";

const ROOT = join(__dirname, "..", "..");

// ---- which engine scores ------------------------------------------------------------------

/** A transport that answers every request with the name of its engine. */
function fakeTransport(name: string) {
  const listeners = new Set<() => void>();
  return {
    requests: [] as string[],
    closed: 0,
    request(op: string): Promise<NativeReply> {
      this.requests.push(op);
      return Promise.resolve({ v: 1, id: name, ok: true, status: 200, data: { engine: name } });
    },
    onDisconnect(listener: () => void) { listeners.add(listener); return () => listeners.delete(listener); },
    close() { this.closed++; for (const listener of listeners) listener(); },
    retry() {},
  };
}
const transports = vi.hoisted(() => ({ native: undefined as ReturnType<typeof fakeTransport> | undefined, inbrowser: undefined as ReturnType<typeof fakeTransport> | undefined, webClosed: 0 }));
vi.mock("../../lib/backend/nativeTransport", () => ({ nativeTransport: () => (transports.native ??= fakeTransport("native")) }));
vi.mock("../../lib/webengine/client", () => ({
  webEngineTransport: () => (transports.inbrowser ??= fakeTransport("inbrowser")),
  closeWebEngine: async () => { transports.webClosed++; transports.inbrowser?.close(); },
}));

let granted = false;
beforeEach(() => {
  fakeBrowser.reset();
  granted = false;
  Object.assign(fakeBrowser as unknown as Record<string, unknown>, {
    permissions: {
      contains: async ({ permissions }: { permissions: string[] }) => granted && permissions.every((p) => p === "nativeMessaging"),
      onAdded: { addListener() {} }, onRemoved: { addListener() {} },
    },
  });
  vi.resetModules();
  transports.native = transports.inbrowser = undefined;
  transports.webClosed = 0;
});

const load = () => import("../../lib/backend/engines");
const engineOf = (reply: NativeReply) => (reply.data as { engine: string }).engine;

describe("the engine in use", () => {
  it("is none before a choice, and every request is refused as unavailable", async () => {
    const { activeEngine, engineTransport } = await load();
    expect(await activeEngine()).toBeNull();
    await expect(engineTransport().request("health")).rejects.toMatchObject({ code: "native_unavailable" });
  });

  it("is the local engine where Native Messaging is granted and nothing was chosen: an update from a release that required it", async () => {
    granted = true;
    const { activeEngine, engineTransport } = await load();
    expect(await activeEngine()).toBe("native");
    expect(engineOf(await engineTransport().request("health"))).toBe("native");
  });

  it("is the one chosen, and follows a switch: the other engine is closed and health is read again", async () => {
    granted = true;
    const { engineChoice, engineTransport } = await load();
    await engineChoice.setValue("inbrowser");
    const transport = engineTransport();
    expect(engineOf(await transport.request("health"))).toBe("inbrowser");
    let disconnects = 0;
    transport.onDisconnect(() => disconnects++);
    await engineChoice.setValue("native");
    expect(await transport.refresh()).toBe("native");
    expect(transports.webClosed).toBe(1);
    expect(disconnects).toBeGreaterThan(0);
    expect(engineOf(await transport.request("health"))).toBe("native");
    // And back: the local engine's connection closes; the in-browser one starts again on its next request.
    await engineChoice.setValue("inbrowser");
    await transport.refresh();
    expect(transports.native!.closed).toBe(1);
    expect(engineOf(await transport.request("status"))).toBe("inbrowser");
  });

  it("forgets nothing when a disconnect comes from the engine not in use", async () => {
    const { engineChoice, engineTransport } = await load();
    await engineChoice.setValue("inbrowser");
    const transport = engineTransport();
    await transport.current();
    let disconnects = 0;
    transport.onDisconnect(() => disconnects++);
    transports.native!.close();
    expect(disconnects).toBe(0);
    transports.inbrowser!.close();
    expect(disconnects).toBe(1);
  });
});

describe("the two engine panels", () => {
  it("export the same names with the same types, so the engine card mounts either", () => {
    // Checked by tsc (npm run typecheck), which reads this file.
    type Panel = "mountComponentSettings" | "componentReady" | "componentConnectionLabel";
    expectTypeOf<Pick<typeof WebPanel, Panel>>().toEqualTypeOf<Pick<typeof NativePanel, Panel>>();
    expectTypeOf<ReturnType<Awaited<ReturnType<typeof load>>["transportOf"]>>().toMatchTypeOf<EngineTransport>();
  });
});

/** Every source file under lib/, entrypoints/, scripts/ and test/, repository-relative. */
function sources(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) { if (!["fixtures", "pdf-bench", "web-bench"].includes(name)) walk(path); }
      else if (/\.(ts|mts|mjs|html|py)$/.test(name)) out.push(relative(ROOT, path).split(sep).join("/"));
    }
  };
  for (const dir of ["lib", "entrypoints", "scripts", "test"]) walk(join(ROOT, dir));
  return out.sort();
}
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

describe("no build flavors", () => {
  it("builds one extension: nothing selects a flavor or swaps a module for one", () => {
    const offenders = sources().filter((rel) => rel !== "test/node/engines.test.ts" && /ANAGRAM_FLAVOR|#flavor\/|scripts\/flavor|public-oneclick/.test(read(rel)));
    expect(offenders).toEqual([]);
    const scripts = Object.keys(JSON.parse(read("package.json")).scripts as Record<string, string>);
    expect(scripts.filter((name) => name.includes("oneclick"))).toEqual([]);
    expect(scripts).toContain("test:inbrowser");
  });
});

describe("the language identifier the package carries", () => {
  it("is the file the build fetches and the native installer pins, at the path the engine reads", () => {
    const { url, ...pinned } = PACKAGED_LID;
    expect(pinned).toEqual(LID);
    expect(url).toBe("https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz");
    const native = read("anagramd/download_modelkit.py");
    expect(native).toContain(`LID_URL = "${url}"`);
    expect(native).toContain(`"size_bytes": ${LID.size_bytes}`);
    expect(native).toContain(`"sha256": "${LID.sha256}"`);
    expect(LID_PATH).toBe(`/vendor/engine/${LID.name}`);
  });
});

// ---- what came out of the builds ----------------------------------------------------------

const DECIDES = join(ROOT, "wxt.config.ts");
function built(dir: string, out = "output"): string | null {
  const path = join(ROOT, out, dir);
  const manifest = join(path, "manifest.json");
  if (!existsSync(manifest) || statSync(manifest).mtimeMs < statSync(DECIDES).mtimeMs) return null;
  return path;
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

describe("what the one build carries", () => {
  const chrome = built("chrome-mv3");
  const firefox = built("firefox-mv2");
  const test = built("chrome-mv3", "output-test");

  it.skipIf(!chrome)("the worker reaches both engines", () => {
    const worker = readFileSync(join(chrome!, "background.js"), "utf8");
    expect(worker).toContain("connectNative");
    expect(worker).toContain("dev.coderbak.anagram");
    expect(worker).toContain("engine.html");
  });

  it.skipIf(!chrome)("the pages carry both panels and the choice between them", () => {
    const pages = code(chrome!, "chunks");
    for (const marker of ["releases/download", "Invoke-RestMethod", "componentInstallIntro", "engineSetUpIntro", "engineOneClickButton", "engineTerminalButton"]) {
      expect(pages, marker).toContain(marker);
    }
  });

  it.skipIf(!chrome || !firefox)("ships the in-browser engine's runtime, and Chrome its offscreen document", () => {
    for (const out of [chrome!, firefox!]) {
      expect(readdirSync(join(out, "vendor", "engine")).sort()).toEqual(
        [...ORT_FILES, "LICENSE.onnxruntime-web", "ThirdPartyNotices.onnxruntime-web.txt", "worker.min.mjs", LID.name].sort());
      const lid = readFileSync(join(out, LID_PATH));
      expect([lid.length, createHash("sha256").update(lid).digest("hex")]).toEqual([LID.size_bytes, LID.sha256]);
    }
    expect(existsSync(join(chrome!, "engine.html"))).toBe(true);
    expect(existsSync(join(firefox!, "engine.html"))).toBe(false);
  });

  it.skipIf(!chrome)("never reads a stand-in device in the shipping build", () => {
    expect(code(chrome!)).not.toContain("test-device.json");
    expect(existsSync(join(chrome!, "test-device.json"))).toBe(false);
  });

  it.skipIf(!test)("…while the test build does, from a file only a suite puts there", () => {
    expect(code(test!)).toContain("test-device.json");
    expect(existsSync(join(test!, "test-device.json"))).toBe(false);
  });
});
