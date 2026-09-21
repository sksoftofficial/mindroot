import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let core, ensureSchema, rankSkills, handleRpc, createServer, dir;
const vector = async () => new Float32Array([1, 0]);
const content = "## Procedure\n\n1. Follow the project's API conventions.\n";
const description = "Add an API endpoint following router conventions";

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindroot-skills-"));
  process.env.MINDROOT_DIR = dir;
  core = await import("../src/core.js");
  ({ ensureSchema } = await import("../src/store/db.js"));
  ({ rankSkills } = await import("../src/search.js"));
  ({ handleRpc } = await import("../src/mcp.js"));
  ({ createServer } = await import("../src/server.js"));
});

after(() => fs.rmSync(dir, { recursive: true, force: true }));

function database(t) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);
  t.after(() => db.close());
  return db;
}

function save(db, project = "alpha", name = "add-api-route", desc = description, body = content, expected, embed = vector) {
  return core.saveSkill(db, project, name, desc, body, expected, embed);
}

function call(db, name, args) {
  return handleRpc(db, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
}

test("skill saves auto-create projects, index summaries, and preserve revisions without extra memories", async (t) => {
  const db = database(t);
  let embedded;
  const first = await save(db, "alpha", "add-api-route", description, content, 0, async (text) => {
    embedded = text;
    return vector();
  });
  assert.equal(first.revision, 1);
  assert.equal(embedded, `add-api-route\n${description}`);
  assert.equal(first.content, undefined);
  assert.equal(core.readSkill(db, "alpha", first.name).content, content);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memories").get().n, 0);
  const id = db.prepare("SELECT id FROM skills").get().id;

  const unchanged = await save(db, "alpha", first.name, description, content, 1, () => {
    throw new Error("identical content should not be embedded");
  });
  assert.equal(unchanged.unchanged, true);
  assert.equal(unchanged.revision, 1);

  const updated = await save(db, "alpha", first.name, "Publish release tags", "## Procedure\nPublish a tag.", 1);
  assert.equal(updated.revision, 2);
  assert.equal(updated.created_at, first.created_at);
  assert.equal(db.prepare("SELECT id FROM skills").get().id, id);
  assert.equal(core.readSkill(db, "alpha", first.name, 1).content, content);
  assert.equal(core.readSkill(db, "alpha", first.name, 1).current_revision, 2);
  assert.equal(core.readSkill(db, "alpha", first.name, 2).description, "Publish release tags");
  assert.equal(db.prepare("SELECT COUNT(*) n FROM skills_fts WHERE skills_fts MATCH 'endpoint'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM skills_fts WHERE skills_fts MATCH 'release'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM skill_embeddings").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM skill_revisions").get().n, 2);
  assert.equal((await core.listProjects(db))[0].skills, 1);
  assert.equal(core.listSkills(db, "alpha")[0].content, undefined);
});

test("invalid input and stale revisions fail before embedding or writing", async (t) => {
  const db = database(t);
  const cases = [
    [undefined, "valid", description, content],
    ["../escape", "valid", description, content],
    ["alpha", "../escape", description, content],
    ["alpha", "UpperCase", description, content],
    ["alpha", "valid", " ", content],
    ["alpha", "valid", "a".repeat(2001), content],
    ["alpha", "valid", description, 42],
    ["alpha", "valid", description, " "],
    ["alpha", "valid", description, content, -1],
    ["alpha", "valid", description, content, "1"],
  ];
  for (const [project, name, desc, body, expected] of cases) {
    await assert.rejects(core.saveSkill(db, project, name, desc, body, expected, vector), { status: 400 });
  }
  assert.equal(db.prepare("SELECT COUNT(*) n FROM projects").get().n, 0);
  await save(db);
  await assert.rejects(save(db, "alpha", "add-api-route", description, content, 0), { status: 409 });
  await assert.rejects(save(db, "alpha", "add-api-route", description, content, 2), { status: 409 });
  assert.throws(() => core.readSkill(db, "alpha", "add-api-route", 0), { status: 400 });
  assert.throws(() => core.readSkill(db, "alpha", "add-api-route", 20), { status: 404 });
  await assert.rejects(core.searchSkills(db, "alpha", null), { status: 400 });
});

test("embedding and database failures leave no partial skill, history, index, or project", async (t) => {
  const db = database(t);
  await assert.rejects(save(db, "alpha", "add-api-route", description, content, 0, async () => {
    throw new Error("model unavailable");
  }), /model unavailable/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM projects").get().n, 0);

  db.exec(`CREATE TRIGGER reject_skill_embedding BEFORE INSERT ON skill_embeddings
           BEGIN SELECT RAISE(ABORT, 'embedding write failed'); END;`);
  await assert.rejects(save(db), /embedding write failed/);
  for (const table of ["projects", "skills", "skill_revisions", "skill_embeddings", "skills_fts"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  }
  db.exec("DROP TRIGGER reject_skill_embedding");
  await save(db);
  db.exec(`CREATE TRIGGER reject_revision BEFORE INSERT ON skill_revisions
           BEGIN SELECT RAISE(ABORT, 'revision write failed'); END;`);
  await assert.rejects(save(db, "alpha", "add-api-route", "Changed summary", "Changed content", 1), /revision write failed/);
  assert.equal(core.readSkill(db, "alpha", "add-api-route").revision, 1);
  assert.equal(core.readSkill(db, "alpha", "add-api-route").content, content);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM skills_fts WHERE skills_fts MATCH 'endpoint'").get().n, 1);
});

test("concurrent writers cannot silently overwrite a skill, even without expected_revision", async (t) => {
  const db = database(t);
  await save(db);
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const slow = save(db, "alpha", "add-api-route", "Slow writer", "Slow content", undefined, async () => {
    await waiting;
    return vector();
  });
  await save(db, "alpha", "add-api-route", "Fast writer", "Fast content", 1);
  release();
  await assert.rejects(slow, { status: 409 });
  assert.equal(core.readSkill(db, "alpha", "add-api-route").content, "Fast content");
  assert.equal(core.readSkill(db, "alpha", "add-api-route").revision, 2);
});

test("search blends semantics and keywords, scopes before limiting, and returns no procedure", async (t) => {
  const db = database(t);
  await save(db, "alpha", "release", "Publish release tags", content);
  await save(db, "alpha", "cooking", "Boil pasta", "body-only-keyword", undefined, async () => new Float32Array([0, 1]));
  // More than the FTS limit of matching skills in another project must not crowd out alpha.
  for (let i = 0; i < 105; i++) await save(db, "beta", `release-${i}`, "Publish release tags", "Other project");
  const pid = db.prepare("SELECT id FROM projects WHERE slug = 'alpha'").get().id;
  const hits = rankSkills(db, pid, new Float32Array([1, 0]), "release tags", 1);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].name, "release");
  assert.equal(hits[0].kind, "skill");
  assert.ok(hits[0].score > 0.75);
  assert.equal(hits[0].content, undefined);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM skills_fts WHERE skills_fts MATCH 'body'").get().n, 0);
  assert.equal(rankSkills(db, pid, new Float32Array([1, 0]), "release tags", 8).length, 2);
  assert.doesNotThrow(() => rankSkills(db, pid, new Float32Array([1, 0, 0]), '" OR *', 8));
});

test("same names are project-specific; rename preserves skills and deletion cascades", async (t) => {
  const db = database(t);
  await save(db);
  await save(db, "beta", "add-api-route", description, "Beta instructions");
  await core.renameProject(db, "alpha", "renamed");
  assert.equal(core.readSkill(db, "renamed", "add-api-route", 1).content, content);
  assert.equal(core.readSkill(db, "beta", "add-api-route").content, "Beta instructions");
  assert.throws(() => core.readSkill(db, "alpha", "add-api-route"), { status: 404 });
  core.deleteSkill(db, "renamed", "add-api-route");
  assert.throws(() => core.deleteSkill(db, "renamed", "add-api-route"), { status: 404 });
  assert.deepEqual(await core.searchSkills(db, "renamed", "add API route"), []);
  for (const table of ["skills", "skill_revisions", "skill_embeddings", "skills_fts"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 1);
  }
  await core.deleteProject(db, "beta");
  for (const table of ["skills", "skill_revisions", "skill_embeddings", "skills_fts"]) {
    assert.equal(db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n, 0);
  }
});

test("schema additions preserve existing memory data and survive reopen", async (t) => {
  const filename = path.join(dir, "upgrade.db");
  let db = new DatabaseSync(filename);
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  ensureSchema(db);
  // Recreate the pre-skills schema without changing the existing note/memory tables.
  db.exec("DROP TABLE skill_embeddings; DROP TABLE skill_revisions; DROP TABLE skills; DROP TABLE skills_fts;");
  db.exec("INSERT INTO projects (slug, created_at) VALUES ('legacy', 1)");
  db.exec("INSERT INTO memories (project_id, text, target_type, created_at, updated_at) VALUES (1, 'existing fact', 'standalone', 1, 1)");
  ensureSchema(db);
  ensureSchema(db);
  await save(db, "legacy");
  db.close();
  db = new DatabaseSync(filename);
  ensureSchema(db);
  assert.equal(core.readSkill(db, "legacy", "add-api-route", 1).content, content);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM memories_fts WHERE memories_fts MATCH 'existing'").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM skill_embeddings").get().n, 1);
});

