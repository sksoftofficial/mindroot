import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let handleRpc;
let db;
let open;
let NOTES_DIR;

before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mindroot-conflict-"));
  process.env.MINDROOT_DIR = dir;
  ({ handleRpc } = await import("../src/mcp.js"));
  ({ open } = await import("../src/store/db.js"));
  ({ NOTES_DIR } = await import("../src/paths.js"));
  db = open();
});

const rpc = (method, params) => handleRpc(db, { jsonrpc: "2.0", id: 1, method, params });
const call = (name, args) => rpc("tools/call", { name, arguments: args });

async function callOk(name, args) {
  const res = await call(name, args);
  assert.equal(res.body.result.isError, undefined, `expected success: ${res.body.result?.content?.[0]?.text}`);
  return JSON.parse(res.body.result.content[0].text);
}

async function callErr(name, args) {
  const res = await call(name, args);
  assert.equal(res.body.result.isError, true, "expected error");
  return res.body.result.content[0].text;
}

const NOTE = "# T\n\n## A\n\na1\n  - sub\n\n## B\n\nb1\n";
const readBody = async (section) => (await callOk("read_note", { project: "p", path: "n.md", section })).content;

test("update_section replaces a section when old_content matches and preserves sub-bullets", async () => {
  await callOk("save_note", { project: "p", path: "n.md", content: NOTE });
  const old = await readBody("A");
  await callOk("update_section", {
    project: "p",
    path: "n.md",
    heading_path: "A",
    old_content: old,
    content: "- x\n  - kept sub",
  });
  assert.equal(await readBody("A"), "- x\n  - kept sub");
  assert.equal(await readBody("B"), "b1");
});

test("update_section rejects a stale old_content and leaves the note unchanged", async () => {
  const err = await callErr("update_section", {
    project: "p",
    path: "n.md",
    heading_path: "A",
    old_content: "stale body nobody wrote",
    content: "clobber",
  });
  assert.match(err, /conflict.*changed since read/);
  assert.equal(await readBody("A"), "- x\n  - kept sub");
});

test("update_section without old_content is rejected", async () => {
  const err = await callErr("update_section", {
    project: "p",
    path: "n.md",
    heading_path: "A",
    content: "clobber",
  });
  assert.match(err, /old_content required/);
});

test("stale-snapshot updates to different sections both land (the lost-update fix)", async () => {
  await callOk("save_note", { project: "p", path: "race.md", content: "# R\n\n## A\n\na1\n\n## B\n\nb1\n" });
  // Both writers read the SAME initial state, then both write — as a parallel
  // tool batch would. Old code: last writer rewrote the whole file from its
  // stale snapshot and silently reverted the other's section. New code: each
  // write re-reads fresh and only touches its own section.
  const [oldA, oldB] = [await readBodyOf("race.md", "A"), await readBodyOf("race.md", "B")];
  await Promise.all([
    callOk("update_section", { project: "p", path: "race.md", heading_path: "A", old_content: oldA, content: "a2" }),
    callOk("update_section", { project: "p", path: "race.md", heading_path: "B", old_content: oldB, content: "b2" }),
  ]);
  const after = await callOk("read_note", { project: "p", path: "race.md" });
  assert.match(after.content, /a2/);
  assert.match(after.content, /b2/);
});

async function readBodyOf(file, section) {
  return (await callOk("read_note", { project: "p", path: file, section })).content;
}

test("truly conflicting parallel updates: one lands, one is rejected", async () => {
  await callOk("save_note", { project: "p", path: "conf.md", content: "# C\n\n## A\n\na1\n" });
  const old = await readBodyOf("conf.md", "A");
  const results = await Promise.allSettled([
    call("update_section", { project: "p", path: "conf.md", heading_path: "A", old_content: old, content: "first" }),
    call("update_section", { project: "p", path: "conf.md", heading_path: "A", old_content: old, content: "second" }),
  ]);
  const errors = results.filter((r) => r.status === "fulfilled" && r.value.body.result.isError).length;
  assert.equal(errors, 1, "exactly one of the two conflicting writes must be rejected");
  const after = await readBodyOf("conf.md", "A");
  assert.ok(after === "first" || after === "second", `unexpected body: ${after}`);
});

test("save_note overwrite requires old_content and rejects stale content", async () => {
  const full = await callOk("read_note", { project: "p", path: "n.md" });
  const err = await callErr("save_note", { project: "p", path: "n.md", content: "replaced" });
  assert.match(err, /old_content required/);
  const stale = await callErr("save_note", { project: "p", path: "n.md", content: "replaced", old_content: full.content + " drifted" });
  assert.match(stale, /conflict.*changed since read/);
  await callOk("save_note", { project: "p", path: "n.md", content: full.content, old_content: full.content });
  assert.equal((await callOk("read_note", { project: "p", path: "n.md" })).content, full.content);
});

test("save_note create works without old_content but rejects old_content for a new note", async () => {
  await callOk("save_note", { project: "p", path: "fresh.md", content: "# F\n" });
  const err = await callErr("save_note", { project: "p", path: "other.md", content: "# X\n", old_content: "# old\n" });
  assert.match(err, /does not exist yet/);
});

test("update_section append requires old_content: \"\" and rejects a non-empty mismatch", async () => {
  await callOk("update_section", { project: "p", path: "fresh.md", heading_path: "New", old_content: "", content: "brand" });
  assert.equal(await readBodyOf("fresh.md", "New"), "brand");
  const err = await callErr("update_section", { project: "p", path: "fresh.md", heading_path: "Gone", old_content: "expected body", content: "x" });
  assert.match(err, /section not found: Gone/);
});

test("a failed conflict write leaves the file byte-identical on disk", async () => {
  const before = fs.readFileSync(path.join(NOTES_DIR, "p", "fresh.md"), "utf8");
  await callErr("update_section", {
    project: "p",
    path: "fresh.md",
    heading_path: "New",
    old_content: "wrong",
    content: "nope",
  });
  assert.equal(fs.readFileSync(path.join(NOTES_DIR, "p", "fresh.md"), "utf8"), before);
});
