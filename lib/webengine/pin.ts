// lib/webengine/pin.ts — the files the in-browser engine runs on: the native installer's pin.
//
// anagramd/modelkit.json names the Hugging Face redistribution of EditLens by repository
// and commit, with the size and SHA-256 of every file; anagramd/download_modelkit.py
// fetches each as https://huggingface.co/<repository>/resolve/<revision>/<path>. The browser
// engine downloads two of them, the FP32 ONNX graph and the tokenizer, from there; nothing
// else is ever fetched. The third file it needs, fastText's lid.176.ftz, ships inside the
// package (scripts/webengine.mjs puts it there, checked against the same size and hash) and
// is read from it, and checked again, whenever the model loads.
import modelkit from "../../anagramd/modelkit.json";

export interface PinnedFile {
  /** The file's name in the engine's storage. */
  name: string;
  size_bytes: number;
  sha256: string;
  url: string;
}

export interface Pin {
  /** The files setup downloads. */
  files: PinnedFile[];
  /** lid.176.ftz in the package: `url` is its extension URL. */
  lid: PinnedFile;
  /** What the modelkit is: named in health and every score, folded into cache keys. */
  model: { id: string; calibration: string };
  license: string;
}

const MODEL_FILES: Record<string, string> = { "onnx/model.onnx": "model.onnx", "tokenizer.json": "tokenizer.json" };
/** download_modelkit.LID_ENTRY, where the package carries it (scripts/webengine.mjs LID). */
export const LID = { name: "lid.176.ftz", size_bytes: 938013, sha256: "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83" };
export const LID_PATH = "/vendor/engine/lid.176.ftz";

/** The files setup downloads, with their addresses. */
export function pinnedFiles(): PinnedFile[] {
  const files: PinnedFile[] = [];
  for (const entry of modelkit.files) {
    const name = MODEL_FILES[entry.path];
    if (!name) continue;
    // download_modelkit.py: quote(name, safe="/") on the path.
    const path = entry.path.split("/").map(encodeURIComponent).join("/");
    files.push({ name, size_bytes: entry.size_bytes, sha256: entry.sha256, url: `https://huggingface.co/${modelkit.repository}/resolve/${modelkit.revision}/${path}` });
  }
  if (files.length !== Object.keys(MODEL_FILES).length) throw new Error("anagramd/modelkit.json no longer lists a file the browser engine needs");
  return files;
}

/** engine.py's MODEL_ID and CALIBRATION. */
export const MODEL_ID = "editlens_roberta-large";
export const CALIBRATION = "editlens-4bucket-cosine(0.03,0.15)";
export const BUCKET_LABELS = ["human", "lightly-edited", "heavily-edited", "ai-generated"];
export const SUPPORTED_LANGUAGES = ["en"];

/** The pin, with lid.176.ftz at `lidUrl`: LID_PATH as the extension serves it. */
export function pin(lidUrl: string): Pin {
  return { files: pinnedFiles(), lid: { ...LID, url: lidUrl }, model: { id: MODEL_ID, calibration: CALIBRATION }, license: modelkit.license };
}
