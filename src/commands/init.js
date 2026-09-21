import { mkdir } from "node:fs/promises";
import { MINDROOT_DIR, MODELS_DIR, NOTES_DIR, ensureConfig } from "../paths.js";
import { open } from "../store/db.js";
import { getEmbedder } from "../embedder.js";

export async function init() {
  await mkdir(MODELS_DIR, { recursive: true });
  await mkdir(NOTES_DIR, { recursive: true });

  const db = open();
  db.close();

  const { cfg, created } = ensureConfig();

  console.log(`initializing memory store at ${MINDROOT_DIR}`);
  console.log("fetching embedding model (embeddinggemma-300m ONNX q8)...");
  await getEmbedder();
  console.log("model cached");

  if (created) {
    console.log(`\nAPI key generated and stored in ${MINDROOT_DIR}/config.json\n`);
  } else {
    console.log(`memory store ready at ${MINDROOT_DIR}`);
  }
}
