import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let open;

function vec(arr) {
  const f = new Float32Array(arr);
  return Buffer.from(f.buffer, f.byteOffset, f.byteLength);
}

async function freshDb(name) {
  process.env.MINDROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mindroot-search-"));
  ({ open } = await import("../src/store/db.js"));
  return open();
}

before(freshDb);

test("rankMemories blends vector and keyword scores, respects limit", async () => {
  const { rankMemories } = await import("../src/search.js");
  const db = open();
  db.prepare("INSERT INTO projects (slug, created_at) VALUES ('p1', 1)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='p1'").get().id;

  const ins = db.prepare(
    "INSERT INTO memories (project_id, text, target_type, created_at, updated_at) VALUES (?, ?, 'standalone', 1, 1)",
  );
  const m1 = Number(ins.run(pid, "deploy by tag push to production").lastInsertRowid);
  const m2 = Number(ins.run(pid, "unrelated note about cooking pasta").lastInsertRowid);
  const emb = db.prepare(
    "INSERT INTO embeddings (owner_type, owner_id, dim, model, vec) VALUES ('memory', ?, ?, 'm', ?)",
  );
  emb.run(m1, 2, vec([1, 0]));
  emb.run(m2, 2, vec([0, 1]));

  // query vector aligned with m1; keywords also match m1
  const hits = rankMemories(db, pid, new Float32Array([1, 0]), "deploy production", 8);
  assert.equal(hits[0].id, m1);
  assert.ok(hits[0].score > 0.75);
  assert.equal(hits.length, 2);

  assert.equal(rankMemories(db, pid, new Float32Array([1, 0]), "x", 1).length, 1);

  // embeddings with wrong dim are skipped, not crashed on
  emb.run(Number(ins.run(pid, "dim mismatch").lastInsertRowid), 3, vec([1, 0, 0]));
  assert.equal(rankMemories(db, pid, new Float32Array([1, 0]), "x", 10).some((h) => h.text === "dim mismatch"), false);
});

test("rankNotes literal-matches sections scoped to the project", async () => {
  const { rankNotes } = await import("../src/search.js");
  const db = open();
  db.prepare("INSERT INTO projects (slug, created_at) VALUES ('p2', 2)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='p2'").get().id;
  db.prepare(
    "INSERT INTO docs (project_id, rel_path, title, content_hash, mtime, indexed_at) VALUES (?, 'a.md', 'A', NULL, 1, 1)",
  ).run(pid);
  const docId = db.prepare("SELECT id FROM docs").get().id;
  db.prepare(
    "INSERT INTO sections (doc_id, heading_path, content, updated_at) VALUES (?, 'Deploy', 'tag push deploys', 1)",
  ).run(docId);
  db.prepare(
    "INSERT INTO sections (doc_id, heading_path, content, updated_at) VALUES (?, 'Cooking', 'boil pasta water', 1)",
  ).run(docId);
  // unrelated project section must not leak in
  db.prepare("INSERT INTO projects (slug, created_at) VALUES ('p3', 3)").run();
  const pid3 = db.prepare("SELECT id FROM projects WHERE slug='p3'").get().id;
  const doc3 = Number(
    db.prepare("INSERT INTO docs (project_id, rel_path, title, content_hash, mtime, indexed_at) VALUES (?, 'b.md', 'B', NULL, 1, 1)").run(pid3).lastInsertRowid,
  );
  db.prepare(
    "INSERT INTO sections (doc_id, heading_path, content, updated_at) VALUES (?, 'Deploy', 'tag push deploys', 1)",
  ).run(doc3);

  const hits = rankNotes(db, pid, "deploy", 8);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].kind, "note_section");
  assert.equal(hits[0].target, "a.md::Deploy");

  // heading matches outrank body-only matches
  db.prepare(
    "INSERT INTO sections (doc_id, heading_path, content, updated_at) VALUES (?, 'Releases', 'unrelated body mentioning deploy word', 1)",
  ).run(docId);
  const ranked = rankNotes(db, pid, "deploy", 8);
  assert.equal(ranked[0].target, "a.md::Deploy");

  // no terms -> no results
  assert.equal(rankNotes(db, pid, "   ", 8).length, 0);
});

test("rankProjects applies token-overlap bonus and threshold", async () => {
  const { rankProjects } = await import("../src/search.js");
  const db = open();
  db.prepare("INSERT INTO projects (slug, created_at) VALUES ('proper-agent-memory', 3)").run();
  db.prepare("INSERT INTO projects (slug, created_at) VALUES ('zzz', 3)").run();

  const hits = rankProjects(db, new Float32Array([1, 0]), "mem-agent-mcp");
  const top = hits.find((h) => h.project === "proper-agent-memory");
  assert.ok(top, "fuzzy name should match");
  assert.ok(Math.abs(top.score - (0.55 + 0.4 * (2 / 3))) < 1e-9);

  // no token overlap + no vector => excluded
  assert.equal(hits.some((h) => h.project === "zzz"), false);
});
