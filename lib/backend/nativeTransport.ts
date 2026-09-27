// One native port per background worker; all tabs share it. Never import this in a page.
// The native flavor's engine transport (lib/backend/transport.ts): the port multiplexing
// of lib/backend/portTransport.ts over a Native Messaging port to the local host.
import { browser } from "#imports";
import { NATIVE_HOST } from "./nativeProtocol";
import { PortTransport, type NativePort } from "./portTransport";

export type { NativePort } from "./portTransport";

export class NativeTransport extends PortTransport {
  constructor(connect: () => NativePort = () => browser.runtime.connectNative(NATIVE_HOST)) {
    super(connect, { cannotStart: "Local component is not installed or cannot start" });
  }
  protected override lastError(): string | undefined { return browser.runtime.lastError?.message; }
}

let instance: NativeTransport | undefined;
export function nativeTransport(): NativeTransport { return instance ??= new NativeTransport(); }
/** What "#flavor/engine-transport" names in the native flavor. */
export { nativeTransport as engineTransport };
