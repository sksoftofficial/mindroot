import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let handleRpc;
let tools;
let db;
let open;

const EXPECTED_TOOLS = [
  "list_projects",
  "search_projects",
  "rename_project",
  "search_memories",
  "search_notes",
  "save_memory",
  "delete_memory",
  "list_notes",
  "read_note",
  "save_note",
  "update_section",
  "delete_note",
  "search_skills",
  "read_skill",
  "save_skill",
  "delete_skill",
];

before(async () => {
  process.env.MINDROOT_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mindroot-mcp-"));
  ({ handleRpc, tools } = await import("../src/mcp.js"));
  ({ open } = await import("../src/store/db.js"));
  db = open();
});

function rpc(method, params) {
  return handleRpc(db, { jsonrpc: "2.0", id: 1, method, params });
}

const call = (name, args) => rpc("tools/call", { name, arguments: args });

test("tools/list exposes exactly the expected surface", async () => {
  const res = await rpc("tools/list", {});
  assert.deepEqual(res.body.result.tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
  for (const t of res.body.result.tools) {
    assert.ok(t.description.length > 20, `${t.name} needs a description`);
  }
});

test("notifications get 202 with no body", async () => {
  const res = await handleRpc(db, { jsonrpc: "2.0", method: "notify/x" });
  assert.equal(res.status, 202);
  assert.equal(res.body, null);
});

test("unknown tool returns clean error", async () => {
  const res = await call("mindroot_nope", {});
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /unknown tool/);
});

test("search without project is a clean isError", async () => {
  const res = await call("search_memories", { query: "x" });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /project is required/);
});

test("invalid slug is rejected before any lookup", async () => {
  const res = await call("search_memories", { project: "../evil", query: "x" });
  assert.equal(res.body.result.isError, true);
  assert.match(res.body.result.content[0].text, /invalid project slug/);
});

test("unknown project is a clean error", async () => {
  const res = await call("search_memories", { project: "ghost", query: "x" });
  assert.match(res.body.result.content[0].text, /unknown project: ghost/);
});

test("rename_project moves slug, dir, and embeddings", async () => {
  const { NOTES_DIR } = await import("../src/paths.js");
  db.prepare("INSERT INTO projects (slug, created_at) VALUES ('old-name', 1)").run();
  const pid = db.prepare("SELECT id FROM projects WHERE slug='old-name'").get().id;
  db.prepare(
    "INSERT INTO memories (project_id, text, target_type, created_at, updated_at) VALUES (?, 'durable fact', 'standalone', 1, 1)",
  ).run(pid);
  const f = new Float32Array([1, 0]);
  db.prepare("INSERT INTO project_embeddings (project_id, dim, model, vec) VALUES (?, 2, 'm', ?)").run(
    pid,
    Buffer.from(f.buffer, f.byteOffset, f.byteLength),
  );
  fs.mkdirSync(path.join(NOTES_DIR, "old-name"), { recursive: true });
  fs.writeFileSync(path.join(NOTES_DIR, "old-name", "overview.md"), "# Old\n");

  const res = await call("rename_project", { project: "old-name", new_slug: "new-name" });
  const data = JSON.parse(res.body.result.content[0].text);
  assert.deepEqual(data.renamed, { from: "old-name", to: "new-name" });
  assert.equal(db.prepare("SELECT slug FROM projects WHERE id = ?").get(pid).slug, "new-name");
  assert.ok(fs.existsSync(path.join(NOTES_DIR, "new-name", "overview.md")));
  assert.ok(!fs.existsSync(path.join(NOTES_DIR, "old-name")));
  assert.equal(db.prepare("SELECT COUNT(*) n FROM project_embeddings WHERE project_id = ?").get(pid).n, 0);
  const listed = JSON.parse((await call("list_projects", {})).body.result.content[0].text);
  const row = listed.find((p) => p.slug === "new-name");
  assert.equal(row.memories, 1);
  assert.ok(!listed.some((p) => p.slug === "old-name"));

  const dup = await call("rename_project", { project: "new-name", new_slug: "new-name" });
  assert.equal(dup.body.result.isError, true);
  assert.match(dup.body.result.content[0].text, /already named/);

  const bad = await call("rename_project", { project: "new-name", new_slug: "../evil" });
  assert.equal(bad.body.result.isError, true);
  assert.match(bad.body.result.content[0].text, /invalid project slug/);
});

test("update_section appends a missing section", async () => {
  await call("save_note", {
    project: "section-upsert",
    path: "note.md",
    content: "# Note\n\n## Existing\n\nkeep me\n",
  });

  const res = await call("update_section", {
    project: "section-upsert",
    path: "note.md",
    heading_path: "Added",
    content: "new body",
  });
  assert.equal(res.body.result.isError, undefined);

  const note = JSON.parse(res.body.result.content[0].text);
  assert.equal(note.content, "# Note\n\n## Existing\n\nkeep me\n\n## Added\n\nnew body\n");
  assert.ok(note.sections.some((section) => section.path === "Added"));
});
