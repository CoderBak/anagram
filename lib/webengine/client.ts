// STUB, replaced by the in-browser engine. The oneclick flavor's engine transport
// (lib/backend/transport.ts): it will run the pinned EditLens model in an offscreen
// document (entrypoints/engine/) with ONNX Runtime Web. Until that lands, this lets the
// oneclick flavor build and run: every operation is refused with `engine_not_ready`, so
// scoring stays unavailable and the setup page says the engine is not ready.
import { NativeTransportError, type EngineTransport } from "../backend/transport";

class EngineNotReady implements EngineTransport {
  request(): Promise<never> {
    return Promise.reject(new NativeTransportError("engine_not_ready", "The in-browser engine is not part of this build yet"));
  }
  onDisconnect(): () => void { return () => undefined; }
  close(): void { /* nothing is open */ }
}

let instance: EngineTransport | undefined;
/** What "#flavor/engine-transport" names in the oneclick flavor. */
export function engineTransport(): EngineTransport { return instance ??= new EngineNotReady(); }
