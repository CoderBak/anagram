// Extension pages send runtime controls through the privileged native bridge.
import { nativePageRequest } from "./nativeClient";
import { parseRuntime, type RuntimeReply, type RuntimeAction } from "./runtimeProtocol";
export * from "./runtimeProtocol";

export async function requestRuntime(action?: RuntimeAction, id?: string, signal?: AbortSignal): Promise<RuntimeReply> {
  if (action === "config" && (!id || id.length > 120)) return {kind: "invalid"};
  try {
    const reply = await nativePageRequest(action ? `runtime.${action}` : "runtime",
      action === "benchmark" ? {budget_s: 30} : action === "config" ? {id} : {}, signal);
    if (!reply.ok) return {kind: reply.status === 409 || reply.status === 422 ? "rejected" : "unavailable", message: reply.error?.message};
    const snapshot = parseRuntime(reply.data);
    return snapshot ? {kind:"ok", snapshot} : {kind:"invalid"};
  } catch { return {kind:"unavailable"}; }
}
