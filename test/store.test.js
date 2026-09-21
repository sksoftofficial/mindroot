import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindroot-store-"));
  process.env.MINDROOT_DIR = dir;
});

test("open() creates the full schema and is idempotent", async () => {
  const { open } = await import("../src/store/db.js");
  const db = open();

  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
  for (const t of ["projects", "docs", "sections", "memories", "embeddings", "project_embeddings"]) {
    assert.ok(tables.includes(t), `missing table ${t}`);
  }
  assert.ok(tables.includes("memories_fts"));

  db.prepare("INSERT INTO projects (slug, created_at) VALUES ('p1', 1)").run();
  db.prepare(
    "INSERT INTO memories (project_id, text, target_type, created_at, updated_at) VALUES (1, 'fts indexed', 'standalone', 1, 1)",
  ).run();
  const hits = db.prepare("SELECT rowid FROM memories_fts WHERE memories_fts MATCH 'indexed'").all();
  assert.equal(hits.length, 1);

  db.close();
  const db2 = open();
  assert.equal(db2.prepare("SELECT COUNT(*) n FROM memories").get().n, 1);
});
