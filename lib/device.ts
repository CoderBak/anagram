// lib/device.ts — which engine this device is offered, from what the browser tells a page.
//
// One extension carries both engines. The setup page decides, before anything downloads:
//
//   Apple Silicon Mac                    choice: native MLX scores a paragraph in 43 ms at
//                                        ~1.8 GB, the browser in 92 ms at up to 2.5 GB
//   Linux with an NVIDIA GPU             choice: native PyTorch CUDA
//   Intel Mac                            in the browser, automatically: install.sh has no
//                                        Intel macOS runtime
//   anything else                        in the browser, automatically: native ONNX on the
//                                        processor measured slower than the browser's WASM.
//                                        Windows with an NVIDIA GPU too: PyPI has no CUDA
//                                        build of Torch for Windows, so the local engine would
//                                        run on the processor there, and the browser's engine
//                                        runs on the graphics card (the user's decision of
//                                        2026-10-05: offer nothing that was never run)
//
// and the in-browser engine only where the device can afford it (affordable() below). The
// function is pure; lib/ui/deviceInputs.ts reads its inputs in a page.

/** What a page can learn about the device without asking the person. */
export interface DeviceInputs {
  /** Which browser this build is for. */
  browser: "chrome" | "firefox" | "safari";
  /** Safari is capability-gated before downloading the model. */
  webRuntime?: boolean;
  /** A packaged Safari app has an XPC bridge; a temporary extension does not. */
  nativeBridge?: boolean;
  /** `navigator.userAgentData.getHighEntropyValues(["platform", "architecture"])`: "macOS",
   *  "Windows", "Linux", "Chrome OS"…, and "arm" or "x86". Chrome only. */
  platform?: string;
  architecture?: string;
  /** `navigator.platform`, where there is nothing better: Firefox says "MacIntel" on every Mac. */
  navigatorPlatform?: string;
  /** The WebGPU adapter's `info`, when the browser offers one that is not a fallback (software)
   *  adapter. `fits` is false when it cannot bind FP32's largest tensor and `fitsFp16` when it
   *  cannot bind FP16's (each tier's `maxTensorBytes`; an unknown FP16 follows `fits`); `f16`
   *  says the adapter exposes `shader-f16`, which the FP16 model cannot run without. */
  gpu?: { vendor?: string; architecture?: string; description?: string; fits?: boolean; fitsFp16?: boolean; f16?: boolean } | null;
  /** WebGL's UNMASKED_VENDOR_WEBGL / UNMASKED_RENDERER_WEBGL, where WebGPU says nothing. */
  webgl?: { vendor?: string; renderer?: string } | null;
  /** `navigator.deviceMemory` in GB (Chrome only; rounded down to a power of two). */
  deviceMemory?: number;
  /** `navigator.storage.estimate()`. */
  storage?: { quota?: number; usage?: number };
  /** Bytes of the in-browser model already in the browser's storage. */
  stored?: number;
}

export type Offer = "choice" | "auto-inbrowser" | "terminal-only" | "cannot-run";
export type Machine = "apple-silicon" | "intel-mac" | "nvidia" | "other";
export type Reason =
  /** choice */
  | "apple-silicon" | "nvidia"
  /** auto-inbrowser: no GPU the local engine can use here (none, not NVIDIA, or NVIDIA on
   *  Windows, where it has no CUDA), an Intel Mac, a system with no installer */
  | "intel-mac" | "no-local-gpu" | "no-installer"
  /** the in-browser engine does not fit; terminal-only where the local engine installs */
  | "memory" | "disk" | "browser" | "webgpu";

export interface Decision {
  offer: Offer;
  reason: Reason;
  os: Os;
  machine: Machine;
  /** The path the in-browser engine is expected to take here, or null where it cannot run. */
  path: "webgpu" | "cpu" | null;
  /** The tier picked runs on exactly its least memory (FP32 on 4 GB): the computer may slow
   *  down while it scores. */
  tight: boolean;
  /** Whether the local engine's installer supports this device (false only where it is
   *  known not to: an Intel Mac, Windows on ARM, a system it has no installer for). */
  native: boolean;
  /** The model tier the in-browser engine would run (TIERS). */
  tier: Tier["id"] | null;
  /** Where FP16 is picked and FP32 would fit by itself (memory and disk): what a FP16 model
   *  that fails to run here falls back to, on the processor; `tight` says whether that is 4 GB. */
  fallback: { tight: boolean } | null;
}

/**
 * The in-browser model tiers, largest first, with what each takes: its download, the least
 * memory (Chrome's deviceMemory, a power of two) it runs in, and its largest single tensor (the
 * word embeddings, which the GPU binds as one buffer: 50 265 x 1024 values). FP32 peaks at
 * 2.8 GB while scoring on the graphics card and 1.9 GB on the processor (an M4), so it needs
 * 4 GB, and on exactly 4 GB the computer may slow down while it scores. FP16 peaks at 1.6 GB.
 *
 * FP32 is the automatic pick. The user decided (2026-09-29) that the modelkit's FP16 model
 * runs where FP32 does not fit, and only on WebGPU (on the processor ONNX Runtime upcasts it
 * and gains nothing): see affordable(). Its verdict word matches FP32's on 99.82% of the
 * EditLens test split. INT8 is never picked, and nothing here quantizes anything.
 */
export const TIERS = [
  { id: "fp32", bytes: 1_425_459_555, minMemoryGb: 4, maxTensorBytes: 50265 * 1024 * 4 },
  { id: "fp16", bytes: 714_899_390, minMemoryGb: 4, maxTensorBytes: 50265 * 1024 * 2 },
] as const;
export type Tier = typeof TIERS[number];

/** Room on disk beyond the model's own bytes: the engine's state, and slack for the browser. */
export const DISK_MARGIN = 200e6;

