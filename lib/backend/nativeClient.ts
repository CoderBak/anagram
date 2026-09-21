// Extension-page client: lifecycle operations always pass through the trusted SW gate.
import { browser } from "#imports";
import * as v from "valibot";
import { RuntimeSchema, parseRuntime } from "./runtimeProtocol";
import { NATIVE_MESSAGE, NATIVE_UNINSTALL, parseNativeReply, type NativeReply, type ComponentOperation, type NativePayload } from "./nativeProtocol";
const Text = v.pipe(v.string(), v.maxLength(2000));
const Count = v.pipe(v.number(), v.finite(), v.minValue(0));
const DownloadPlan = v.object({
  profile: v.picklist(["recommended", "expanded"]),
  devices: v.pipe(v.array(Text), v.maxLength(64)),
  files: v.pipe(v.array(Text), v.maxLength(128)),
  total_bytes: Count,
  expanded_bytes: v.optional(Count),
});
export const ComponentSchema = v.object({
  schema_version: v.literal(1), version: v.nullable(Text), home: Text,
  state: v.picklist(["starting", "needs_models", "downloading", "paused", "loading", "benchmarking", "awaiting_selection", "ready", "idle", "stopped", "updating", "uninstalling", "error"]),
  settings: v.optional(v.object({idle_unload_s: v.pipe(Count, v.integer(), v.maxValue(86400))})),
  download: v.object({status: v.picklist(["idle", "running", "paused", "completed", "failed"]), bytes_received: Count, total_bytes: Count, file: v.nullable(Text), error: v.nullable(Text),
    phase: v.optional(v.picklist(["detecting", "verifying", "downloading", "complete"])),
    plan: v.optional(DownloadPlan),
  }),
  runtime: v.nullable(RuntimeSchema), storage: v.object({models_bytes: Count}),
  error: v.nullable(v.object({code: Text, message: Text})),
  operation: v.nullable(v.object({name: v.picklist(["update", "uninstall", "delete_models"]), status: v.picklist(["running", "completed", "failed", "scheduled"]), receipt: v.nullable(Text)})),
});
export type ComponentSnapshot = v.InferOutput<typeof ComponentSchema>;
export type ComponentReply = {kind: "ok"; snapshot: ComponentSnapshot} | {kind: "unavailable" | "invalid" | "rejected"; message?: string; code?: string};
export type {ComponentOperation} from "./nativeProtocol";

export function parseComponent(value: unknown): ComponentSnapshot | null {
  const parsed = v.safeParse(ComponentSchema, value);
  if (!parsed.success) return null;
  if (parsed.output.runtime && !parseRuntime(parsed.output.runtime)) return null;
  if (parsed.output.download.bytes_received > parsed.output.download.total_bytes) return null;
  return parsed.output;
}

export async function nativePageRequest(op: ComponentOperation, payload: NativePayload = {}, signal?: AbortSignal): Promise<NativeReply> {
  if (signal?.aborted) throw new Error("cancelled");
  return new Promise((resolve, reject) => {
    const abort = () => finish(undefined, new Error("cancelled"));
    const timer = setTimeout(() => finish(undefined, new Error("Local component request timed out")), 35_000);
    let done = false;
    function finish(value?: unknown, error?: Error) {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      if (error) { reject(error); return; }
      const reply = parseNativeReply(value);
      if (reply) resolve(reply); else reject(new Error("Invalid local component response"));
    }
    signal?.addEventListener("abort", abort, {once:true});
    browser.runtime.sendMessage({action:NATIVE_MESSAGE, op, payload}).then((value) => finish(value), () => finish(undefined, new Error("Local component unavailable")));
  });
}

export async function requestComponent(op: ComponentOperation = "status", payload: NativePayload = {}, signal?: AbortSignal): Promise<ComponentReply> {
  try {
    const reply = await nativePageRequest(op, payload, signal);
    if (!reply.ok) return {kind: reply.status >= 500 ? "unavailable" : "rejected", code: reply.error?.code, message: reply.error?.message};
    const snapshot = parseComponent(reply.data);
    return snapshot ? {kind:"ok", snapshot} : {kind:"invalid"};
  } catch { return {kind:"unavailable", code:"native_unavailable"}; }
}

export async function finishNativeUninstall(receipt: string): Promise<{ok: boolean; error?: string}> {
  try { return await browser.runtime.sendMessage({action:NATIVE_UNINSTALL, receipt}); }
  catch { return {ok:false, error:"Extension removal could not be confirmed"}; }
}
