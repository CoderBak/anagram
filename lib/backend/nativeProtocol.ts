// Shared wire contract. No code in this file opens a native connection.
export const NATIVE_HOST = "dev.coderbak.anagram";
export const NATIVE_MESSAGE = "anagram.nativeRequest";
export const NATIVE_UNINSTALL = "anagram.finishUninstall";
export const MAX_NATIVE_BYTES = 1_000_000;

export const PAGE_OPERATIONS = [
  "status", "runtime", "runtime.benchmark", "runtime.config", "runtime.cancel",
  "models.download", "models.pause", "models.delete", "engine.stop", "engine.resume", "engine.settings",
  "component.update", "component.uninstall",
] as const;
export type ComponentOperation = typeof PAGE_OPERATIONS[number];
export type NativeOperation = ComponentOperation | "health" | "score";
export type NativePayload = Record<string, unknown>;
export interface NativeReply {
  v: 1;
  id: string;
  ok: boolean;
  status: number;
  data?: unknown;
  error?: { code: string; message: string };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseNativeReply(value: unknown): NativeReply | null {
  if (!isRecord(value) || value.v !== 1 || typeof value.id !== "string" || value.id.length > 120 ||
      typeof value.ok !== "boolean" || !Number.isInteger(value.status) ||
      (value.status as number) < 200 || (value.status as number) > 599) return null;
  if (value.ok && ((value.status as number) >= 400 || !Object.hasOwn(value, "data"))) return null;
  if (!value.ok && (!isRecord(value.error) || typeof value.error.code !== "string" ||
      value.error.code.length > 100 || typeof value.error.message !== "string" || value.error.message.length > 2000)) return null;
  return value as unknown as NativeReply;
}

/** Only our top-level setup/settings pages may control local files or processes. */
export function trustedNativePage(sender: {id?: string; url?: string; frameId?: number}, extensionId: string, base: string): boolean {
  if (sender.id !== extensionId || !sender.url || (sender.frameId !== undefined && sender.frameId !== 0)) return false;
  try {
    const actual = new URL(sender.url);
    const own = new URL(base);
    return actual.protocol === own.protocol && actual.host === own.host &&
      (actual.pathname === "/onboarding.html" || actual.pathname === "/options.html");
  } catch { return false; }
}

/** A release version as `npm run bump` writes it; an update installs that release. */
const RELEASE_VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/** Fixed commands only. No executable names, filesystem paths or download URLs. */
export function validPageRequest(op: unknown, payload: unknown): op is ComponentOperation {
  if (typeof op !== "string" || !PAGE_OPERATIONS.includes(op as ComponentOperation) || !isRecord(payload)) return false;
  const keys = Object.keys(payload);
  if (op === "models.delete" || op === "component.uninstall") return keys.length === 1 && payload.confirm === true;
  if (op === "component.update") return keys.length === 0 ||
    (keys.length === 1 && typeof payload.version === "string" && RELEASE_VERSION.test(payload.version));
  if (op === "runtime.config") return keys.length === 1 && typeof payload.id === "string" && payload.id.length > 0 && payload.id.length <= 120;
  if (op === "runtime.benchmark") return keys.length === 1 && Number.isInteger(payload.budget_s) && (payload.budget_s as number) >= 10 && (payload.budget_s as number) <= 30;
  if (op === "engine.settings") return keys.length === 1 && Number.isInteger(payload.idle_unload_s) &&
    (payload.idle_unload_s === 0 || (Number(payload.idle_unload_s) >= 60 && Number(payload.idle_unload_s) <= 86400));
  return keys.length === 0;
}
