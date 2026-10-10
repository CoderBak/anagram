// test/node/contract.test.ts — both engines answer by one contract (anagramd/contract.json):
// the local engine reads it in Python, the in-browser one and the worker in TypeScript, and the
// message-size limits the two transports share are written in both.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BUCKET_LABELS, CALIBRATION, CONTRACT_LIMITS, CONTRACT_VERSION, SUPPORTED_LANGUAGES } from "../../lib/contract";
import { MAX_BLOCKS, MAX_ID_CHARS, MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, MAX_TEXT_CHARS, MAX_TOKEN_CHARS, MAX_TOKEN_TEXTS } from "../../lib/webengine/protocol";

const ROOT = join(import.meta.dirname, "..", "..");
const contract = JSON.parse(readFileSync(join(ROOT, "anagramd", "contract.json"), "utf8"));
const python = (file: string, name: string): number => {
  const m = new RegExp(`^${name} = (.+)$`, "m").exec(readFileSync(join(ROOT, "anagramd", file), "utf8"));
  if (!m) throw new Error(`${name} not in ${file}`);
  return Function(`return ${m[1]}`)() as number;
};

describe("the engine contract", () => {
  it("is the one file's, in TypeScript", () => {
    expect(CONTRACT_VERSION).toBe(contract.version);
    expect(CALIBRATION).toBe(contract.calibration);
    expect(BUCKET_LABELS).toEqual(contract.buckets);
    expect(SUPPORTED_LANGUAGES).toEqual(contract.languages);
    expect(CONTRACT_LIMITS).toEqual(contract.limits);
  });

  it("limits a request alike in the in-browser engine", () => {
    expect({ blocks: MAX_BLOCKS, text_chars: MAX_TEXT_CHARS, token_texts: MAX_TOKEN_TEXTS, token_chars: MAX_TOKEN_CHARS, id_chars: MAX_ID_CHARS })
      .toEqual(contract.limits);
  });

  it("is read from that file by the local engine, which limits a message as the in-browser one does", () => {
    expect(readFileSync(join(ROOT, "anagramd", "engine.py"), "utf8")).toContain('CONTRACT = json.loads((Path(__file__).resolve().parent / "contract.json")');
    expect(python("native_host.py", "MAX_REQUEST_BYTES")).toBe(MAX_REQUEST_BYTES);
    expect(python("native_host.py", "MAX_RESPONSE_BYTES")).toBe(MAX_RESPONSE_BYTES);
  });
});
