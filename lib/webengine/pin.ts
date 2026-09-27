// lib/webengine/pin.ts — the model files the in-browser engine downloads: the native
// installer's pin, at the native installer's addresses.
//
// anagramd/modelkit.json names the Hugging Face redistribution of EditLens by repository
// and commit, with the size and SHA-256 of every file; anagramd/download_modelkit.py
// fetches each as https://huggingface.co/<repository>/resolve/<revision>/<path> and the
// language model from fastText's own host. The browser engine needs three of them: the
// FP32 ONNX graph, the tokenizer and lid.176.ftz. Nothing else is ever fetched.
import modelkit from "../../anagramd/modelkit.json";

export interface PinnedFile {
  /** The file's name in the engine's storage. */
  name: string;
  size_bytes: number;
  sha256: string;
  url: string;
}

export interface Pin {
  files: PinnedFile[];
  /** What the modelkit is: named in health and every score, folded into cache keys. */
  model: { id: string; calibration: string };
  license: string;
}

const MODEL_FILES: Record<string, string> = { "onnx/model.onnx": "model.onnx", "tokenizer.json": "tokenizer.json" };
/** download_modelkit.LID_URL and LID_ENTRY. */
const LID: PinnedFile = {
  name: "lid.176.ftz",
  size_bytes: 938013,
  sha256: "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83",
  url: "https://dl.fbaipublicfiles.com/fasttext/supervised-models/lid.176.ftz",
};

/** The pinned files with their download addresses. */
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
  files.push(LID);
  return files;
}

/** engine.py's MODEL_ID and CALIBRATION. */
export const MODEL_ID = "editlens_roberta-large";
export const CALIBRATION = "editlens-4bucket-cosine(0.03,0.15)";
export const BUCKET_LABELS = ["human", "lightly-edited", "heavily-edited", "ai-generated"];
export const SUPPORTED_LANGUAGES = ["en"];

export function pin(): Pin {
  return { files: pinnedFiles(), model: { id: MODEL_ID, calibration: CALIBRATION }, license: modelkit.license };
}
