// test/node/device.test.ts — which engine each device is offered (lib/device.ts), row by row.
import { describe, expect, it } from "vitest";
import { DISK_MARGIN, TIERS, decide, type DeviceInputs } from "../../lib/device";

const GB = 1e9;
const roomy = { quota: 200 * GB, usage: 1 * GB };
const chrome = (over: Partial<DeviceInputs>): DeviceInputs => ({ browser: "chrome", deviceMemory: 8, storage: roomy, ...over });
const firefox = (over: Partial<DeviceInputs>): DeviceInputs => ({ browser: "firefox", storage: roomy, ...over });

// What the browsers really say, as the gatherer (lib/ui/deviceInputs.ts) passes it on.
const M4 = { platform: "macOS", architecture: "arm", navigatorPlatform: "MacIntel", gpu: { vendor: "apple", architecture: "metal-3" },
  webgl: { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)" } };
const INTEL_MAC = { platform: "macOS", architecture: "x86", navigatorPlatform: "MacIntel", gpu: { vendor: "intel", architecture: "gen-9" },
  webgl: { vendor: "Google Inc. (Apple)", renderer: "ANGLE (Apple, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics 655, Unspecified Version)" } };
const WIN_NVIDIA = { platform: "Windows", architecture: "x86", navigatorPlatform: "Win32", gpu: { vendor: "nvidia", architecture: "ampere" },
  webgl: { vendor: "Google Inc. (NVIDIA)", renderer: "ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)" } };

describe("the rule, row by row", () => {
  it("offers an Apple Silicon Mac the choice, with the graphics card for the in-browser engine", () => {
    expect(decide(chrome(M4))).toMatchObject({ offer: "choice", reason: "apple-silicon", machine: "apple-silicon", path: "webgpu", native: true, tier: "fp32", tight: false });
  });

  it("knows an Apple Silicon Mac in Firefox, which says MacIntel on every Mac, by its GPU", () => {
    // WebGPU's vendor, or WebGL's renderer where there is no WebGPU.
    expect(decide(firefox({ navigatorPlatform: "MacIntel", gpu: { vendor: "apple", architecture: "metal-3" } }))).toMatchObject({ offer: "choice", machine: "apple-silicon", path: "webgpu" });
    expect(decide(firefox({ navigatorPlatform: "MacIntel", gpu: null, webgl: { vendor: "Apple", renderer: "Apple M1, or similar" } }))).toMatchObject({ offer: "choice", machine: "apple-silicon", path: "cpu" });
    expect(decide(firefox({ navigatorPlatform: "MacIntel", gpu: null, webgl: { vendor: "Apple", renderer: "Apple GPU" } }))).toMatchObject({ offer: "choice", machine: "apple-silicon" });
  });

  it("runs an Intel Mac in the browser without a choice: install.sh has no Intel runtime", () => {
    expect(decide(chrome(INTEL_MAC))).toMatchObject({ offer: "auto-inbrowser", reason: "intel-mac", machine: "intel-mac", native: false });
    // Metal names its vendor Apple on an Intel Mac too: that is not an Apple GPU.
    expect(decide(chrome({ ...INTEL_MAC, architecture: undefined, gpu: null }))).toMatchObject({ offer: "auto-inbrowser", machine: "intel-mac", path: "cpu" });
    expect(decide(firefox({ navigatorPlatform: "MacIntel", gpu: null, webgl: { vendor: "Intel", renderer: "Intel(R) HD Graphics, or similar" } }))).toMatchObject({ offer: "auto-inbrowser", machine: "intel-mac", native: false });
  });

  it("offers Windows and Linux with an NVIDIA GPU the choice", () => {
    expect(decide(chrome(WIN_NVIDIA))).toMatchObject({ offer: "choice", reason: "nvidia", machine: "nvidia", native: true });
    // WebGL's renderer, where WebGPU has no adapter (Chrome on Linux, mostly).
    expect(decide(chrome({ platform: "Linux", architecture: "x86", gpu: null, webgl: { vendor: "Google Inc. (NVIDIA Corporation)", renderer: "ANGLE (NVIDIA Corporation, NVIDIA GeForce GTX 1080/PCIe/SSE2, OpenGL 4.5.0)" } })))
      .toMatchObject({ offer: "choice", machine: "nvidia", path: "cpu" });
    expect(decide(firefox({ navigatorPlatform: "Linux x86_64", webgl: { vendor: "NVIDIA Corporation", renderer: "NVIDIA GeForce RTX 4090, or similar" } }))).toMatchObject({ offer: "choice", machine: "nvidia" });
  });

  it("runs Windows and Linux with any other GPU, or none, in the browser without a choice", () => {
    expect(decide(chrome({ platform: "Windows", architecture: "x86", gpu: { vendor: "amd" }, webgl: { renderer: "ANGLE (AMD, AMD Radeon RX 6800 Direct3D11 vs_5_0 ps_5_0, D3D11)" } })))
      .toMatchObject({ offer: "auto-inbrowser", reason: "no-nvidia", native: true, path: "webgpu" });
    expect(decide(chrome({ platform: "Windows", architecture: "x86", gpu: { vendor: "intel" } }))).toMatchObject({ offer: "auto-inbrowser", reason: "no-nvidia" });
    expect(decide(chrome({ platform: "Linux", architecture: "x86", gpu: null, webgl: null }))).toMatchObject({ offer: "auto-inbrowser", reason: "no-nvidia", path: "cpu" });
    expect(decide(firefox({ navigatorPlatform: "Linux x86_64", gpu: null, webgl: { renderer: "llvmpipe, or similar" } }))).toMatchObject({ offer: "auto-inbrowser" });
  });

  it("runs every other system in the browser, where no installer serves it", () => {
    expect(decide(chrome({ platform: "Chrome OS", architecture: "x86", gpu: { vendor: "intel" } }))).toMatchObject({ offer: "auto-inbrowser", reason: "no-installer", native: false });
    expect(decide(chrome({ platform: "Windows", architecture: "arm", gpu: { vendor: "qualcomm" } }))).toMatchObject({ offer: "auto-inbrowser", native: false });
  });

  it("takes the processor path where the GPU cannot bind the model's largest tensor", () => {
    expect(decide(chrome({ ...M4, gpu: { vendor: "apple", fits: false } }))).toMatchObject({ offer: "choice", path: "cpu" });
  });
});

describe("what the device can afford", () => {
  it("does not run the in-browser engine below 4 GB, unless the local engine is offered", () => {
    expect(decide(chrome({ platform: "Linux", gpu: null, deviceMemory: 2 }))).toMatchObject({ offer: "cannot-run", reason: "memory", path: null });
    expect(decide(chrome({ ...INTEL_MAC, deviceMemory: 2 }))).toMatchObject({ offer: "cannot-run", reason: "memory" });
    expect(decide(chrome({ ...M4, deviceMemory: 2 }))).toMatchObject({ offer: "terminal-only", reason: "memory" });
    expect(decide(chrome({ ...WIN_NVIDIA, deviceMemory: 0.5 }))).toMatchObject({ offer: "terminal-only", reason: "memory" });
  });

  it("runs on 4 GB with a note that the computer may slow down, and on unknown memory as on plenty", () => {
    expect(decide(chrome({ platform: "Linux", gpu: null, deviceMemory: 4 }))).toMatchObject({ offer: "auto-inbrowser", tight: true });
    expect(decide(chrome({ ...M4, deviceMemory: 4 }))).toMatchObject({ offer: "choice", tight: true });
    expect(decide(chrome({ ...M4, deviceMemory: 8 }))).toMatchObject({ tight: false });
    expect(decide(firefox({ navigatorPlatform: "Linux x86_64" }))).toMatchObject({ offer: "auto-inbrowser", tight: false });
  });

  it("needs the model's bytes and a margin free on disk, less what is already there", () => {
    const need = TIERS[0].bytes + DISK_MARGIN;
    expect(decide(chrome({ platform: "Linux", storage: { quota: need - 1, usage: 0 } }))).toMatchObject({ offer: "cannot-run", reason: "disk" });
    expect(decide(chrome({ platform: "Linux", storage: { quota: need + GB, usage: GB } }))).toMatchObject({ offer: "auto-inbrowser" });
    expect(decide(chrome({ ...M4, storage: { quota: 1 * GB, usage: 0 } }))).toMatchObject({ offer: "terminal-only", reason: "disk" });
    // A download under way (or model files kept) needs only the rest.
    expect(decide(chrome({ platform: "Linux", storage: { quota: GB, usage: 0 }, stored: TIERS[0].bytes }))).toMatchObject({ offer: "auto-inbrowser" });
    // No estimate: room is not known to be short.
    expect(decide(chrome({ platform: "Linux", storage: undefined }))).toMatchObject({ offer: "auto-inbrowser" });
  });

  it("names memory before disk when both fall short", () => {
    expect(decide(chrome({ platform: "Linux", deviceMemory: 2, storage: { quota: 1, usage: 0 } }))).toMatchObject({ offer: "cannot-run", reason: "memory" });
  });
});

describe("the FP16 tier, only where FP32 does not fit", () => {
  const F16 = { ...M4, gpu: { vendor: "apple", architecture: "metal-3", fits: true, fitsFp16: true, f16: true } };
  const need32 = TIERS[0].bytes + DISK_MARGIN;
  const need16 = TIERS[1].bytes + DISK_MARGIN;
  const HALF = { platform: "Linux", architecture: "x86", navigatorPlatform: "Linux x86_64" };

  it("keeps FP32 the automatic pick where it fits, whatever the graphics card offers", () => {
    expect(decide(chrome({ ...F16, deviceMemory: 8 }))).toMatchObject({ tier: "fp32", tight: false, fallback: null });
    expect(decide(chrome({ ...F16, deviceMemory: 16 }))).toMatchObject({ tier: "fp32" });
    // 4 GB without shader-f16, or without a graphics card at all, is FP32 with the note as it was.
    expect(decide(chrome({ ...M4, deviceMemory: 4 }))).toMatchObject({ tier: "fp32", tight: true });
    expect(decide(chrome({ ...HALF, gpu: null, deviceMemory: 4 }))).toMatchObject({ tier: "fp32", tight: true });
  });

  it("runs FP16 on the graphics card where deviceMemory is exactly 4", () => {
    expect(decide(chrome({ ...F16, deviceMemory: 4 }))).toMatchObject({ offer: "choice", tier: "fp16", path: "webgpu", tight: false, fallback: { tight: true } });
    expect(decide(chrome({ ...HALF, gpu: { vendor: "intel", f16: true, fits: true }, deviceMemory: 4 })))
      .toMatchObject({ offer: "auto-inbrowser", tier: "fp16", path: "webgpu" });
  });

  it("runs FP16 where the free disk cannot take FP32 but can take FP16", () => {
    expect(decide(chrome({ ...F16, storage: { quota: need32 - 1, usage: 0 } }))).toMatchObject({ tier: "fp16", fallback: null });
    expect(decide(chrome({ ...F16, storage: { quota: need16, usage: 0 } }))).toMatchObject({ tier: "fp16", fallback: null });
    // The rest of what is stored counts, as for FP32.
    expect(decide(chrome({ ...F16, storage: { quota: need16 - 1, usage: 0 }, stored: 1e6 }))).toMatchObject({ tier: "fp16" });
    // Not enough for FP16 either: short on disk, as ever.
    expect(decide(chrome({ ...F16, storage: { quota: need16 - 1, usage: 0 } }))).toMatchObject({ offer: "terminal-only", reason: "disk", tier: null });
    expect(decide(chrome({ ...HALF, gpu: { vendor: "intel", f16: true }, storage: { quota: need16 - 1, usage: 0 } }))).toMatchObject({ offer: "cannot-run", reason: "disk" });
  });

  it("runs FP16 where the adapter holds FP16's largest tensor but not FP32's", () => {
    const small = { ...M4, gpu: { vendor: "apple", architecture: "metal-3", fits: false, fitsFp16: true, f16: true } };
    expect(decide(chrome({ ...small, deviceMemory: 8 }))).toMatchObject({ tier: "fp16", path: "webgpu", tight: false, fallback: { tight: false } });
    // Neither fits: the processor, FP32 as before.
    expect(decide(chrome({ ...M4, gpu: { vendor: "apple", fits: false, fitsFp16: false, f16: true } }))).toMatchObject({ tier: "fp32", path: "cpu" });
    // Without shader-f16 it stays FP32 on the processor.
    expect(decide(chrome({ ...M4, gpu: { vendor: "apple", fits: false, fitsFp16: true, f16: false } }))).toMatchObject({ tier: "fp32", path: "cpu" });
  });

  it("needs a real adapter with shader-f16, and never runs FP16 on the processor", () => {
    expect(decide(chrome({ ...HALF, gpu: null, deviceMemory: 4 }))).toMatchObject({ tier: "fp32", path: "cpu" });
    expect(decide(chrome({ ...HALF, gpu: { vendor: "intel", f16: false }, deviceMemory: 4 }))).toMatchObject({ tier: "fp32", tight: true });
    expect(decide(chrome({ ...HALF, gpu: null, storage: { quota: need16, usage: 0 } }))).toMatchObject({ offer: "cannot-run", reason: "disk" });
  });

  it("stays out of reach below 4 GB, whatever the card", () => {
    expect(decide(chrome({ ...F16, deviceMemory: 2 }))).toMatchObject({ offer: "terminal-only", reason: "memory", tier: null });
    expect(decide(chrome({ ...HALF, gpu: { vendor: "intel", f16: true }, deviceMemory: 2 }))).toMatchObject({ offer: "cannot-run", reason: "memory" });
    expect(decide(chrome({ ...HALF, gpu: { vendor: "intel", f16: true }, deviceMemory: 1, storage: { quota: need16 - 1, usage: 0 } }))).toMatchObject({ reason: "memory" });
  });

  it("takes unknown memory (Firefox) for FP32", () => {
    expect(decide(firefox({ navigatorPlatform: "Linux x86_64", gpu: { vendor: "intel", f16: true, fits: true } }))).toMatchObject({ tier: "fp32" });
  });

  it("keeps a complete FP32 model already in storage", () => {
    expect(decide(chrome({ ...F16, deviceMemory: 4, stored: TIERS[0].bytes }))).toMatchObject({ tier: "fp32", tight: true });
  });

  it("pins FP16's size and its largest tensor at half of FP32's", () => {
    expect(TIERS.map((t) => [t.id, t.bytes])).toEqual([["fp32", 1_425_459_555], ["fp16", 711_340_748 + 3_558_642]]);
    expect(TIERS[1].maxTensorBytes * 2).toBe(TIERS[0].maxTensorBytes);
    expect(TIERS[0].maxTensorBytes).toBe(50265 * 1024 * 4);
  });
});
