// lib/device.ts — which engine this device is offered, from what the browser tells a page.
//
// One extension carries both engines. The setup page decides, before anything downloads:
//
//   Apple Silicon Mac                    choice: native MLX scores a paragraph in 43 ms at
//                                        ~1.8 GB, the browser in 92 ms at up to 2.5 GB
//   Windows or Linux with an NVIDIA GPU  choice: native PyTorch CUDA
//   Intel Mac                            in the browser, automatically: install.sh has no
//                                        Intel macOS runtime
//   anything else                        in the browser, automatically: native ONNX on the
//                                        processor measured slower than the browser's WASM
//   a browser without WebAssembly JSPI   (Firefox 140) the local engine only, where it installs
//
// and the in-browser engine only where the device can afford it (affordable() below). The
// function is pure; lib/ui/deviceInputs.ts reads its inputs in a page.

/** What a page can learn about the device without asking the person. */
export interface DeviceInputs {
  /** Which browser this build is for. */
  browser: "chrome" | "firefox";
  /** `navigator.userAgentData.getHighEntropyValues(["platform", "architecture"])`: "macOS",
   *  "Windows", "Linux", "Chrome OS"…, and "arm" or "x86". Chrome only. */
  platform?: string;
  architecture?: string;
  /** `navigator.platform`, where there is nothing better: Firefox says "MacIntel" on every Mac. */
  navigatorPlatform?: string;
  /** The WebGPU adapter's `info`, when the browser offers one that is not a fallback (software)
   *  adapter; `fits` is false when it cannot bind the model's largest tensor (session.ts). */
  gpu?: { vendor?: string; architecture?: string; description?: string; fits?: boolean } | null;
  /** WebGL's UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL, where WebGPU says nothing. */
  webgl?: { vendor?: string; renderer?: string } | null;
  /** `navigator.deviceMemory` in GB (Chrome only; rounded down to a power of two). */
  deviceMemory?: number;
  /** `navigator.storage.estimate()`. */
  storage?: { quota?: number; usage?: number };
  /** Bytes of the in-browser model already in the browser's storage. */
  stored?: number;
  /** WebAssembly JSPI, which the in-browser engine's runtime needs on both of its paths. */
  jspi: boolean;
}

export type Offer = "choice" | "auto-inbrowser" | "terminal-only" | "cannot-run";
export type Machine = "apple-silicon" | "intel-mac" | "nvidia" | "other";
export type Reason =
  /** choice */
  | "apple-silicon" | "nvidia"
  /** auto-inbrowser */
  | "intel-mac" | "no-nvidia" | "no-installer"
  /** terminal-only, or cannot-run where the local engine does not install either */
  | "no-jspi"
  /** the in-browser engine does not fit; terminal-only where the local engine installs */
  | "memory" | "disk";

export interface Decision {
  offer: Offer;
  reason: Reason;
  machine: Machine;
  /** The path the in-browser engine is expected to take here, or null where it cannot run. */
  path: "webgpu" | "cpu" | null;
  /** Memory is enough but tight (4 GB): the computer may slow down while it scores. */
  tight: boolean;
  /** Whether the local engine's installer supports this device (false only where it is
   *  known not to: an Intel Mac, Windows on ARM, a system it has no installer for). */
  native: boolean;
  /** The model tier the in-browser engine would run: FP32, the only one (TIERS). */
  tier: Tier["id"] | null;
}

/**
 * The in-browser model tiers, largest first, with what each takes: its download, and the
 * least memory (Chrome's deviceMemory, a power of two) it runs in. FP32 peaks at 2.5 GB
 * while scoring on the graphics card and 1.9 GB on the processor (an M4), so it needs 4 GB,
 * and on exactly 4 GB the computer may slow down while it scores.
 *
 * SMALLER TIER HOOK. The user is still deciding whether to ship a smaller (int8) model. It
 * would be a second entry here with its own size and memory, and affordable() would then
 * pick it where FP32 does not fit, before giving up. Until then FP32 is the only tier and
 * the only automatic pick; nothing here quantizes anything.
 */
export const TIERS = [
  { id: "fp32", bytes: 1_425_459_555, minMemoryGb: 4 },
] as const;
export type Tier = typeof TIERS[number];

/** Room on disk beyond the model's own bytes: the engine's state, and slack for the browser. */
export const DISK_MARGIN = 200e6;

/** The measured speed and memory each engine is described by (on an M4 Mac). */
export const MEASURED = { inbrowser: { ms: 92, gb: 2.5 }, native: { ms: 43, gb: 1.8 } } as const;

type Os = "mac" | "windows" | "linux" | "other";

