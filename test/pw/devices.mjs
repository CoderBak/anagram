// test/pw/devices.mjs — the devices the suites stand in for (test/test-build.mjs deviceBuild),
// in lib/device.ts's inputs: each is merged over what this machine says.
const ROOMY = { quota: 200e9, usage: 1e9 };

export const DEVICES = {
  /** An Apple Silicon Mac: the choice between the two engines. */
  "apple-silicon": { platform: "macOS", architecture: "arm", navigatorPlatform: "MacIntel", gpu: { vendor: "apple", architecture: "metal-3", fits: true }, deviceMemory: 8, storage: ROOMY },
  /** Windows beside an NVIDIA GPU: the choice, without the M4's figures. */
  "windows-nvidia": { platform: "Windows", architecture: "x86", navigatorPlatform: "Win32", gpu: { vendor: "nvidia", architecture: "ada", fits: true }, deviceMemory: 8, storage: ROOMY },
  /** Linux with no NVIDIA GPU: the in-browser engine, without a choice. */
  "linux-cpu": { platform: "Linux", architecture: "x86", navigatorPlatform: "Linux x86_64", gpu: null, webgl: { vendor: "Mesa", renderer: "llvmpipe" }, deviceMemory: 8, storage: ROOMY },
  /** The same with 4 GB: it runs, and says the computer may slow down. */
  "linux-4gb": { platform: "Linux", architecture: "x86", navigatorPlatform: "Linux x86_64", gpu: null, webgl: null, deviceMemory: 4, storage: ROOMY },
  /** 4 GB with a graphics card that has shader-f16: FP32 does not fit, so the lighter FP16 model. */
  "linux-4gb-f16": { platform: "Linux", architecture: "x86", navigatorPlatform: "Linux x86_64", gpu: { vendor: "intel", architecture: "gen-12", fits: true, fitsFp16: true, f16: true }, webgl: null, deviceMemory: 4, storage: ROOMY },
  /** Too little memory, and no local engine offered: nothing runs. */
  "linux-2gb": { platform: "Linux", architecture: "x86", navigatorPlatform: "Linux x86_64", gpu: null, webgl: null, deviceMemory: 2, storage: ROOMY },
};
