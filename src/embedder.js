import { pipeline, env } from "@huggingface/transformers";
import { MODELS_DIR, ONNX_MODEL_ID } from "./paths.js";

let extractorPromise;

export function getEmbedder() {
  if (!extractorPromise) {
    env.cacheDir = MODELS_DIR;
    env.allowLocalModels = false;
    extractorPromise = pipeline("feature-extraction", ONNX_MODEL_ID, {
      dtype: "q8",
      // Avoid retaining large native inference buffers between requests.
      session_options: { enableCpuMemArena: false },
    });
  }
  return extractorPromise;
}

const QUERY_PREFIX = "task: search result | query: ";
const DOC_PREFIX = "title: none | text: ";

async function embed(text) {
  const extractor = await getEmbedder();
  const out = await extractor(text, { pooling: "mean", normalize: true });
  return Float32Array.from(out.data);
}

export async function embedQuery(text) {
  return embed(QUERY_PREFIX + text);
}

export async function embedDoc(text) {
  return embed(DOC_PREFIX + text.slice(0, 4000));
}
