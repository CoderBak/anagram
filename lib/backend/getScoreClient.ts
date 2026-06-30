// lib/backend/getScoreClient.ts — factory for the active ScoreClient.
import type { ScoreClient } from "../contract";
import { RandomStubScoreClient } from "./randomStub";

/**
 * Returns the active ScoreClient. M1 → RandomStubScoreClient. Swapping in a real
 * NativeScoreClient (connectNative → pangramd) later changes only this one file.
 */
export function getScoreClient(): ScoreClient {
  return new RandomStubScoreClient();
}