test("MCP dispatches skill reads, updates, conflicts, validation, search, and deletion", async (t) => {
  const db = database(t);
  await save(db);
  const read = await call(db, "read_skill", { project: "alpha", name: "add-api-route", revision: 1 });
  assert.equal(JSON.parse(read.body.result.content[0].text).content, content);
  const update = await call(db, "save_skill", { project: "alpha", name: "add-api-route", description, content, expected_revision: 1 });
  assert.equal(JSON.parse(update.body.result.content[0].text).unchanged, true);
  const stale = await call(db, "save_skill", { project: "alpha", name: "add-api-route", description, content, expected_revision: 0 });
  assert.equal(stale.body.result.isError, true);
  assert.match(stale.body.result.content[0].text, /skill changed/);
  for (const name of ["search_skills", "read_skill", "save_skill", "delete_skill"]) {
    const invalid = await call(db, name, {});
    assert.equal(invalid.body.result.isError, true);
    assert.match(invalid.body.result.content[0].text, /project is required/);
  }
  const deleted = await call(db, "delete_skill", { project: "alpha", name: "add-api-route" });
  assert.equal(JSON.parse(deleted.body.result.content[0].text).deleted, "add-api-route");
  const empty = await call(db, "search_skills", { project: "alpha", query: "API route" });
  assert.deepEqual(JSON.parse(empty.body.result.content[0].text), []);
});