export type Os = "mac" | "windows" | "linux" | "other";

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

/** Where the local engine runs on an NVIDIA GPU: Linux, where install.sh adds Torch's CUDA build. */
function cuda(os: Os, machine: Machine): boolean {
  return os === "linux" && machine === "nvidia";
}

/** Where the local engine installs: Apple Silicon macOS, x64 Windows, glibc Linux (x86_64 or
 *  arm64). A Mac whose kind nobody could tell is given the benefit of the doubt: the
 *  installer itself says so on an Intel one. */
function nativeInstalls(os: Os, machine: Machine, i: DeviceInputs): boolean {
  if (i.browser === "safari" && (os !== "mac" || i.nativeBridge !== true)) return false;
  if (os === "mac") return machine !== "intel-mac";
  if (os === "windows") return i.architecture !== "arm";
  return os === "linux";
}

/**
 * The tier this device runs: FP32, unless FP32 does not fit and FP16 does; null with what fell
 * short when neither. Unknown memory (Firefox has no deviceMemory) and an unknown estimate run.
 *
 * FP32 does not fit when any of these holds: Chrome's deviceMemory is exactly 4 (FP32's
 * least, where it runs with a slow-down note); the free disk cannot take FP32 (its bytes not
 * yet stored plus DISK_MARGIN) but can take FP16 (likewise); the adapter's limits hold FP16's
 * largest tensor but not FP32's. FP16 is then picked when it can run: a real WebGPU adapter
 * exposing `shader-f16` whose limits hold its largest tensor, the memory (4 GB at least) and
 * the disk. Less than 4 GB of memory stays short: FP16's 1.6 GB peak is too much there too.
 * A complete FP32 model already in storage is kept. Where FP16 is wanted and cannot run, FP32
 * is as it always was: with the note on 4 GB, short on a full disk.
 */
export function affordable(i: DeviceInputs): { tier: Tier | null; short: "memory" | "disk" | null; tight: boolean; fallback: { tight: boolean } | null } {
  const [fp32, fp16] = TIERS;
  const memoryFits = (tier: Tier): boolean => i.deviceMemory === undefined || i.deviceMemory >= tier.minMemoryGb;
  const diskFits = (tier: Tier): boolean => {
    const { quota, usage } = i.storage ?? {};
    const needed = Math.max(0, tier.bytes - (i.stored ?? 0)) + DISK_MARGIN;
    return quota === undefined || usage === undefined || quota - usage >= needed;
  };
  const gpu = i.gpu;
  const holds32 = !gpu || gpu.fits !== false;
  const holds16 = !!gpu && (gpu.fitsFp16 ?? gpu.fits) !== false;
  const roomy = memoryFits(fp32) && diskFits(fp32) && i.deviceMemory !== fp32.minMemoryGb && holds32;
  const storedFp32 = (i.stored ?? 0) >= fp32.bytes;
  if (!roomy && !storedFp32 && gpu?.f16 === true && holds16 && memoryFits(fp16) && diskFits(fp16)) {
    const fits32 = memoryFits(fp32) && diskFits(fp32);
    return { tier: fp16, short: null, tight: false, fallback: fits32 ? { tight: i.deviceMemory === fp32.minMemoryGb } : null };
  }
  if (!memoryFits(fp32)) return { tier: null, short: "memory", tight: false, fallback: null };
  if (!diskFits(fp32)) return { tier: null, short: "disk", tight: false, fallback: null };
  return { tier: fp32, short: null, tight: i.deviceMemory === fp32.minMemoryGb, fallback: null };
}

/** Which engines this device is offered, and why. */
export function decide(i: DeviceInputs): Decision {
  const os = osOf(i);
  const machine = machineOf(i, os);
  const native = nativeInstalls(os, machine, i);
  const base = { os, machine, native, tight: false, tier: null, path: null, fallback: null };
  if (i.webRuntime === false || (i.browser === "safari" && os !== "mac")) return { ...base, offer: native ? "terminal-only" : "cannot-run", reason: "browser" };
  if (i.browser === "safari" && !i.gpu) return { ...base, offer: native ? "terminal-only" : "cannot-run", reason: "webgpu" };
  const fits = affordable(i);
  if (!fits.tier) {
    // Nothing is downloaded where the model does not fit, and nothing is ever scored
    // anywhere else; where the local engine installs, it is what is left.
    const choiceDevice = native && (machine === "apple-silicon" || cuda(os, machine));
    return { ...base, offer: choiceDevice ? "terminal-only" : "cannot-run", reason: fits.short ?? "memory" };
  }
  if (i.browser === "safari" && (fits.tier.id === "fp32" ? i.gpu?.fits !== true : i.gpu?.fitsFp16 !== true || i.gpu?.f16 !== true)) {
    return { ...base, offer: native ? "terminal-only" : "cannot-run", reason: "webgpu" };
  }
  // FP16 runs on the graphics card only; FP32 there when the adapter can bind it, else on the processor.
  const path: "webgpu" | "cpu" = fits.tier.id === "fp16" || (i.gpu && i.gpu.fits !== false) ? "webgpu" : "cpu";
  const inBrowser = { ...base, path, tight: fits.tight, tier: fits.tier.id, fallback: i.browser === "safari" ? null : fits.fallback };
  if (native && machine === "apple-silicon") return { ...inBrowser, offer: "choice", reason: "apple-silicon" };
  if (native && cuda(os, machine)) return { ...inBrowser, offer: "choice", reason: "nvidia" };
  const reason = machine === "intel-mac" ? "intel-mac" : os === "windows" || os === "linux" ? "no-local-gpu" : "no-installer";
  return { ...inBrowser, offer: "auto-inbrowser", reason };
}
