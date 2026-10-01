// One native port per background worker; all tabs share it. Never import this in a page.
// The local engine's transport (lib/backend/transport.ts): the port multiplexing and crash
// recovery of lib/backend/portTransport.ts over a Native Messaging port to the local host.
// Without Native Messaging granted there is no connectNative, and connecting fails as a
// host that is not installed does.
import { browser } from "#imports";
import { safariPort } from "./safariPort";
import { NATIVE_HOST } from "./nativeProtocol";
import { PortTransport, type NativePort } from "./portTransport";

export { CRASH_LIMIT, CRASH_WINDOW_MS, RESTART_BACKOFF_MS, type NativePort } from "./portTransport";

export class NativeTransport extends PortTransport {
  constructor(connect: () => NativePort = () => import.meta.env.BROWSER === "safari" ? safariPort() : browser.runtime.connectNative(NATIVE_HOST)) {
    super(connect, { cannotStart: "Local component is not installed or cannot start" });
  }
  protected override lastError(): string | undefined { return browser.runtime.lastError?.message; }
}

let instance: NativeTransport | undefined;
export function nativeTransport(): NativeTransport { return instance ??= new NativeTransport(); }
