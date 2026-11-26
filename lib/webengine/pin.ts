// Local engine files, identified by release commit and SHA-256.
import { defaultRelease, type DetectorRelease } from "../detectorReleases";
import { BUCKET_LABELS, CALIBRATION, LANGUAGE_ID, SUPPORTED_LANGUAGES } from "../contract";

export interface PinnedFile {
  /** The file's name in the engine's storage. */
  name: string;
  path?: string;
  size_bytes: number;
  sha256: string;
  url: string;
  /** Other addresses of the same bytes, tried in order where `url`'s host cannot be reached
   *  (lib/webengine/download.ts). The pinned SHA-256 still decides what is kept. */
  mirrors?: string[];
}

/** download_modelkit.MIRROR_HOST: Hugging Face's repositories under the same paths, for where
 *  huggingface.co cannot be reached (mainland China, for one). */
export const MIRROR_HOST = "hf-mirror.com";

/** The model's precision: FP32 everywhere it fits, FP16 (on WebGPU only) where it does not. */
export type ModelTier = "fp32" | "fp16";

export interface Pin {
  release?: DetectorRelease;
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
/** The contract's language identifier, where the package carries it (scripts/webengine.mjs). */
export const LID = { name: LANGUAGE_ID.path, size_bytes: LANGUAGE_ID.size_bytes, sha256: LANGUAGE_ID.sha256 };
export const LID_PATH = "/vendor/engine/lid.176.ftz";

/** The files setup downloads for `tier`, with their addresses. */
export function pinnedFiles(_tier: ModelTier = "fp32", release = defaultRelease): PinnedFile[] {
  return release.files.map(f => ({...f, name: f.sha256, url: `https://huggingface.co/${release.repository}/resolve/${release.revision}/${f.path}`}));
}

export const MODEL_ID = defaultRelease.release;
export const modelId = (_tier:ModelTier = "fp32"):string => MODEL_ID;
export { BUCKET_LABELS, CALIBRATION, SUPPORTED_LANGUAGES };

/** The pin of `tier`, with lid.176.ftz at `lidUrl`: LID_PATH as the extension serves it. */
export function pin(lidUrl: string, _tier: ModelTier = "fp32", release = defaultRelease): Pin {
  return {tier:"fp32", release, files:pinnedFiles("fp32",release), lid:{...LID,url:lidUrl},
    model:{id:release.release,calibration:"anagram-detector/1"},license:""};
}
