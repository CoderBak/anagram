// lib/stats/settings.ts — the statistics' configuration and secret, in the extension's storage:
// what the worker, Settings and the statistics page read and write.
import { settings } from "../settings/settings";
import { configOf, normalize, OFF, type RecordingConfig } from "./config";

export async function readStatsConfig(): Promise<RecordingConfig> {
  try {
    return configOf(await settings.statsConfig.getValue());
  } catch {
    return OFF; // a dead extension context records nothing
  }
}

export async function saveStatsConfig(config: RecordingConfig): Promise<RecordingConfig> {
  const normal = config.on ? normalize(config).config : { ...OFF, retention: config.retention };
  await settings.statsConfig.setValue(normal);
  return normal;
}

const toBase64 = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

/** The key the log's hashes are made with: 32 random bytes, made the first time it is asked
 *  for. */
export async function statsSecret(): Promise<Uint8Array> {
  const kept = await settings.statsSecret.getValue();
  if (kept) {
    try {
      const bytes = fromBase64(kept);
      if (bytes.length === 32) return bytes;
    } catch { /* made anew below */ }
  }
  const fresh = crypto.getRandomValues(new Uint8Array(32));
  await settings.statsSecret.setValue(toBase64(fresh));
  return fresh;
}

/** Forget the key: what is recorded from now on cannot be matched with what was before
 *  (Clear statistics). */
export async function forgetStatsSecret(): Promise<void> {
  await settings.statsSecret.setValue(null);
}
