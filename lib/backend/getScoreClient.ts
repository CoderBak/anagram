// All inference requests share the background worker's Native Messaging client.
import { NativeScoreClient } from "./nativeScoreClient";
import { nativeTransport } from "./nativeTransport";

let client: NativeScoreClient | undefined;

export function getScoreClient(): NativeScoreClient {
  if (!client) {
    const created = new NativeScoreClient();
    // Health is valid only while its native connection survives, even when idle.
    nativeTransport().onDisconnect(() => created.invalidate());
    client = created;
  }
  return client;
}