function osOf(i: DeviceInputs): Os {
  const p = (i.platform || i.navigatorPlatform || "").toLowerCase();
  if (/^mac|darwin/.test(p)) return "mac";
  if (/^win/.test(p)) return "windows";
  // Chrome OS and Android are Linux underneath, and no installer serves them.
  if (/chrome ?os|cros|android/.test(p)) return "other";
  if (/linux/.test(p)) return "linux";
  return "other";
}

/** Everything the GPU's names say, in one lower-case line. */
function gpuText(i: DeviceInputs): string {
  return [i.gpu?.vendor, i.gpu?.architecture, i.gpu?.description, i.webgl?.vendor, i.webgl?.renderer]
    .filter(Boolean).join(" ").toLowerCase();
}

/** Apple's own GPU. Not "Apple" alone: Chrome's WebGL names Metal's vendor "Apple" on an
 *  Intel Mac too ("ANGLE (Apple, ANGLE Metal Renderer: Intel(R) Iris(TM) Plus Graphics…)"). */
function appleGpu(i: DeviceInputs): boolean {
  return i.gpu?.vendor?.toLowerCase() === "apple" || /\bapple (m\d|gpu)\b/i.test(i.webgl?.renderer ?? "");
}

const NVIDIA = /nvidia|geforce|quadro|\brtx\b|tesla/;

function machineOf(i: DeviceInputs, os: Os): Machine {
  if (os === "mac") {
    // Firefox says "MacIntel" on every Mac: its GPU is what tells an Apple Silicon Mac apart.
    if (i.architecture === "arm" || appleGpu(i)) return "apple-silicon";
    const other = i.gpu?.vendor ?? /\b(intel|amd|ati|radeon)\b/.exec(gpuText(i))?.[1];
    return i.architecture === "x86" || other ? "intel-mac" : "other";
  }
  if ((os === "windows" || os === "linux") && NVIDIA.test(gpuText(i))) return "nvidia";
  return "other";
}

/** Where the local engine installs: Apple Silicon macOS, x64 Windows, glibc Linux (x86_64 or
 *  arm64). A Mac whose kind nobody could tell is given the benefit of the doubt: the
 *  installer itself says so on an Intel one. */
function nativeInstalls(os: Os, machine: Machine, i: DeviceInputs): boolean {
  if (os === "mac") return machine !== "intel-mac";
  if (os === "windows") return i.architecture !== "arm";
  return os === "linux";
}

/**
 * The largest tier this device can afford, memory first, then disk; null with what fell
 * short when none. Unknown memory (Firefox has no deviceMemory) and an unknown estimate run.
 */
export function affordable(i: DeviceInputs): { tier: Tier | null; short: "memory" | "disk" | null; tight: boolean } {
  let short: "memory" | "disk" | null = null;
  // SMALLER TIER HOOK: every tier is tried in turn; FP32 is the only one.
  for (const tier of TIERS) {
    if (i.deviceMemory !== undefined && i.deviceMemory < tier.minMemoryGb) { short ??= "memory"; continue; }
    const { quota, usage } = i.storage ?? {};
    const needed = Math.max(0, tier.bytes - (i.stored ?? 0)) + DISK_MARGIN;
    if (quota !== undefined && usage !== undefined && quota - usage < needed) { short ??= "disk"; continue; }
    return { tier, short: null, tight: i.deviceMemory === tier.minMemoryGb };
  }
  return { tier: null, short, tight: false };
}

/** Which engines this device is offered, and why. */
export function decide(i: DeviceInputs): Decision {
  const os = osOf(i);
  const machine = machineOf(i, os);
  const native = nativeInstalls(os, machine, i);
  const path: "webgpu" | "cpu" = i.gpu && i.gpu.fits !== false ? "webgpu" : "cpu";
  const base = { machine, native, tight: false, tier: null, path: null };
  if (!i.jspi) {
    // Firefox 140: the runtime's only build needs JSPI, which Firefox has from 153.
    return { ...base, offer: native ? "terminal-only" : "cannot-run", reason: "no-jspi" };
  }
  const fits = affordable(i);
  if (!fits.tier) {
    // Nothing is downloaded where the model does not fit, and nothing is ever scored
    // anywhere else; where the local engine installs, it is what is left.
    const choiceDevice = native && (machine === "apple-silicon" || machine === "nvidia");
    return { ...base, offer: choiceDevice ? "terminal-only" : "cannot-run", reason: fits.short ?? "memory" };
  }
  const inBrowser = { ...base, path, tight: fits.tight, tier: fits.tier.id };
  if (native && machine === "apple-silicon") return { ...inBrowser, offer: "choice", reason: "apple-silicon" };
  if (native && machine === "nvidia") return { ...inBrowser, offer: "choice", reason: "nvidia" };
  const reason = machine === "intel-mac" ? "intel-mac" : os === "windows" || os === "linux" ? "no-nvidia" : "no-installer";
  return { ...inBrowser, offer: "auto-inbrowser", reason };
}
