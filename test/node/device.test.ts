// test/node/device.test.ts — which engine each device is offered (lib/device.ts), row by row.
import { describe, expect, it } from "vitest";
import { DISK_MARGIN, TIERS, decide, type DeviceInputs } from "../../lib/device";

const GB = 1e9;
const roomy = { quota: 200 * GB, usage: 1 * GB };
const chrome = (over: Partial<DeviceInputs>): DeviceInputs => ({ browser: "chrome", jspi: true, deviceMemory: 8, storage: roomy, ...over });
const firefox = (over: Partial<DeviceInputs>): DeviceInputs => ({ browser: "firefox", jspi: true, storage: roomy, ...over });

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

describe("Firefox 140: no WebAssembly JSPI", () => {
  it("offers the local engine only, where it installs", () => {
    expect(decide(firefox({ jspi: false, navigatorPlatform: "MacIntel", webgl: { renderer: "Apple M1, or similar" } }))).toMatchObject({ offer: "terminal-only", reason: "no-jspi", path: null, tier: null });
    expect(decide(firefox({ jspi: false, navigatorPlatform: "Linux x86_64" }))).toMatchObject({ offer: "terminal-only", reason: "no-jspi" });
    expect(decide(firefox({ jspi: false, navigatorPlatform: "Win32" }))).toMatchObject({ offer: "terminal-only" });
  });

  it("runs nothing where the local engine does not install either", () => {
    expect(decide(firefox({ jspi: false, navigatorPlatform: "MacIntel", webgl: { renderer: "Intel(R) HD Graphics, or similar" } }))).toMatchObject({ offer: "cannot-run", reason: "no-jspi" });
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
