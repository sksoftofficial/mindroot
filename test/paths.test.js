import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let dir;
let paths;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "mindroot-paths-"));
  process.env.MINDROOT_DIR = dir;
  paths = await import("../src/paths.js");
});
afterEach(async () => {
  delete process.env.MINDROOT_DIR;
  await fs.rm(dir, { recursive: true, force: true });
});

test("ensureConfig generates the key once and keeps it stable across runs", async () => {
  const first = paths.ensureConfig();
  assert.equal(first.created, true);
  assert.ok(first.cfg.apiKey);
  const second = paths.ensureConfig();
  assert.equal(second.created, false);
  assert.equal(second.cfg.apiKey, first.cfg.apiKey);
  assert.equal(second.cfg.port, paths.DEFAULT_PORT);
  if (process.platform !== "win32") {
    assert.equal((await fs.stat(path.join(dir, "config.json"))).mode & 0o777, 0o600);
  }
});

test("ensureConfig keeps a stored key and port", async () => {
  await fs.writeFile(path.join(dir, "config.json"), JSON.stringify({ apiKey: "keep-me", port: 9999 }));
  const { cfg, created } = paths.ensureConfig();
  assert.equal(created, false);
  assert.equal(cfg.apiKey, "keep-me");
  assert.equal(cfg.port, 9999);
});

test("missing config reads as empty without creating one", () => {
  const { cfg, created } = paths.ensureConfig();
  assert.equal(created, true);
  assert.ok(cfg.apiKey);
});

test("corrupt or non-object configs fail loudly instead of rotating the key", async () => {
  const configPath = path.join(dir, "config.json");
  for (const content of ['{ broken', "", "[]", '"x"']) {
    await fs.writeFile(configPath, content);
    assert.throws(() => paths.ensureConfig(), /invalid mindroot configuration|expected a JSON object/);
    assert.equal(await fs.readFile(configPath, "utf8"), content);
  }
});