test("REST exposes authenticated skill summaries, content, conflicts, search, and deletion", async (t) => {
  const db = database(t);
  await save(db);
  const server = createServer(db, { port: 0, apiKey: "test-key" });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { Authorization: "Bearer test-key", "Content-Type": "application/json" };
  const route = "/api/projects/alpha/skills/add-api-route";
  assert.equal((await fetch(base + route)).status, 401);
  const listed = await fetch(base + "/api/projects/alpha/skills", { headers });
  assert.equal((await listed.json())[0].content, undefined);
  const read = await fetch(base + route + "?revision=1", { headers });
  assert.equal((await read.json()).content, content);
  assert.equal((await fetch(base + route + "?revision=0", { headers })).status, 400);
  const saved = await fetch(base + route, {
    method: "PUT", headers, body: JSON.stringify({ description, content, expected_revision: 1 }),
  });
  assert.equal((await saved.json()).unchanged, true);
  const conflict = await fetch(base + route, {
    method: "PUT", headers, body: JSON.stringify({ description, content, expected_revision: 0 }),
  });
  assert.equal(conflict.status, 409);
  assert.equal((await fetch(base + route, { method: "DELETE", headers })).status, 200);
  const empty = await fetch(base + "/api/search", {
    method: "POST", headers, body: JSON.stringify({ project: "alpha", query: "API route", kind: "skills" }),
  });
  assert.deepEqual(await empty.json(), []);
  assert.equal((await fetch(base + route, { headers })).status, 404);
});
