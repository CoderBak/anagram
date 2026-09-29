// lib/ui/deviceInputs.ts — what lib/device.ts decides from, read in an extension page.
//
// Nothing here asks the person anything or leaves the machine: the browser's own answers
// about its platform, its graphics adapter and its storage. A page reads them (the setup
// page, Settings, the popup); the background has no WebGL to ask.
import { browser } from "#imports";
import type { PublicPath } from "wxt/browser";
import { TIERS, type DeviceInputs } from "../device";
import { hasJspi } from "../webengine/session";
import { storedModelBytes } from "../webengine/autoSetup";

interface GpuAdapterLike {
  limits: { maxStorageBufferBindingSize: number; maxBufferSize: number };
  features?: { has(name: string): boolean };
  info?: { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean };
  isFallbackAdapter?: boolean;
}
interface NavigatorExtras {
  gpu?: { requestAdapter(options?: unknown): Promise<GpuAdapterLike | null> };
  userAgentData?: { getHighEntropyValues(hints: string[]): Promise<{ platform?: string; architecture?: string }> };
  deviceMemory?: number;
}

/** A promise's answer, or undefined when it fails or takes longer than `ms`. */
function within<T>(promise: Promise<T> | undefined, ms: number): Promise<T | undefined> {
  if (!promise) return Promise.resolve(undefined);
  return Promise.race([promise.catch(() => undefined), new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);
}

/** The hardware WebGPU adapter's names, null when there is none (or only a software one). */
async function adapter(nav: NavigatorExtras): Promise<DeviceInputs["gpu"]> {
  const found = await within(nav.gpu?.requestAdapter({ powerPreference: "high-performance" }), 3000);
  if (!found || (found.info?.isFallbackAdapter ?? found.isFallbackAdapter) === true) return null;
  const { vendor, architecture, description } = found.info ?? {};
  const holds = (bytes: number): boolean => found.limits.maxStorageBufferBindingSize >= bytes && found.limits.maxBufferSize >= bytes;
  return { vendor, architecture, description, fits: holds(TIERS[0].maxTensorBytes), fitsFp16: holds(TIERS[1].maxTensorBytes), f16: found.features?.has("shader-f16") === true };
}

/** WebGL's names for the GPU (Firefox gives a generalized one, "Apple M1, or similar"). */
function webgl(): DeviceInputs["webgl"] {
  try {
    const gl = document.createElement("canvas").getContext("webgl");
    if (!gl) return null;
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    const names = {
      vendor: String(gl.getParameter(debug ? debug.UNMASKED_VENDOR_WEBGL : gl.VENDOR) ?? ""),
      renderer: String(gl.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? ""),
    };
    gl.getExtension("WEBGL_lose_context")?.loseContext();
    return names;
  } catch { return null; }
}

/** The test build's stand-in for a device (output-test/…/test-device.json), merged over what
 *  this machine says. The shipping build carries none of this. */
async function testDevice(): Promise<Partial<DeviceInputs>> {
  try {
    const reply = await fetch(browser.runtime.getURL("/test-device.json" as PublicPath));
    return reply.ok ? await reply.json() as Partial<DeviceInputs> : {};
  } catch { return {}; }
}

export async function readDeviceInputs(): Promise<DeviceInputs> {
  const nav = navigator as Navigator & NavigatorExtras;
  const [ua, gpu, storage, stored] = await Promise.all([
    within(nav.userAgentData?.getHighEntropyValues(["platform", "architecture"]), 2000),
    adapter(nav),
    within(navigator.storage?.estimate(), 2000),
    storedModelBytes(),
  ]);
  const inputs: DeviceInputs = {
    browser: import.meta.env.BROWSER === "firefox" ? "firefox" : "chrome",
    platform: ua?.platform, architecture: ua?.architecture, navigatorPlatform: navigator.platform,
    gpu, webgl: webgl(), storage: storage ? { quota: storage.quota, usage: storage.usage } : undefined, stored,
    jspi: hasJspi(),
  };
  if (typeof nav.deviceMemory === "number") inputs.deviceMemory = nav.deviceMemory;
  if (import.meta.env.ANAGRAM_TEST_BUILD === "1") Object.assign(inputs, await testDevice());
  return inputs;
}
