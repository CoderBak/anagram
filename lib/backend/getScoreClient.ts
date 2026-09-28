// All inference requests share the background worker's engine client.
import { NativeScoreClient } from "./nativeScoreClient";
import { engineTransport } from "./engines";

let client: NativeScoreClient | undefined;

export function getScoreClient(): NativeScoreClient {
  if (!client) {
    const created = new NativeScoreClient();
    // Health is valid only while its engine connection survives, even when idle.
    engineTransport().onDisconnect(() => created.disconnected());
    client = created;
  }
  return client;
}
