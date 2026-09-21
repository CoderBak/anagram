// Runtime setup is an extension-page feature. Hardware discovery and measurement stay
// in the local daemon; loading this client never starts a benchmark or changes a model.
import { effectiveServerUrl, isLoopbackUrl } from "../settings/settings";

import { settings } from "../settings/settings";
import { nativePageRequest } from "./nativeClient";
import { parseRuntime, type RuntimeReply, type RuntimeAction } from "./runtimeProtocol";
export * from "./runtimeProtocol";

export async function requestRuntime(storedUrl: string, action?: RuntimeAction, id?: string, signal?: AbortSignal): Promise<RuntimeReply> {
  if (await settings.backendTransport.getValue() === "http") return requestHttpRuntime(storedUrl, action, id, signal);
  if (action === "config" && (!id || id.length > 120)) return {kind: "invalid"};
  try {
    const reply = await nativePageRequest(action ? `runtime.${action}` : "runtime",
      action === "benchmark" ? {budget_s: 30} : action === "config" ? {id} : {}, signal);
    if (!reply.ok) return {kind: reply.status === 409 || reply.status === 422 ? "rejected" : "unavailable", message: reply.error?.message};
    const snapshot = parseRuntime(reply.data);
    return snapshot ? {kind:"ok", snapshot} : {kind:"invalid"};
  } catch { return {kind:"unavailable"}; }
}

/** Only the existing loopback origin; redirects may never turn this into a remote fetch. */
export async function requestHttpRuntime(
  storedUrl: string,
  action?: RuntimeAction,
  id?: string,
  signal?: AbortSignal,
): Promise<RuntimeReply> {
  const url = effectiveServerUrl(storedUrl);
  if (!isLoopbackUrl(url)) return { kind: "invalid" };
  if (action === "config" && (!id || id.length > 120)) return { kind: "invalid" };
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, 4_000);
  try {
    const res = await fetch(`${url.replace(/\/$/, "")}/runtime${action ? `/${action}` : ""}`, {
      method: action ? "POST" : "GET",
      ...(action ? {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "benchmark" ? { budget_s: 30 } : action === "config" ? { id } : {}),
      } : {}),
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      signal: controller.signal,
    });
    if (res.status === 404 || res.status === 405) return { kind: "unsupported" };
    if (res.status === 409 || res.status === 422) {
      const body = await res.json().catch(() => null) as { detail?: unknown } | null;
      return { kind: "rejected", message: typeof body?.detail === "string" ? body.detail.slice(0, 2000) : undefined };
    }
    if (!res.ok) return { kind: "unavailable" };
    const snapshot = parseRuntime(await res.json());
    return snapshot ? { kind: "ok", snapshot } : { kind: "invalid" };
  } catch {
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
