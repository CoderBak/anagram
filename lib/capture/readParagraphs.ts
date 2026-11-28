import { sendDocumentMessage } from "../access/session";
import { ACTIONS, type BackendStatus } from "../messaging/protocol";
import { fitsWithoutCounting, readDetectorPassages, readInWindows, type Readable, type ScoreBlocks, type CountTokens } from "./windows";

async function activeCalibration(): Promise<string | undefined> {
  const status = await sendDocumentMessage({ action: ACTIONS.GET_BACKEND_STATUS }) as BackendStatus | undefined;
  return status?.model?.calibration;
}

/** The health read is cached in the background and never wakes an idle model. An engine
 * whose identity was lost on restart can identify itself with its first real result. */
export async function readParagraphs(items: Readable[], score: ScoreBlocks, count: CountTokens,
  calibration: () => Promise<string | undefined> = activeCalibration) {
  if (items.every(item => !item.text.includes("\n\n") && fitsWithoutCounting(item.text))) return readInWindows(items, score, count);
  const format = await calibration().catch(() => undefined);
  const detector = !format || format === "none" || format === "anagram-detector/1";
  const read = () => readDetectorPassages(items, score);
  const legacy = () => readInWindows(items, score, count);
  const result = await (detector ? read() : legacy());
  // The user may switch models between the health read and the first score.
  for (const parts of result.values()) {
    if (parts.some(({ result: r }) => !r.degraded && !r.unsupported && (r.probs.length === 3) !== detector))
      return detector ? legacy() : read();
  }
  return result;
}
