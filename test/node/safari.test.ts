import { describe, expect, it } from "vitest";
import { decide, TIERS, DISK_MARGIN, type DeviceInputs } from "../../lib/device";
import { engineOwner } from "../../lib/webengine/owner";

const mac: DeviceInputs = {
  browser: "safari", navigatorPlatform: "MacIntel", webRuntime: true,
  gpu: { vendor: "apple", fits: true, fitsFp16: true, f16: true },
};

describe("Safari setup", () => {
  it("offers only WebGPU in a temporary extension with no native app bridge", () => {
    expect(decide(mac)).toMatchObject({ offer: "auto-inbrowser", native: false, path: "webgpu", tier: "fp32", fallback: null });
  });

  it("offers the shared engine choice in a full Safari app on Apple Silicon", () => {
    expect(decide({ ...mac, nativeBridge: true }))
      .toMatchObject({ offer: "choice", native: true, path: "webgpu", tier: "fp32", fallback: null });
  });

  it("keeps the separate engine available when Safari cannot run WebGPU", () => {
    expect(decide({ ...mac, nativeBridge: true, webRuntime: false }))
      .toMatchObject({ offer: "terminal-only", native: true, path: null });
    expect(decide({ ...mac, nativeBridge: true, gpu: null, architecture: "arm" }))
      .toMatchObject({ offer: "terminal-only", native: true, path: null });
  });

  it("does not offer the native installer on Intel Macs or other platforms", () => {
    expect(decide({ ...mac, nativeBridge: true, architecture: "x86", gpu: { vendor: "intel", fits: true } }))
      .toMatchObject({ offer: "auto-inbrowser", native: false });
    expect(decide({ ...mac, nativeBridge: true, navigatorPlatform: "iPhone" }))
      .toMatchObject({ offer: "cannot-run", native: false });
  });

  it("blocks unsupported browsers and adapters before a model downloads", () => {
    for (const gpu of [null, { fits: false, fitsFp16: false, f16: true }, { fits: false, fitsFp16: true, f16: false }]) {
      expect(decide({ ...mac, gpu })).toMatchObject({ offer: "cannot-run", native: false, path: null, reason: "webgpu" });
    }
    expect(decide({ ...mac, webRuntime: false })).toMatchObject({ offer: "cannot-run", reason: "browser" });
    expect(decide({ ...mac, navigatorPlatform: "iPhone" })).toMatchObject({ offer: "cannot-run", reason: "browser" });
  });

  it("selects FP16 when only its tensors fit the GPU, with no CPU fallback", () => {
    expect(decide({ ...mac, gpu: { fits: false, fitsFp16: true, f16: true } }))
      .toMatchObject({ offer: "auto-inbrowser", path: "webgpu", tier: "fp16", fallback: null });
  });

  it("requires room for the model even when WebGPU is available", () => {
    expect(decide({ ...mac, storage: { quota: TIERS[1].bytes + DISK_MARGIN - 1, usage: 0 } }))
      .toMatchObject({ offer: "cannot-run", reason: "disk", native: false });
  });
});

describe("engine document authorization", () => {
  const root = "safari-web-extension://extension-id/";
  it("accepts the background and rejects content scripts and other extension pages", () => {
    expect(engineOwner({ id: "own", url: root + "background.js" }, "own", root)).toBe(true);
    expect(engineOwner({ id: "own" }, "own", root)).toBe(true);
    for (const sender of [undefined, { id: "other" }, { id: "own", tab: { id: 1 }, url: "https://example.com" },
      { id: "own", url: root + "popup.html" }, { id: "own", url: "https://example.com/background.js" }]) {
      expect(engineOwner(sender, "own", root)).toBe(false);
    }
  });
});
