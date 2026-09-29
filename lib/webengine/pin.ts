// lib/webengine/pin.ts — the files the in-browser engine runs on: the native installer's pin.
//
// anagramd/modelkit.json names the Hugging Face redistribution of EditLens by repository
// and commit, with the size and SHA-256 of every file; anagramd/download_modelkit.py
// fetches each as https://huggingface.co/<repository>/resolve/<revision>/<path>. The browser
// engine downloads two of them, the ONNX graph (FP32, or the modelkit's FP16 one on the few
// devices where FP32 does not fit, lib/device.ts TIERS) and the tokenizer, from there; nothing
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

/** The model's precision: FP32 everywhere it fits, FP16 (on WebGPU only) where it does not. */
export type ModelTier = "fp32" | "fp16";

export interface Pin {
  /** The precision of the model file in `files`; FP32 when absent. */
  tier?: ModelTier;
  /** The files setup downloads. */
  files: PinnedFile[];
  /** lid.176.ftz in the package: `url` is its extension URL. */
  lid: PinnedFile;
  /** What the modelkit is: named in health and every score, folded into cache keys. */
  model: { id: string; calibration: string };
  license: string;
}

/** The model file of each tier: its path in the modelkit and its name in the engine's storage. */
const MODEL_PATHS: Record<ModelTier, { path: string; name: string }> = {
  fp32: { path: "onnx/model.onnx", name: "model.onnx" },
  fp16: { path: "onnx/model_fp16.onnx", name: "model_fp16.onnx" },
};
export const modelFileName = (tier: ModelTier = "fp32"): string => MODEL_PATHS[tier].name;
/** download_modelkit.LID_ENTRY, where the package carries it (scripts/webengine.mjs LID). */
export const LID = { name: "lid.176.ftz", size_bytes: 938013, sha256: "8f3472cfe8738a7b6099e8e999c3cbfae0dcd15696aac7d7738a8039db603e83" };
export const LID_PATH = "/vendor/engine/lid.176.ftz";

/** The files setup downloads for `tier`, with their addresses. */
export function pinnedFiles(tier: ModelTier = "fp32"): PinnedFile[] {
  const names: Record<string, string> = { [MODEL_PATHS[tier].path]: MODEL_PATHS[tier].name, "tokenizer.json": "tokenizer.json" };
  const files: PinnedFile[] = [];
  for (const entry of modelkit.files) {
    const name = names[entry.path];
    if (!name) continue;
    // download_modelkit.py: quote(name, safe="/") on the path.
    const path = entry.path.split("/").map(encodeURIComponent).join("/");
    files.push({ name, size_bytes: entry.size_bytes, sha256: entry.sha256, url: `https://huggingface.co/${modelkit.repository}/resolve/${modelkit.revision}/${path}` });
  }
  if (files.length !== Object.keys(names).length) throw new Error("anagramd/modelkit.json no longer lists a file the browser engine needs");
  return files;
}

/** engine.py's MODEL_ID and CALIBRATION. The FP16 model has an id of its own, so that the
 *  two never share a cached score (cache keys are folded from the id). */
export const MODEL_ID = "editlens_roberta-large";
export const modelId = (tier: ModelTier = "fp32"): string => (tier === "fp16" ? `${MODEL_ID}-fp16` : MODEL_ID);
export const CALIBRATION = "editlens-4bucket-cosine(0.03,0.15)";
export const BUCKET_LABELS = ["human", "lightly-edited", "heavily-edited", "ai-generated"];
export const SUPPORTED_LANGUAGES = ["en"];

/** The pin of `tier`, with lid.176.ftz at `lidUrl`: LID_PATH as the extension serves it. */
export function pin(lidUrl: string, tier: ModelTier = "fp32"): Pin {
  return { tier, files: pinnedFiles(tier), lid: { ...LID, url: lidUrl }, model: { id: modelId(tier), calibration: CALIBRATION }, license: modelkit.license };
}
