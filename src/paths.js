import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

export const MINDROOT_DIR = process.env.MINDROOT_DIR ?? path.join(os.homedir(), ".mindroot");
export const MODELS_DIR = path.join(MINDROOT_DIR, "models");
export const NOTES_DIR = path.join(MINDROOT_DIR, "notes");
export const DB_PATH = path.join(MINDROOT_DIR, "mindroot.db");
export const CONFIG_PATH = path.join(MINDROOT_DIR, "config.json");

export const ONNX_MODEL_ID = "onnx-community/embeddinggemma-300m-ONNX";
export const EMBED_DIM = 768;
export const DEFAULT_PORT = 7620;

export function loadConfig() {
  let raw;
  try {
    raw = fs.readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return {};
    throw err;
  }
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch {
    throw new Error(`invalid mindroot configuration at ${CONFIG_PATH}; fix or delete it before continuing`);
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error(`expected a JSON object in ${CONFIG_PATH}; fix or delete it before continuing`);
  }
  return cfg;
}

export function saveConfig(cfg) {
  fs.mkdirSync(MINDROOT_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

export function ensureConfig() {
  const cfg = loadConfig();
  const created = !cfg.apiKey;
  if (created) {
    cfg.apiKey = crypto.randomBytes(24).toString("hex");
  }
  cfg.port = cfg.port ?? DEFAULT_PORT;
  if (created || !loadConfig().port) saveConfig(cfg);
  return { cfg, created };
}
